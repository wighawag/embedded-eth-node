---
title: revm-wasm behind transaction execution
slug: revm-engine-behind-runtx
needsAnswers: true
taskedAfter: [revm-engine-behind-eth-call]
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->

## Open questions

These block auto-tasking. Each one changes what the tasks should be, not merely how they are written.

1. **What happens to `stateMode: 'trie'` when revm owns state?** revm has no Merkle-Patricia trie, so a revm-backed node cannot produce a real state root. Options: (a) the revm engine rejects `stateMode: 'trie'` with a loud error at `createNode()`; (b) the node keeps a parallel `MerkleStateManager` purely to compute roots, paying for it twice; (c) trie mode silently forces the `@ethereumjs/vm` engine. Option (a) is the honest-edge default, but it means a revm node can never be run against GeneralStateTests, which is currently our strongest external conformance signal.
2. **Where does state live?** revm's spike keeps state in JS Maps that IT owns via a commit path, while the node today owns `SimpleStateManager`. Do we (a) let revm's host maps become the single source of truth and reimplement `dumpState`/`loadState`/`evm_set*` against them, or (b) keep `SimpleStateManager` authoritative and sync into revm per transaction? (b) is what the benchmark backend does for reads and it is cheap there, but per-transaction syncing on the write path may cost more than the win.
3. **What happens to IndexedDB persistence and `dumpState`/`loadState`?** These are `'none'`-mode features built on `SimpleStateManager`'s internal Maps. If answer 2 is (a), they need reimplementing against revm's state shape.
4. **What happens to the `evm_set*` cheats** (`evm_setBalance`, `evm_setNonce`, `evm_setCode`, `evm_setStorageAt`, `evm_setAccount`)? They currently mutate the state manager directly. Under revm they must mutate whatever answer 2 makes authoritative.
5. **Do we compute the logs bloom in wasm or in JS?** revm's spike can emit a 256-byte bloom at roughly 0.4 microseconds per keccak against 6.4 in JS, but only for calls that produce logs. The node currently takes the bloom from `runTx`'s receipt.
6. **Is `senderMode: 'trusted'` still meaningful under revm?** revm's `transact()` takes `caller` directly and never recovers, so the recovery step becomes explicitly ours in both modes. Does `'trusted'` then just mean "skip our own recovery call", and should revm's ~4.2x `ecrecover` become the default recovery for `'recover'` mode?
7. **What is the acceptance bar for type-3 receipts?** The spike does not emit `blobGasUsed` or `blobGasPrice`, so a type-3 receipt is not fully reconstructable. Is that acceptable, or a blocker?

<!-- /open-questions -->

## Problem Statement

The consuming use case relies on `runTx`, not only `eth_call`. Getting revm behind reads (`revm-engine-behind-eth-call`) leaves transactions on `@ethereumjs/evm`, where the interpreter is only ~6% of a transaction's time — but that 6% is the part that scales with the work a game tick actually does, and a node running two different EVMs for reads and writes has two chances to disagree with itself.

The write path was blocked until recently: revm's binding charged its sender nothing (`gas_price` was hardcoded to 0) and carried no access list, so a transaction was not really a transaction. That is now fixed and verified — a value transfer charges `value + gasUsed * effectiveGasPrice`, credits the coinbase the tip, and burns the base fee — so the blocker is the integration, not the engine.

## Solution

Extend the engine seam from `revm-engine-behind-eth-call` to cover transaction execution: `eth_sendRawTransaction` / `eth_sendRawTransactionSync` (and the `evm_*As` trusted variants) execute on revm with commit, nonce checking and real fees, producing receipts, logs and a bloom that are indistinguishable from `@ethereumjs/vm`'s.

The bar is the existing conformance differential: **a revm-executed transaction must be indistinguishable from a `runTx` of the same transaction, in receipt and in post-state.**

## User Stories

1. As a consumer, I want a transaction executed on revm to produce the SAME receipt as `@ethereumjs/vm` would, field for field, so that switching engines is invisible to my application.
2. As a consumer, I want post-state after a revm transaction to match `@ethereumjs/vm` exactly — balances, nonces, code and storage — so that a chain built on either engine is the same chain.
3. As a consumer, I want the sender to be charged `value + gasUsed * effectiveGasPrice` and the coinbase credited the priority portion, so that balances are real rather than a local fiction.
4. As a consumer, I want `effectiveGasPrice` on the receipt to come from the engine rather than being recomputed, so that there is exactly one implementation of the fee arithmetic.
5. As a consumer, I want a replayed transaction to be REJECTED, so that nonce semantics match a real node.
6. As a consumer, I want logs and the logs bloom on receipts to be correct, including that a log emitted inside a reverted sub-call does not appear.
7. As a consumer, I want EIP-2930 access lists honoured, so that a type-1 transaction is charged and warmed correctly.
8. As a game developer, I want transaction execution to be measurably faster than today, so that a tick that writes state is not the bottleneck.
9. As a maintainer, I want the conformance differential to run against the revm engine, so that any divergence from `@ethereumjs/vm` fails the build.
10. As a maintainer, I want nonce checking to be chosen BY CONSTRUCTION from the call path (transaction vs `eth_call`), never by a caller-supplied parameter, so that it cannot be forgotten.
11. As a maintainer, I want a clear, loud failure for any node configuration the revm engine cannot serve, rather than a silent fallback to a different engine.

## Implementation Decisions

- Reuse the engine seam introduced by `revm-engine-behind-eth-call`; this spec must not introduce a second, parallel mechanism.
- Nonce checking is set by the CALL PATH, not by a parameter. The underlying binding defaults it OFF, which is an `eth_call` semantic; a transaction that forgets it silently accepts a replay. This was verified: against an on-chain nonce of 5, a transaction claiming nonce 99 succeeds without the flag and is rejected with `NonceTooHigh` with it.
- Take `effectiveGasPrice` from the engine's own output rather than recomputing `min(maxFee, baseFee + tip)` in JS. A second implementation of fee arithmetic is exactly the drift this avoids.
- Transaction RLP parsing and signature recovery stay OURS: revm takes a caller directly and never parses or verifies a transaction. `@ethereumjs/tx` is unaffected by this spec.
- Block construction, `cumulativeGasUsed` (a block-level running total) and the RPC layer stay ours.
- Expect the coinbase to vanish from post-state when the priority fee is zero: it stays touched-and-empty and is deleted under EIP-161. `@ethereumjs/vm` does the same; it merely looks alarming in a diff.

## Testing Decisions

- The conformance differential (`test/helpers/conformance.ts`) is the acceptance bar, not the benchmark. It already covers 1559, legacy and 2930 transactions, a create, a multi-log case and a revert, diffing receipts field by field plus post-state — run it with the revm engine installed.
- Add negative cases the suite currently lacks and which this spec makes reachable: a replayed nonce, insufficient funds, and a storage-clearing refund (refunds are priced at the effective gas price, which a hand-rolled version gets wrong).
- The cross-backend gas gate continues to guard execution gas; it is necessary but NOT sufficient here, because it does not diff balances.
- Where the first disagreement is most likely, per the engine's own authors: `effectiveGasPrice` on a legacy transaction with a non-zero base fee, and the disappearing zero-tip coinbase.

## Out of Scope

- Publishing the wasm artifact — `revm-wasm-package`.
- Making revm the default engine.
- Type-3 (blob) receipt completeness, pending open question 7.
- The MPT trie: revm has no trie and this spec does not add one.

## Further Notes

- Measured on the engine side, not yet in this node: sender charged 211,000 for a 1,000 wei transfer at 21,000 gas and an effective price of 10, coinbase credited 63,000 with a base fee of 7, and 147,000 burnt.
- The engine's fee corpus covers 63,551 transactions with fees and access lists applied, wasm against native, byte for byte, zero mismatches — but that proves wasm equals native, NOT that either equals `@ethereumjs/vm`. Only the conformance differential proves the latter, which is why it is the bar.
- The commit path has never been benchmarked, and with real fees it does strictly more host writes than before (the coinbase is now written on every transaction instead of being deleted). Story 8 should measure rather than assume.
