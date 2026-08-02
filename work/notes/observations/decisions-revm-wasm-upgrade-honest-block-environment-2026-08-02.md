---
title: Decisions taken while building 'revm-wasm-upgrade-honest-block-environment'
date: 2026-08-02
status: open
decisionsFor: revm-wasm-upgrade-honest-block-environment
---

# Decisions taken while building `revm-wasm-upgrade-honest-block-environment`

The done record's `## Decisions` block, kept here because the task body is moved byte-identical by the runner. Each entry: what was chosen, why, what was rejected, and what it touches. Ratify or reverse.

Context: this change moves the revm read engine to `revm-wasm@0.3.0`, passes the node's REAL block environment (base fee + prevRandao), and turns on the four simulation switches instead. It supersedes decisions 1, 2 and (partly) 3 of `decisions-revm-engine-subpath-2026-08-01.md`.

## 1. `disableBlockGasLimit` is taken, and the block-gas-limit CAP is deleted

**Chosen:** `src/revm.ts` passes `request.gasLimit + intrinsic` WHOLE, with `disableBlockGasLimit: true`, instead of capping it at the block gas limit.

**Why:** the cap existed only because revm rejected a transaction whose gas limit exceeded the block's (`CallerGasLimitMoreThanBlock`), and the node's default read budget IS the block gas limit, so the correct budget (`gasLimit + intrinsic`) was over it by exactly `intrinsic`. That left a divergence window: a call needing within `intrinsic` gas of the whole block limit ran out of gas on revm and completed on `@ethereumjs/evm`, whose `runCall` charges no intrinsic gas and enforces no block limit. The switch removes the check, so the two engines now have identical execution budgets at every gas limit. The task's own acceptance criterion asked for this to be taken or refused explicitly.

**Rejected:** keeping the cap (a known, if narrow, divergence, and this task's whole point is that there should be none left); asking the node for a smaller default read budget (changes the default engine's behaviour to accommodate the optional one).

**Touches:** the gas mapping documented at the code site, and decision 3 of the subpath record, which is marked partly superseded there. Nothing outside `src/revm.ts` and no user-visible option.

## 2. `disableEip3607` makes `eth_call` from a CONTRACT address succeed on revm

**Chosen:** the read path sets `disableEip3607: true`, so a read whose `from` holds code executes rather than being rejected with `Transaction(RejectCallerWithCode)`.

**Why:** this is a PERMISSION, not a refusal, and it removes a divergence rather than creating one: `@ethereumjs/evm`'s `runCall` never enforced EIP-3607 (ethereumjs enforces it in `runTx`), so the same `eth_call` already succeeded on the default engine and failed only on revm. EIP-3607 is a rule about *sending* a transaction, and simulating from a contract address is ordinary practice (smart accounts, ERC-4337, multicall aggregators, a UI previewing what one contract sees when called by another). Asserted in `test/helpers/revm-engine.ts` with a contract caller and an EOA caller in the same test, same result and same gas.

**Rejected:** leaving EIP-3607 on for reads (an `eth_call` that works on one engine and fails on the other, for a shape consumers actually use).

**Touches:** the WRITE path, and this is the constraint to carry forward: `revm-wasm` REFUSES to combine any simulation switch with committing (a committed transaction from a contract address is one the chain would reject, and `disableBalanceCheck` fabricates the caller's balance). `revm-engine-behind-runtx` must not reach for these on a committing path. Said at the code site too.

## 3. The block-environment conformance step's oracle is the NODE'S OWN block, not the trie reference

**Chosen:** the new battery step (`block environment through a contract`, `test/helpers/conformance.ts`) diffs what the contract read against the node's own `eth_getBlockByNumber` header plus the `blockEnv` the node was configured with — not against the `@ethereumjs/vm` reference every other step uses.

**Why:** the reference is a separate chain built by hand, with its own timestamps (0) and its own zero coinbase, so diffing block-environment reads against it would measure that difference rather than the engine's honesty. Because the SAME battery runs on the default engine (`conformance.spec.ts`) and on revm (`revm-conformance.spec.ts`), holding both to the same node block IS the cross-engine diff the task asked for. `COINBASE` and `PREVRANDAO` are diffed against the configuration specifically because the node's RPC block reports neither (`miner` is a hardcoded zero and there is no `mixHash` field — see `work/notes/observations/rpc-block-omits-coinbase-and-prevrandao.md`).

**Rejected:** teaching the reference the node's block environment (it would then no longer be an independent oracle for the receipt steps, which is its actual job); asserting only cross-engine equality with no absolute values (two engines can agree on a block neither of them should have been running against).

**Touches:** `test/helpers/conformance.ts` and both conformance specs, which now assert the step by label so it cannot silently stop running.

## 4. `PREVRANDAO` is read from `header.mixHash`, not from the `prevRandao` getter

**Chosen:** `src/revm.ts` passes `prevRandao: header.mixHash`.

**Why:** post-Merge they are the same field (the node writes `NodeOptions.blockEnv.prevRandao` into `mixHash` and pins `difficulty` to 0), but `@ethereumjs/block`'s `prevRandao` getter THROWS when EIP-4399 is not activated. The node is Cancun today, yet `SPEC_BY_HARDFORK` still maps `berlin` and `london`, so the getter is a latent throw on a fork the engine claims to support while `mixHash` is always readable.

**Touches:** nothing outside the engine; noted so a reader does not "fix" it back to the getter.

## 5. A NEW test contract (`BlockEnvProbe.sol`) rather than a function on `ConformanceProbe`

**Chosen:** a separate `test/contracts/BlockEnvProbe.sol` + generated `test/helpers/block-env-probe.ts`, exporting creation AND runtime bytecode.

**Why:** `ConformanceProbe` is deployed by the receipt battery and its bytecode is part of those steps' gas and addresses; growing it would perturb steps that are not about the block environment. The runtime bytecode is exported because the block-environment tests PLACE the code with `evm_setCode` rather than deploying it, which is also what gives the EIP-3607 test an address that holds code.

**Touches:** the test tree only. Compiled with the same `solc 0.8.33` the other two use, pinned to `--evm-version cancun` (the node's fork) so a future default-EVM-version change in solc cannot silently emit opcodes the node does not have.
