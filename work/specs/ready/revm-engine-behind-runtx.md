---
title: revm-wasm behind transaction execution
slug: revm-engine-behind-runtx
taskedAfter: [revm-engine-behind-eth-call]
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **READ ADR 0009 FIRST, 2026-08-09: the storage mechanism this spec describes is GONE.** Everything below that says state is reached through `SimpleStateManager`'s THREE public checkpoint stacks is now one stack short and one mechanism out of date: `stateMode:'none'` storage is per-account with per-checkpoint OVERLAYS (`docs/adr/0009-none-mode-storage-is-per-account-with-per-checkpoint-overlays.md`), the flat `storageStack` is retired and THROWS when read, and the readers go through `storageAt()` / `liveStorage()`. The "Watch the storage key shape" warning under State ownership is DISCHARGED: `clearStorage` is O(1) and the per-account indexing it asks for is done. Story 8's baseline moved with it, by 17-37x through the node's own surface, so "measurably faster than today" must be re-measured against the CURRENT numbers in `docs/spikes/re-layer-storage-as-per-account-maps-with-per-frame-diffs/measurements.md` rather than against anything quoted in this spec. The storage-layout question this spec said to settle before tasking is therefore SETTLED, in code.
>
> **RE-SCOPED 2026-08-01, after `revm-engine-behind-eth-call` shipped in full.** Both questions that gated this spec are resolved, so `needsAnswers` is cleared and it is taskable. What changed:
>
> **The premise is proven.** This spec's "State ownership" section assumed an adapter over `SimpleStateManager` with synchronous on-demand reads, which nobody had verified. `revm-state-adapter-spike` verified it, and `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md` records the answer: the three public checkpoint stacks, read top-of-frame on EVERY access, `'none'` mode only. The read half now ships on exactly that mechanism, so the write half inherits a working, measured foundation rather than an assumption. Read that ADR and `src/revm-state-store.ts` before tasking.
>
> **Three stories below are ALREADY DELIVERED. Do not re-task them.**
>
> - **Story 12** (reject `stateMode:'trie'` at `createNode()` with a real error) is shipped by `revm-engine-subpath`, asserted in `test/revm-engine.spec.ts`, recorded in ADR 0005.
> - **Story 11** (loud failure for a configuration the engine cannot serve, never a silent fallback) is shipped by `engine-seam-docs-and-honest-edges` as `connectReadEngine`, which also refuses a non-`ReadEngine` object and an engine whose `connect` throws. ADR 0006 records it.
> - **Story 9** (conformance differential against the revm engine) is shipped for the READ half by `revm-engine-under-conformance-and-gate`, which made the battery engine-parameterised and asserts the refused mode. The WRITE half genuinely remains, so story 9 NARROWS rather than disappears: point the same parameterised battery at transactions.
>
> **One decision to make FIRST, before any task is cut, because three independent findings converge on it.** `SimpleStateManager` keys storage in ONE FLAT map (`${address}_${slot}`), and that single fact now costs three things: (a) revm's `StateStore` contract requires `clearStorage(address)` to be O(that account), which a flat map cannot give (ADR 0005); (b) our own `SimpleStateManagerWithClearStorage` has to prefix-scan the whole map, O(total storage), for the same reason (ADR 0007); (c) `revm-engine-subpath` already shipped a per-account `storageOf` accessor precisely so the layout could be swapped behind one seam. Decide up front whether the write half re-layers storage to `Map<address, Map<slot, value>>` (the layout `MemoryStore` documents and revm's commit semantics assume) or whether revm takes ownership of storage outright. This is far cheaper to settle at tasking time than to discover mid-build, and it shapes stories 2, 3, 13 and 16 below.
>
> **Also new since this spec was written:** `revm-wasm` reached `0.3.0` and now carries every simulation switch this repo asked for (`disableBaseFee`, `disableBalanceCheck`, `disableBlockGasLimit`, `disableEip3607`, plus `prevRandao` on `BlockEnv`), which retires the read half's zero-base-fee workaround and closes the EIP-3607 divergence (`work/tasks/backlog/revm-wasm-upgrade-honest-block-environment.md`). Story 14's `ecrecover` reasoning is unaffected.
>
> **One constraint from that package which lands squarely on THIS spec's write half:** the simulation switches may NOT be combined with committing, because a committed transaction from a contract address is one the chain would reject, and relaxing validity on a committing path would break exactly the cross-engine equivalence story 1 and story 2 promise. So the write path gets NONE of them: `transact({commit: true})` must run with full validation, and stories 3 (fee arithmetic), 5 (replay rejection) and 10 (nonce checking chosen by construction from the call path) are the ones that depend on it. Tasking should state this explicitly, because the read half's engine sets those switches and a builder copying its options object would silently disable transaction validity.

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
12. As a consumer, I want `stateMode: 'trie'` with a revm engine to be REJECTED at `createNode()` with a real error naming the reason, so that I never receive a zero state root that looks real.
13. As a consumer, I want `dumpState`, `loadState`, IndexedDB persistence and the `evm_set*` cheats to keep working EXACTLY as they do today when a revm engine is installed, so that adopting revm costs me none of the node's existing features.
14. As a consumer in `senderMode: 'recover'`, I want sender recovery to use the engine's `ecrecover` when a revm engine is installed, so that the recovery half of a transaction gets ~4x cheaper for no additional bytes.
15. As a consumer, I want the type-3 receipt limitation (`blobGasUsed` and `blobGasPrice` unavailable) DOCUMENTED on the path that would produce one, so that I find a stated limitation rather than a silently incomplete receipt.
16. As a maintainer, I want state to be read and written through the engine's host callbacks against the authoritative state manager, rather than bulk-synced per transaction, so that the cost is proportional to what a transaction touched.

## Implementation Decisions

> **PROMOTE TO ADR at tasking time.** Two of the subsections below are not spec detail to be trimmed away — they are decisions that clear the ADR bar (hard to reverse, surprising without context, the result of a real trade-off), and the whole point of `docs/adr/` is that they outlive this launch snapshot. Write them as ADRs rather than discarding them:
>
> - **State ownership stays with `SimpleStateManager`** — proposed title: "revm reads and writes through host callbacks; the node keeps owning state". The why is engine swappability against identical state, and the measured evidence for its affordability is in Further Notes.
> - **`stateMode: 'trie'` is rejected under revm** — proposed title: "a revm-backed node has no state root, and says so". The why is the honest-edge convention plus the named cost (no GeneralStateTests for that configuration) and the `@ethereumjs/mpt` escape route.
>
> Everything else here is ordinary implementation detail and can be trimmed into tasks as usual.

### State ownership: `SimpleStateManager` stays authoritative

The node keeps owning state. The engine binding's ten imported host functions (five read, five write) become an **adapter over `SimpleStateManager`**: revm reads accounts, code, storage and block hashes on demand through the read callbacks, and its commit path writes changes back through the write callbacks.

This is deliberately NOT a bulk sync. Reads are on demand and writes are only the touched accounts and changed slots, so the cost is proportional to what a transaction touched rather than to the size of state. (The benchmark backend rebuilds host state wholesale after every write; that is an artefact of it having been a read-only hybrid and must NOT be copied here.)

Three consequences follow, and they are the reason this design was chosen:

- **`dumpState` / `loadState` are unchanged.** They read `SimpleStateManager`'s Maps, which are still the truth.
- **IndexedDB persistence is unchanged**, for the same reason.
- **The `evm_set*` cheats are unchanged.** They mutate the state manager directly, and revm sees the result through the read callbacks on the next call.

**Watch the storage key shape.** `SimpleStateManager` keys storage as a flat `addr_slot` map, so clearing one account's storage (needed on selfdestruct and on create) is a scan proportional to TOTAL slots, not to that account's. The engine binding has the same flaw today. Index storage per account on whichever side ends up owning it.

### `stateMode: 'trie'` is rejected under revm, loudly

A revm engine must reject `stateMode: 'trie'` at `createNode()` with a real error rather than silently degrading or silently switching engines. revm computes no state root, and returning a zero root would be exactly the plausible-looking lie the honest-edge convention exists to prevent.

The cost is explicit: a revm-backed node cannot be run against GeneralStateTests, which verify the post-state root and are currently the strongest external conformance signal. The `@ethereumjs/vm` engine keeps that ability, so the capability is not lost from the repo, only from the revm configuration.

**The door stays open, but not through revm.** revm is an execution engine and will not grow a trie; that is a state-storage concern. If a root is wanted later, compute it OUTSIDE revm from the authoritative state using `@ethereumjs/mpt`. Since `SimpleStateManager` remains the source of truth, that path stays available without redesign.

### Sender recovery

`senderMode` keeps both meanings, and the recovery implementation changes:

- **`'recover'`** uses revm's `ecrecover` when a revm engine is installed (~4.2x `@noble/curves`, at zero additional bytes since the precompile is already in the module), falling back to noble when it is not.
- **`'trusted'`** still skips recovery entirely.

Note this NARROWS the gap between the two modes, from roughly 13x to roughly 3x on the isolated `runTx` path, because the expensive half of `'recover'` gets much cheaper. `'trusted'` remains worth having, but it stops being the dominant lever.

### The logs bloom comes from wasm

Take the 256-byte bloom from the engine rather than computing it in JS. The reason is SINGLE IMPLEMENTATION, not speed: `logsBloom` is a field the conformance differential diffs, and a second implementation in JS is exactly the drift to avoid — the same argument that applies to `effectiveGasPrice`. The speed difference (~0.4 microseconds per keccak against ~6.4, so ~24 microseconds on a typical ERC-20 receipt) is real but is the tiebreaker, not the case.

### Type-3 receipts: a documented, accepted gap

revm fully supports blob transactions — `BLOBHASH`, `BLOBBASEFEE`, the blob gas price and versioned-hash checks all work, and the engine's differential covers 2,868 blob transactions. What is missing is that the binding's result does not SURFACE `blobGasUsed` or `blobGasPrice`, so a type-3 receipt cannot be fully reconstructed from it. That is an interface omission, not an engine limitation, and closing it is a small addition to the binding.

Not a blocker: type-3 transactions are not an intended use. **Document the gap** on the type-3 path so a consumer who does reach for it finds a stated limitation rather than a silently incomplete receipt.

### Other decisions

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
- Story 13 is a REGRESSION bar, so test it as one: run the existing persistence-reload, genesis-cheats and dump/load tests unchanged with a revm engine installed. If they need editing to pass, the state-ownership decision was implemented wrongly.
- Story 12 is cheap to assert and easy to forget: a `createNode({stateMode: 'trie', engine: revm})` must throw, and the message must say why.

### Why the host-callback design is affordable (measured, so it need not be re-derived)

The obvious worry about keeping state on the JS side is that every `SLOAD` crosses the wasm boundary. It does not. **The boundary is crossed once per COLD state access, because the engine's journal caches within a transaction.** Measured directly, by counting host storage callbacks for two contracts that each execute 2,000 `SLOAD`s:

| contract | host storage callbacks | gas |
| --- | --- | --- |
| reads the SAME slot 2,000 times | **1** | 283,003 |
| reads 2,000 DIFFERENT slots | **2,000** | 4,283,003 |

The 4,000,000 gas difference is exactly 2000 x 2000, the cold-2100 versus warm-100 delta, so callbacks track EIP-2929 cold accesses one-for-one. In other words, a crossing is paid precisely when the EVM already charges a cold-access premium.

At roughly 1.3 microseconds per cold access, the cost per frame is therefore driven by DISTINCT slots touched, not by `SLOAD` count:

| distinct slots read per tick | cost per frame | share of a 16.6 ms budget |
| --- | --- | --- |
| 200 | 0.26 ms | 1.6% |
| 2,000 | 2.6 ms | 16% |
| 10,000 | 13 ms | 78% |

Two caveats that cut in opposite directions, both worth knowing:

- **Against this design:** EIP-2929 resets warm/cold every transaction, so a game loop re-reading the same entities every tick RE-PAYS those crossings every tick. State living inside wasm would pay once, ever. Gas is identical either way; only wall-clock differs.
- **For it:** roughly 60% of the 1.3 microseconds is JS-side hex key construction (a 104-character string per access), not the crossing itself, which measures ~0.51 microseconds against a null host. That is fixable WITHOUT moving ownership, and it is the same flat `addr_slot` map problem noted above for `clear_storage`.

**When to revisit:** if a real contract reads thousands of DISTINCT storage slots per tick. That is directly measurable with the `frame` and `floor` rows already in the benchmark suite, so it should be measured rather than argued. Moving ownership into wasm is not foreclosed by this decision — because the host functions are an adapter, a wasm-side cache spanning transactions could be added later (it would need invalidation on the `evm_set*` cheats), and the seam survives.

The reason ownership stays on the JS side is NOT primarily the migration cost of `dumpState`/persistence/cheats. It is that both engines can then run against IDENTICAL state, which is what lets the conformance differential compare them in place, keeps a JS-only fallback working when the wasm fails to load, and preserves the `@ethereumjs/mpt`-over-authoritative-state route to a state root. Moving state into wasm would forfeit all three permanently.

## Out of Scope

- Publishing the wasm artifact — `revm-wasm-package`.
- Making revm the default engine.
- Type-3 (blob) receipt completeness. The gap is documented rather than closed; surfacing `blobGasUsed`/`blobGasPrice` is a small addition to the binding whenever a consumer needs it.
- Computing a state root for a revm-backed node. Rejected loudly for now; the `@ethereumjs/mpt`-over-authoritative-state path is available later without redesign.
- Reimplementing `dumpState`, `loadState`, persistence or the `evm_set*` cheats — the state-ownership decision above means none of them change.

## Further Notes

- Measured on the engine side, not yet in this node: sender charged 211,000 for a 1,000 wei transfer at 21,000 gas and an effective price of 10, coinbase credited 63,000 with a base fee of 7, and 147,000 burnt.
- The engine's fee corpus covers 63,551 transactions with fees and access lists applied, wasm against native, byte for byte, zero mismatches — but that proves wasm equals native, NOT that either equals `@ethereumjs/vm`. Only the conformance differential proves the latter, which is why it is the bar.
- The commit path has never been benchmarked, and with real fees it does strictly more host writes than before (the coinbase is now written on every transaction instead of being deleted). Story 8 should measure rather than assume.
