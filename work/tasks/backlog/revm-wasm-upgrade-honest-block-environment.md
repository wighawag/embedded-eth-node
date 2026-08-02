---
title: Upgrade to revm-wasm 0.3.0 and remove every known engine divergence
slug: revm-wasm-upgrade-honest-block-environment
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
needsAnswers: false
---

## What to build

`revm-wasm@0.3.0` now carries every switch this repo asked for after `revm-engine-subpath` had to work around their absence. Take them all, and delete the workarounds. This closes EVERY known behavioural divergence between the revm engine and the default `@ethereumjs/evm` engine in one change.

The workaround, recorded in `work/notes/observations/decisions-revm-engine-subpath-2026-08-01.md` decision 1: every revm read is executed with `baseFeePerGas: 0n`, because `Revm#call` validated the gas price against the block's base fee and the caller's balance against `gasLimit * gasPrice`, and an `eth_call` defaults `from` to the zero address. A zero base fee with a zero gas price was the only way to get simulation semantics from outside. The cost is that a contract reading `block.basefee` in a view function sees `0` on revm and the node's real value on `@ethereumjs/evm`. `revm-wasm`'s own 0.2.0 docs call this out: the flags exist "so that a zero-gas-price read no longer has to be paid for with a zero base fee, which is a lie a contract can observe."

`0.2.0` added `disableBaseFee`, `disableBalanceCheck` and `disableBlockGasLimit` on `ExecuteOptions` plus `prevRandao` on `BlockEnv`; `0.3.0` added `disableEip3607`. So: pass the node's REAL base fee and disable the checks instead, wire `prevRandao` through (decision 2 of the same record: `PREVRANDAO` was unreachable and always read zero), and set `disableEip3607` so an `eth_call` from a CONTRACT address works, which it does not today.

That last one is verified, not assumed. Probed against `0.3.0` (revm 42.0.1): a `call()` from an account holding code returns `status: 'validation-error'` carrying `Transaction(RejectCallerWithCode)` by default, and with `disableEip3607: true` returns `success` with 21018 gas and the same return data as the identical call from an EOA. `@ethereumjs/evm`'s `runCall` never enforced EIP-3607 at all (ethereumjs enforces it in `runTx`, `runTx.js:528`), so today the same `eth_call` succeeds on the default engine and fails on revm. Simulating from a contract address is ordinary practice: smart-account and ERC-4337 flows, multicall aggregators, any UI previewing what one contract sees when called by another.

One constraint the package states explicitly and the WRITE half will need: the simulation switches may NOT be combined with committing, because a committed transaction from a contract address is one the chain would reject. They belong to `call()` and to `transact({commit: false})`, never to a committing path. Do not reach for them in `revm-engine-behind-runtx`.

This is worth doing BEFORE the first release that carries the engine. Nobody depends on the current behaviour yet, so fixing it now means the divergence never ships; releasing first means changing an observable behaviour for early adopters afterwards.

## Acceptance criteria

- [ ] `revm-wasm` is at `^0.3.0` in `packages/embedded-eth-node` and `packages/benchmarks`, and the lockfile is updated.
- [ ] A revm read is executed with the node's REAL `baseFeePerGas`, with `disableBaseFee` and `disableBalanceCheck` set, rather than with a zeroed base fee.
- [ ] `BASEFEE` inside an `eth_call` returns the SAME value on the revm engine and on the default engine. Asserted, since this is the divergence the task exists to remove.
- [ ] An `eth_call` from an address holding no ether still works on the revm engine (that is what the zeroed base fee was buying, and it must not regress).
- [ ] `PREVRANDAO` is wired from the node's block environment and agrees across both engines.
- [ ] `eth_call` with `from` set to a CONTRACT address SUCCEEDS on the revm engine and returns the same result and gas as the default engine, via `disableEip3607`. Asserted, with a contract caller and an EOA caller in the same test.
- [ ] The conformance differential grows a block-environment step, so `BASEFEE` / `PREVRANDAO` / `COINBASE` / `NUMBER` / `TIMESTAMP` read through an actual contract are diffed between engines. The gate could never have caught these: gas is identical either way. (Raised by the Gate-2 review of `revm-engine-under-conformance-and-gate`.)
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] The README's engine section and the decisions record no longer describe the zero-base-fee behaviour as current.
- [ ] Consider `disableBlockGasLimit` for the gas-limit mapping (decision 3 of the same record), or record why it is not wanted.
- [ ] A changeset, since this changes observable behaviour of the revm engine.

## Blocked by

- None. Nothing else touches these files, and it should land before the first release carrying the engine.

## Prompt

> Goal: take the four `revm-wasm` simulation switches that exist because we asked for them, and delete every workaround they replace. After this task there should be NO known behavioural difference between the two engines.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): read `docs/adr/0005` and `docs/adr/0006`, the decisions record `work/notes/observations/decisions-revm-engine-subpath-2026-08-01.md`, and the shipped `src/revm.ts`. If the engine no longer forces a zero base fee, this task is already done and should be closed rather than re-applied.
>
> Read `CONTEXT.md` for *engine* and *conformance differential*.
>
> WHY THIS IS NOT COSMETIC. The gas gate cannot see this class of bug: `BASEFEE` is fee-independent, so both engines charge identical gas while returning different values to the contract. The only thing that catches it is a differential that actually READS block-environment opcodes through a contract, which is why this task adds one rather than trusting the existing bars. Treat the new conformance step as the deliverable, not the flag flip.
>
> The API you are moving to, verified against the published `0.2.0` types: `ExecuteOptions` gains `disableBaseFee`, `disableBalanceCheck` and `disableBlockGasLimit`; `BlockEnv` gains `prevRandao`. `OUTCOME_FORMAT_VERSION` is still 3, so nothing about decoding moves. Keep consuming the package's typed results; do not hand-roll anything.
>
> KEEP THE PROPERTY THE WORKAROUND WAS BUYING. The reason the base fee was zeroed is that `eth_call` defaults `from` to the zero address, which holds no ether, and a real base fee then fails validation. Both are simulation concerns, so `disableBaseFee` plus `disableBalanceCheck` should replace it exactly. Prove it with a test that calls from a funded address AND an unfunded one.
>
> Do NOT use the simulation switches on any committing path. The package is explicit: a committed transaction from a contract address is one the chain would reject, so combining them with `commit` breaks the cross-engine equivalence the gas gate exists to protect. `call()` and `transact({commit: false})` only.
>
> Done means: the node passes its real block environment to revm, a contract reading `block.basefee` gets the same answer from either engine, and the README no longer documents a divergence that no longer exists.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.

## Applied answers 2026-08-02

### q1: 'task:revm-wasm-upgrade-honest-block-environment' was bounced — how should we proceed?

GUARD THE READ PATH. Do not accept the divergence, and do not merely document it.

The Gate-2 finding is correct and I have confirmed it independently: `revm-wasm@0.3.0`'s own `dist/types.d.ts` says `disableBalanceCheck` "raises the caller's post-deduction balance to at least `value`", and the read path forwards `value` verbatim (`node.ts` evmCall -> `revm.ts` `common.value = request.value`). So a value-bearing `eth_call` from a sender that cannot afford it now succeeds on revm while `@ethereumjs/evm` still fails it.

Why "accept and record" is the WRONG branch of your question. This task's headline promise is that it "closes EVERY known behavioural divergence" and that afterwards "there should be NO known behavioural difference between the two engines". Accepting a brand-new divergence introduced BY that change contradicts the deliverable. It also repeats precisely the sin the task exists to delete: the zeroed base fee was rejected because it is "a lie a contract can observe", and fabricating the caller's balance is the same class of lie. And the default engine is the correct reference here, not revm: geth's `eth_call` skips the account and gas-fee checks but still fails the value transfer itself with `ErrInsufficientBalance`, so `@ethereumjs/evm`'s behaviour matches real clients and revm is the engine that must be brought back into line.

THE INVARIANT TO RESTORE: a read carrying `value` must SUCCEED or FAIL identically on both engines, for a funded sender and an unfunded one alike.

THE LIKELY FIX, but verify it by probing revm rather than trusting this note. The read sets no `gasPrice`, so it is 0, and with `disableBaseFee` the balance revm demands reduces to exactly `value`. That means the zero-value case which justified the flag (an `eth_call` defaults `from` to the zero address, which holds no ether) ALREADY passes with the flag OFF, and the flag is load-bearing only in the `value > 0` case that is exactly the one which must fail. Probe it directly, then scope the flag to what it genuinely buys: dropping `disableBalanceCheck` entirely, or setting it only when `request.value === 0n`, both look correct if the probe agrees. Do NOT pre-fund the caller: that invents state a read must not invent. If the probe CONTRADICTS this analysis (for instance revm still demands funds at a zero gas price), keep the flag where it is genuinely needed, constrain the value path instead, and record what you actually measured.

PROVE IT IN A TEST, because nothing currently catches this: no battery step or engine test calls with a value. Add a cross-engine assertion covering value-bearing reads from BOTH a funded and an unfunded sender, so the differential owns this the way it now owns the block environment.

KEEP EVERYTHING ELSE. The rest of the branch is correct and reviewed: the block-environment conformance step, `BlockEnvProbe.sol`, the `prevRandao` wiring, the real base fee, and `disableBaseFee` / `disableBlockGasLimit` / `disableEip3607` all stay as they are. Continue from the existing `work/task-revm-wasm-upgrade-honest-block-environment` branch; this is a scoped fix on top of good work, not a restart.

CONSTRAINTS THAT STILL BIND. The criterion "an `eth_call` from an address holding no ether still works" must not regress. Reference gas is unchanged and must stay so: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`. Update the README caveats and the decisions record if the final shape of the flag differs from what they now describe. If the bundle-size assertion in `packages/benchmarks/test/evm.spec.ts` fires, follow its failure message: re-pin the baseline in the SAME change and say why in the comment block above it; never raise it silently.
