---
title: revm-wasm behind transaction execution
slug: revm-engine-behind-runtx
taskedAfter: [revm-engine-behind-eth-call]
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: the tasks.

> **TASKED 2026-08-09.** The implementation and testing detail this spec carried now lives in its tasks (born in `work/tasks/backlog/`), and its two ADR-worthy decisions are recorded where they outlive a snapshot: state ownership (the node keeps owning state; the engine reads AND writes it through host callbacks, with the measured affordability that justifies it) is written by `revm-executes-the-first-transaction-with-commit`, and the state-root refusal already lives in `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md`, which `re-widen-the-engine-seam-to-cover-transactions` extends to the widened seam. What remains below is the durable framing: why this work exists, what it delivers, and what it deliberately does not.
>
> **Stories 11 and 12 were already DELIVERED before tasking** (the loud failure for an unservable configuration, by `engine-seam-docs-and-honest-edges`; the `stateMode:'trie'` refusal, by `revm-engine-subpath`), so no task covers them. **Story 9 NARROWED** rather than disappeared: the conformance differential already runs against the revm engine for READS, and the task pointed at it covers transactions.
>
> **The seam decision taken at tasking time**, because it shapes every task: the engine seam is ONE interface covering both a read-only call and a committing transaction, and the DEFAULT `@ethereumjs/evm` engine implements both. It is not an optional capability bolted onto the read seam. The asymmetry between the two operations is real and lives at the METHOD level: a read relaxes transaction validity (base fee, block gas limit, EIP-3607) and cannot commit, while a transaction relaxes nothing. `CONTEXT.md`'s glossary had already written down the condition for re-widening the word *engine* to mean the EVM behind the node — "until a spec actually moves transactions onto it" — and this is that spec.

## Problem Statement

The consuming use case relies on transaction execution, not only `eth_call`. Getting revm behind reads (`revm-engine-behind-eth-call`) leaves transactions on `@ethereumjs/vm`, and a node running two different EVMs for reads and writes has two chances to disagree with itself. The performance argument is secondary and must be re-measured rather than quoted: the figures this spec was written with predate the storage re-layer in `docs/adr/0009-none-mode-storage-is-per-account-with-per-checkpoint-overlays.md`, which removed the cost that used to dominate a transaction.

The write path was blocked until recently: revm's binding charged its sender nothing and carried no access list, so a transaction was not really a transaction. That is fixed and verified — a value transfer charges `value + gasUsed * effectiveGasPrice`, credits the coinbase the tip, and burns the base fee — so the blocker is the integration, not the engine.

## Solution

Extend the engine seam to cover transaction execution: `eth_sendRawTransaction` / `eth_sendRawTransactionSync` (and the `evm_*As` trusted variants) execute on the installed engine with commit, nonce checking and real fees, producing receipts, logs and a bloom that are indistinguishable from `@ethereumjs/vm`'s.

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
12. As a consumer, I want `stateMode: 'trie'` with a revm engine to be REJECTED at `createNode()` with a real error naming the reason, so that I never receive a zero state root that looks real.
13. As a consumer, I want `dumpState`, `loadState`, IndexedDB persistence and the `evm_set*` cheats to keep working EXACTLY as they do today when a revm engine is installed, so that adopting revm costs me none of the node's existing features.
14. As a consumer in `senderMode: 'recover'`, I want sender recovery to use the engine's `ecrecover` when a revm engine is installed, so that the recovery half of a transaction gets cheaper for no additional bytes.
15. As a consumer, I want the type-3 receipt limitation (`blobGasUsed` and `blobGasPrice` unavailable) DOCUMENTED on the path that would produce one, so that I find a stated limitation rather than a silently incomplete receipt.
16. As a maintainer, I want state to be read and written through the engine's host callbacks against the authoritative state manager, rather than bulk-synced per transaction, so that the cost is proportional to what a transaction touched.

## Out of Scope

- Publishing the wasm artifact — `revm-wasm-package`.
- Making revm the default engine.
- Type-3 (blob) receipt completeness. The gap is documented rather than closed; surfacing `blobGasUsed`/`blobGasPrice` is a small addition to the binding whenever a consumer needs it.
- Computing a state root for a revm-backed node. Refused loudly; the route to a root computed OUTSIDE revm over the authoritative state remains available later without redesign, which is one of the reasons state ownership stays on the JS side.
- Reimplementing `dumpState`, `loadState`, persistence or the `evm_set*` cheats — the state-ownership decision means none of them change, and story 13 is the regression bar that proves it.
