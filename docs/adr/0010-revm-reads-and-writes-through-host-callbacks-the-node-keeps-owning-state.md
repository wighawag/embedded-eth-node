# revm reads AND WRITES through host callbacks; the node keeps owning state

The revm engine does not own state and will not be given it. It reads accounts, code, storage and block hashes from the node's own `stateMode:'none'` state manager on demand, through `revm-wasm`'s synchronous `StateStore` callbacks, and a committing transaction writes back ONLY the accounts revm touched and the slots that changed, through the same seam. Nothing is copied into wasm, in either direction, at any point. [ADR 0005](0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md) established the read half and its cost (the reach-through into `SimpleStateManager`'s public stacks, which is why `stateMode:'trie'` is refused); this records the decision for the WRITE half, which is the one that had a real alternative.

**The alternative was moving state INTO wasm**, and ADR 0005 called that "the honest end state". It is not, and the reason is not the migration cost of `dumpState` / `loadState` / persistence / the `evm_set*` cheats. Those are consequences, and a big enough win would justify paying them. The reason is that with state on the JS side both engines run against IDENTICAL state, and that single property is what buys three things at once:

1. **The conformance differential can compare the two engines IN PLACE.** `test/revm-conformance.spec.ts` runs the same signed transactions through a revm-backed node and diffs receipts and post-state against a trie-backed `@ethereumjs/vm` `runTx` reference. With state inside wasm, "the same state" would itself become a thing to synchronise and trust, and the strongest correctness bar in the repo would be measuring the synchronisation.
2. **A JS-only fallback keeps working when the wasm does not load.** The node comes up on `@ethereumjs/evm` with the same state manager, same dumps, same cheats.
3. **A state root computed OUTSIDE revm over the authoritative state stays reachable.** It is refused today (`getStateRoot()` throws in `'none'` mode), but the route is open without a redesign.

Moving state into wasm forfeits all three permanently. That is what makes this hard to reverse in the direction that matters.

## It is affordable, and here is the measurement

The cost of not owning state is one wasm-to-JS crossing per state access. The claim that makes it affordable is that the boundary is crossed once per **COLD** access, because revm's journal answers everything warm from inside wasm.

Measured in this repo, `revm-wasm@0.3.1`, Node 24, spec CANCUN — probe and full tables in [`docs/spikes/revm-executes-the-first-transaction-with-commit/`](../spikes/revm-executes-the-first-transaction-with-commit/measurements.md), which exits non-zero if any figure moves:

| a transaction whose contract does | host `getStorage` callbacks | `gasUsed` |
| --- | --- | --- |
| 2,000 `SLOAD`s of the SAME slot | **1** | 283,003 |
| 2,000 `SLOAD`s of 2,000 DIFFERENT slots | **2,000** | 4,283,003 |

A plain value transfer, for scale: three `getAccount`, zero `getStorage`, three `setAccount` — six crossings in total. And the write side is proportional to what was touched: a transaction writing one slot of a contract holding a thousand causes exactly one `setStorage`, no `clearStorage`, and three `setAccount`.

**The callback COUNTS are the load-bearing measurement**; the gas is the independent witness that they track EIP-2929 cold accesses, since an instrumented store cannot change what the protocol charges. One clause of the figures this spec inherited from the engine side is looser than it read, and is corrected rather than repeated: the 4,000,000 gas difference is **not** `2000 × (2100 − 100)`. It is `(2000 − 1) × (2100 − 100)` = 3,998,000 — the same-slot loop pays cold once too — plus 2,000 gas of loop difference (`DUP1` at 3 gas versus `PUSH0` at 2, per iteration). The round number is a coincidence of that loop shape. Both gas totals reproduce the inherited ones exactly, so the numbers were right; the explanation of the delta was not.

## The caveat that cuts the other way, recorded honestly

**EIP-2929 resets warm/cold every TRANSACTION.** Measured: the same distinct-slot contract called by two transactions in a row causes 2,000 callbacks each time and is charged the same 4,283,003 gas each time. So a game loop re-reading the same entities every tick re-pays those crossings every tick, where state living inside wasm would pay once. Gas is identical either way — the protocol charges cold access whatever the host does — so **only wall clock differs**.

Revisit if a real contract reads thousands of DISTINCT slots per tick, and measure it with the benchmark suite's existing rows (`frame`, `read`, `callAvg`) rather than arguing it. The adapter shape leaves the door open: a wasm-side cache spanning transactions could be added later without redesigning the seam, and it would need invalidation on the `evm_set*` cheats, which mutate the node's state with no transaction to notice.

## Consequences

- **The node's own features cost nothing to keep.** `dumpState`, `loadState`, IndexedDB persistence and the `evm_set*` cheats read and write the same representation they always did, so none of them changed when the write half landed. That is a consequence of the decision, not its justification.
- **The store's five write methods are the whole write half**, and they receive revm's own commit semantics ALREADY APPLIED: a `SELFDESTRUCT` and an EIP-161 empty-account clearing both arrive as `clearStorage` then `removeAccount`, and a created account arrives with its storage cleared FIRST. The host does not re-derive any of that; re-deriving it is how a host gets EIP-161 subtly wrong. Expect the coinbase to be deleted when the priority fee is zero: it stays touched-and-empty, and `@ethereumjs/vm` deletes it too.
- **Writes go through the representation, not the interface**, for the same reason reads do (ADR 0005): revm's commit runs inside a synchronous wasm callback and every `StateManagerInterface` method returns a `Promise`. `OverlayStorageStateManager` therefore grew `setStorageAt` / `clearStorageAt` alongside `storageAt` / `liveStorage`, and `assertStateShape` requires all four — a state manager with a different storage representation must fail loudly rather than answer every slot as zero (ADR 0009's blast-radius lesson).
- **Values are stored in SHORTEST form on the way in.** revm hands over 32 padded bytes; `@ethereumjs/evm` strips leading zeros before `putStorage` and a cleared slot is stored as a ZERO-LENGTH value. The store converts, because `dumpState` serialises the stored bytes verbatim and a padded write would round-trip correctly while dumping differently from the same state written by the default engine.
- **The node is pinned harder to its own state manager**, which is ADR 0005's trade made louder for a second time (ADR 0009 was the first). A consumer supplying their own state manager — not currently possible through `NodeOptions` — is further away still.
