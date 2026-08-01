---
title: Upgrade to revm-wasm 0.2.0 and stop lying about the block environment
slug: revm-wasm-0-2-0-honest-block-environment
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

`revm-wasm@0.2.0` shipped the three options this repo asked for after `revm-engine-subpath` had to work around their absence. Take them, and delete the workaround.

The workaround, recorded in `work/notes/observations/decisions-revm-engine-subpath-2026-08-01.md` decision 1: every revm read is executed with `baseFeePerGas: 0n`, because `Revm#call` validated the gas price against the block's base fee and the caller's balance against `gasLimit * gasPrice`, and an `eth_call` defaults `from` to the zero address. A zero base fee with a zero gas price was the only way to get simulation semantics from outside. The cost is that a contract reading `block.basefee` in a view function sees `0` on revm and the node's real value on `@ethereumjs/evm`. `revm-wasm`'s own 0.2.0 docs call this out: the flags exist "so that a zero-gas-price read no longer has to be paid for with a zero base fee, which is a lie a contract can observe."

`0.2.0` adds `disableBaseFee`, `disableBalanceCheck`, `disableBlockGasLimit` on `ExecuteOptions`, and `prevRandao` on `BlockEnv`. So: pass the node's REAL base fee and disable the checks instead, and wire `prevRandao` through, which closes the second known divergence (decision 2 of the same record: `PREVRANDAO` was unreachable and always read zero).

This is worth doing BEFORE the first release that carries the engine. Nobody depends on the current behaviour yet, so fixing it now means the divergence never ships; releasing first means changing an observable behaviour for early adopters afterwards.

## Acceptance criteria

- [ ] `revm-wasm` is at `^0.2.0` in `packages/embedded-eth-node` and `packages/benchmarks`, and the lockfile is updated.
- [ ] A revm read is executed with the node's REAL `baseFeePerGas`, with `disableBaseFee` and `disableBalanceCheck` set, rather than with a zeroed base fee.
- [ ] `BASEFEE` inside an `eth_call` returns the SAME value on the revm engine and on the default engine. Asserted, since this is the divergence the task exists to remove.
- [ ] An `eth_call` from an address holding no ether still works on the revm engine (that is what the zeroed base fee was buying, and it must not regress).
- [ ] `PREVRANDAO` is wired from the node's block environment and agrees across both engines.
- [ ] The conformance differential grows a block-environment step, so `BASEFEE` / `PREVRANDAO` / `COINBASE` / `NUMBER` / `TIMESTAMP` read through an actual contract are diffed between engines. The gate could never have caught these: gas is identical either way. (Raised by the Gate-2 review of `revm-engine-under-conformance-and-gate`.)
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] The README's engine section and the decisions record no longer describe the zero-base-fee behaviour as current.
- [ ] Consider `disableBlockGasLimit` for the gas-limit mapping (decision 3 of the same record), or record why it is not wanted.
- [ ] A changeset, since this changes observable behaviour of the revm engine.

## Blocked by

- None. Nothing else touches these files, and it should land before the first release carrying the engine.

## Prompt

> Goal: take the three `revm-wasm@0.2.0` options that exist because we asked for them, and delete the workaround they replace.
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
> One thing 0.2.0 does NOT solve, so do not chase it here: EIP-3607 (`RejectCallerWithCode`) still has no opt-out, so an `eth_call` with `from` set to a CONTRACT address may behave differently between the engines. It is captured separately in `work/tasks/backlog/eth-call-from-a-contract-address-eip-3607.md`.
>
> Done means: the node passes its real block environment to revm, a contract reading `block.basefee` gets the same answer from either engine, and the README no longer documents a divergence that no longer exists.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
