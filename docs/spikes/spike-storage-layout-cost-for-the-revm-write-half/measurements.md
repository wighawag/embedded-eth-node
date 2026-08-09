# What the flat storage layout costs, and what a per-account layout buys, measured

Measured 2026-08-09 by the three probes in this folder. Every number below is one of their output lines, not a summary of reasoning; re-run them and they will print the same tables (the digits move, the ratios do not: see [Noise](#noise-and-how-to-read-these-numbers)).

```sh
pnpm install   # also builds packages/embedded-eth-node/dist, which the probes read
node docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/probe-storage-layout.mjs
node docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/probe-transaction-shape.mjs
node docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/probe-cold-access-key-cost.mjs
```

Environment: Node v24.13.1, linux x64, AMD Ryzen 7 PRO 6850U, `@ethereumjs/statemanager` 10.1.2, `@ethereumjs/vm`/`evm` 10.1.2, `revm-wasm` 0.3.1. Every probe exits non-zero if any of its checks fail, so they double as regression probes when either package moves.

## Files

- `probe-storage-layout.mjs`: correctness of the prototypes FIRST (five checkpoint/commit/revert semantics per layout, a naive control that must fail them, and a 20,000-operation randomised differential against the shipped layout), then Q1/Q2/Q3 microbenchmarks.
- `probe-transaction-shape.mjs`: checkpoint and `clearStorage` counts inside the real `createNode()`, the same operations timed as the node's own state grows, the four-layout A/B through `@ethereumjs/vm`, and the blast-radius demonstration against the SHIPPED readers.
- `probe-cold-access-key-cost.mjs`: Q4, through the real wasm module.
- `per-account-storage.mjs`: the prototype the task asked for: `Map<address, Map<slot, value>>` with COPY-ON-WRITE checkpoints, plus `NaivePerAccountStorageStateManager`, the shared-inner-map version kept as a control.
- `overlay-flat-storage.mjs`: the third shape: keep the flat key, make a checkpoint a write-set frame.
- `per-account-overlay-storage.mjs`: the fourth shape, and the recommended one: per-account storage with per-frame DIFFS.
- `support.mjs`: dependency resolution (the probes borrow the repo's install and add none) and the timing/reporting helpers.

Spike code. Nothing under `packages/` imports any of it.

## The answer, in five lines

1. **Q1 is the whole answer, and it is worse than the spec knew.** `SimpleStateManager.checkpointSync()` copies the ENTIRE storage map, and the EVM checkpoints per MESSAGE FRAME, so a transaction pays `frames + 1` full copies of all of state. At 100,000 slots that is 16-18 ms EACH. Four ordinary transactions cost **289 ms** on the shipped layout and **10 ms** on a layout that copies nothing per frame: **29x**, and the gap grows with state.
2. **Q2 is real but second-order.** The `clearStorage` prefix scan is 14 ms at 100,000 slots, and it is paid once per CREATE (counted, not assumed: a CREATE transaction really does call it once). One scan against four full copies is not where the time is.
3. **Q3: the per-account layout the task proposed is not the best shape the numbers point at.** Per-account with copy-on-write fixes `clearStorage` (O(1), 0.55 µs at any size) but leaves the checkpoint O(accounts), which is the same O(total) when state is one slot per account. Adding a per-frame DIFF (a journal frame) to the per-account layout makes the checkpoint O(1) as well, and that combination is the one that wins end to end.
4. **Q4: the per-account NESTING buys nothing for reads. The KEY ENCODING is the cost.** 84% of a 1.23 µs cold revm access is JS-side key handling, but replacing `prefix + slotHex` with two map lookups recovers **-1%** (nothing, inside noise). Replacing the hex key with `revm-wasm`'s packed encoding recovers **50%**. The spec's "about 60% is hex key construction" was right about the cause and understated the share.
5. **Nothing here contradicts the standing decision that state ownership stays on the JS side.** The dominant cost is a JS-side data-structure choice the node can change without moving anything into wasm, and changing it removes 96% of it.

**One ADR claim is refuted by measurement** and the write half needs to know before it plans: ADR 0005 says the layout can be swapped "behind that one accessor, and only the accessor changes". It cannot. Run against the prototype, the SHIPPED `SimpleStateManagerStore` answers "this slot is zero" for a slot that holds `0x2a`, `assertStackShape` passes anyway, and `dumpState`'s `'none'` branch dumps NO storage at all. Details in [Blast radius](#blast-radius-checked-not-assumed).

## Q1. What the checkpoint actually costs

### How many checkpoints an operation incurs

Counted inside the real `createNode()` by patching `SimpleStateManager.prototype`, so these are the node's own counts (`probe-transaction-shape.mjs`, section 1):

| operation | checkpointSync | commit | revert | clearStorage |
| --- | --- | --- | --- | --- |
| `eth_call` (SLOAD + return) | 2 | 1 | 1 | 0 |
| `eth_estimateGas` (same call) | 2 | 1 | 1 | 0 |
| tx: plain value transfer | 2 | 2 | 0 | 0 |
| tx: 3 SSTOREs, no sub-call | 2 | 2 | 0 | 0 |
| tx: 3 nested CALLs, each writing | 4 | 4 | 0 | 0 |
| tx: CREATE a contract | 2 | 2 | 0 | 1 |
| `eth_call`, revm engine installed | 0 | 0 | 0 | 0 |

The rule the counts establish: **checkpoints per transaction = message frames + 1** (`runTx` checkpoints the journal once, `EVM.runCall` once per frame). Every one of them is a full copy of the account map, the code map AND the storage map. A three-deep call is four copies of all of state.

The last row is the one that scopes the finding: the revm read path takes ZERO state-manager checkpoints, because `engine.ts` deliberately does not wrap an engine that cannot commit. So once revm serves reads, **the checkpoint cost is a WRITE-path problem**, which is precisely `revm-engine-behind-runtx`'s problem.

### What one checkpoint costs (microseconds)

`probe-storage-layout.mjs`, section 2. "dense" spreads the slots over 10 accounts; "sparse" is one slot per account, so the account count equals the slot count.

| state | accounts | flat (shipped) | per-account CoW | flat + overlay | per-account + overlay |
| --- | --- | --- | --- | --- | --- |
| 1,000 slots / dense | 10 | 60.7 | 0.709 | 0.209 | 0.198 |
| 1,000 slots / sparse | 1,000 | 62.7 | 62.0 | 0.201 | 0.205 |
| 10,000 slots / dense | 10 | 1,210 | 0.729 | 0.213 | 0.204 |
| 10,000 slots / sparse | 10,000 | 1,218 | 1,174 | 0.911 | 2.589 |
| 100,000 slots / dense | 10 | 17,830 | 1.301 | 0.296 | 0.359 |
| 100,000 slots / sparse | 100,000 | 16,239 | 13,833 | 0.222 | 0.214 |

Read the SPARSE rows carefully, because they are the honest limit of the shape the task proposed: **a per-account layout still copies the outer map, so its checkpoint is O(accounts-with-storage)**, and when every account holds one slot that is the same O(total) the flat map has. One run of the same probe measured that cell at 85,540 µs rather than 13,833 (100,000 live `Map` objects are allocation-bound and GC-noisy), which is a second reason not to rest a design on it. A per-frame diff copies nothing and is flat at ~0.2 µs in every row.

`commit` and `revert` follow the same story (flat: 4-8 µs at 100k because they splice/pop whole maps; overlay layouts: 0.05-0.25 µs everywhere).

### What that costs a transaction, end to end

Same four transactions (transfer, 3 SSTOREs, 3 nested calls, CREATE) through a standalone `@ethereumjs/vm`, median of 5, after checking that all four layouts produce IDENTICAL receipts and IDENTICAL post-state (`probe-transaction-shape.mjs`, section 3):

| state | flat (shipped) | per-account CoW | flat + overlay | per-account + overlay |
| --- | --- | --- | --- | --- |
| 1,000 slots | 12.3 ms | 10.4 ms (1.2x) | 12.0 ms (1.0x) | 12.2 ms (1.0x) |
| 10,000 slots | 29.2 ms | 10.6 ms (2.8x) | 27.3 ms (1.1x) | 10.1 ms (2.9x) |
| 100,000 slots | 289.3 ms | 11.9 ms (24.4x) | 99.1 ms (2.9x) | 10.0 ms (29.0x) |

The two per-account layouts are FLAT IN STATE SIZE: 10-12 ms for the same four transactions whether state holds 1,000 slots or 100,000. The shipped layout is 29x worse at 100k and would keep getting worse.

The same shape through the node's own public surface, one transaction each (`probe-transaction-shape.mjs`, section 2, milliseconds):

| node storage | `eth_call` | transfer | 3 SSTOREs | nested | CREATE |
| --- | --- | --- | --- | --- | --- |
| 0 slots | 0.148 | 2.97 | 2.99 | 3.33 | 3.78 |
| 1,000 slots | 0.273 | 3.76 | 4.04 | 4.82 | 4.88 |
| 10,000 slots | 3.72 | 11.9 | 5.43 | 7.62 | 15.1 |
| 100,000 slots | 49.6 | 46.1 | 38.9 | 81.4 | 94.0 |

**At 10,000 slots ONE transaction already eats a third to nine tenths of the 16.6 ms frame budget, and at 100,000 slots it is two to six whole budgets.** That is the number `revm-engine-behind-runtx`'s story 8 ("transaction execution measurably faster than today") should be held against, and it is not an interpreter cost: swapping the EVM cannot touch it, because the copying happens in the state manager.

## Q2. What `clearStorage` costs, and how often it is really called

`probe-storage-layout.mjs`, section 3 (microseconds, clearing one account of 100 slots). "clear+commit" is the pair, because an overlay defers the work to the commit that merges the clear down:

| state | flat clear | flat clear+commit | CoW clear | CoW clear+commit | flat+overlay clear | flat+overlay clear+commit | per-acct+overlay clear | per-acct+overlay clear+commit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000 slots / 10 accounts | 171.6 | 164.1 | 0.576 | 1.279 | 163.6 | 168.8 | 0.634 | 0.868 |
| 10,000 slots / 100 accounts | 1,386 | 1,403 | 0.550 | 5.510 | 1,407 | 1,397 | 0.563 | 0.865 |
| 100,000 slots / 1,000 accounts | 13,961 | 12,721 | 0.547 | 60.3 | 14,040 | 14,277 | 0.551 | 0.849 |

Three things worth taking from this table.

**"Rare" is a claim about how often you CREATE, and it was worth testing.** A CREATE transaction calls `clearStorage` exactly once (counted above). A node that deploys contracts at start-up and then runs a game loop pays it rarely; one that creates per tick pays 14 ms per creation at 100k slots.

**A flat key makes the cost unavoidable, wherever you move it.** `flat + overlay` still pays ~14 ms, because a flat key makes "this account's slots" unenumerable: the clear can only be a prefix scan, and moving it into the commit does not shrink it. That is the same reason `revm-wasm`'s `MemoryStore` documents the flat layout as "knowingly shipped broken".

**Only the per-account grouping fixes it**, and it fixes it completely: one `delete` on the outer map, 0.55 µs at every state size, with the commit merge staying under 1 µs when frames are diffs.

## Q3. What the per-account layout changes

### Correctness first

`probe-storage-layout.mjs` section 1 runs five checkpoint/commit/revert semantics on every layout, plus a 20,000-operation randomised differential against the shipped flat layout, comparing every read AND a full storage snapshot every 500 operations. All four layouts agree, and the four transactions run through `@ethereumjs/vm` produce identical receipts and identical post-state.

The checks have teeth, which is the part worth stating: `NaivePerAccountStorageStateManager` (the same per-account layout with the copy-on-write removed, i.e. `new Map(outer)` sharing every inner map) **fails 3 of the 5 semantics checks and diverges on the random sequence**. Copy-on-write is the design, not an optimisation: without it a write inside a reverted frame survives the revert, silently.

### Per-slot read and write

At checkpoint depth 1, through the state manager's async API, the four layouts are indistinguishable (1.78-1.99 µs read, 1.85-1.99 µs write, at every state size). That figure is dominated by the promise, not the map: revm reads the map directly and is measured in Q4.

The cost an overlay ADDS is that a read walks the frame stack. Measured against frame depth, reading a slot that lives in the BASE frame (the worst case, and the common one):

| frame depth | flat (shipped) | per-account CoW | flat + overlay | per-account + overlay |
| --- | --- | --- | --- | --- |
| 1 | 1.929 | 1.813 | 1.771 | 1.832 |
| 2 | 1.792 | 1.787 | 1.974 | 1.844 |
| 4 | 1.817 | 1.803 | 1.963 | 1.877 |
| 8 | 1.789 | 1.842 | 2.001 | 1.940 |

At the depths the EVM actually reaches, the walk is not measurable against the surrounding cost. It is a real term, and it is the thing to watch if a contract nests dozens of frames deep, but it does not pay for a 29x.

### The pathological case for copy-on-write

One frame writing ONE slot each across many accounts, where each account already holds `slots each` slots. Cost of the whole frame (checkpoint + writes + commit), microseconds:

| frame | slots each | total slots | flat | per-account CoW | flat + overlay | per-account + overlay |
| --- | --- | --- | --- | --- | --- | --- |
| 10 accounts touched | 100 | 100,000 | 15,574 | 208.8 | 24.7 | 49.3 |
| 100 accounts touched | 100 | 100,000 | 17,377 | 1,020 | 302.5 | 309.0 |
| 100 accounts touched | 1,000 | 1,000,000 | 416,104 | 11,853 | 246.0 | 263.9 |
| 1,000 accounts touched | 100 | 100,000 | 17,669 | 10,279 | 2,571 | 2,775 |

Copy-on-write degrades exactly where predicted: touching many accounts means cloning many inner maps, and cloning a 1,000-slot inner map to change one slot costs. At 100 accounts x 1,000 slots it is 11.9 ms, 48x worse than the diff frame's 0.26 ms. It is still 35x better than the flat layout, so this is a comparison between the two candidate fixes, not a reason to keep the shipped one.

## Q4. How much of a cold access is the key

`probe-cold-access-key-cost.mjs` runs a contract that SLOADs 2,000 DISTINCT slots (2,000 cold accesses, so 2,000 host callbacks, verified by counting them) and the same contract reading ONE slot 2,000 times (one callback), through the real wasm module. The difference between the two runs is the crossing plus its key handling; the difference between STORES is the key handling alone.

| store | cold callbacks | warm callbacks | cold ms | warm ms | µs per cold access |
| --- | --- | --- | --- | --- | --- |
| flat hex (the shipped `#storageOf`) | 2,000 | 1 | 2.783 | 0.319 | 1.232 |
| per-account, hex keys | 2,000 | 1 | 2.815 | 0.320 | 1.248 |
| per-account, packed keys | 2,000 | 1 | 1.546 | 0.315 | 0.616 |
| null store (crossing only) | 2,000 | 1 | 0.706 | 0.315 | 0.195 |

Gas confirms the callback accounting: 4,289,006 cold against 291,006 warm, a difference of 3,998,000 = 2000 x 1999, exactly the EIP-2929 cold/warm delta.

| quantity | µs | share of the shipped cold access |
| --- | --- | --- |
| shipped flat-hex access | 1.232 | 100% |
| crossing alone (null store) | 0.195 | 16% |
| key handling (flat minus null) | 1.037 | 84% |
| **recovered by per-account hex** | **-0.016** | **-1%** |
| **recovered by per-account packed** | **0.616** | **50%** |

And the JS half alone, no wasm involved: flat hex 0.969 µs, per-account hex 1.024 µs, per-account packed 0.458 µs (the probe's own `slotBytes()` overhead is 0.057 µs of each).

**The conclusion is not the one the question expected.** Splitting one 109-character key into a 42-character key plus a 66-character key recovers nothing, because the cost is building hex at all, not concatenating it. The 1.23 µs reproduces the spec's 1.3 µs figure exactly, so the two measurements agree about the phenomenon and disagree only about the fix. What actually recovers half of it is `revm-wasm`'s packed encoding (two bytes per UTF-16 code unit), and that is available only if the NODE owns the key format. Today it does not: the format is `SimpleStateManager`'s, reproduced byte for byte by ADR 0005. Owning the storage representation is therefore the precondition for the cheap read win as well as for the write win, which makes them one change rather than two.

## Blast radius, checked not assumed

ADR 0005: "Then the flat map can be swapped for `Map<account, Map<slot, value>>` ... behind that one accessor, and only the accessor changes." **Measured false.** `probe-transaction-shape.mjs` section 4 binds the SHIPPED, unmodified `SimpleStateManagerStore` to the per-account prototype and asks it for a slot that holds `0x2a`:

- `assertStackShape(sm)` **PASSES**. The three stacks still exist and still hold `Map`s, so the guard designed to catch a shape change cannot see this one.
- `store.getStorage(...)` returns **`undefined`, i.e. "this slot is zero"**, for a slot that holds `0x2a`. No throw, no warning, a plausible answer.
- `dumpState`'s `'none'` branch (replicated verbatim from `src/node.ts`) dumps **NOTHING**: it reads `storageStack` directly and splits the flat key on `_`. A node with persistence enabled would then SAVE that empty storage.

The reason is structural, not an oversight in the ADR's spirit: `#storageOf` is an accessor over a structure it does not own. Changing the layout means changing `SimpleStateManager`'s storage REPRESENTATION, and every site that reads that representation changes with it. The full list:

| site | what it knows today | what it becomes |
| --- | --- | --- |
| `SimpleStateManager.getStorage` / `putStorage` (upstream) | builds `${address}_${slot}` against `topStorageStack()` | overridden in our subclass; the base implementations must not be reachable |
| `SimpleStateManager.checkpointSync` / `commit` / `revert` (upstream) | pushes/splices/pops `storageStack` | overridden; this IS the fix, and it is why the change cannot be a small one |
| `SimpleStateManager.shallowCopy` (upstream) | copies all three stacks | overridden, or a copy silently shares frames |
| `SimpleStateManagerWithClearStorage.clearStorage` (`src/state-manager.ts`) | prefix scan of the top frame | one `delete`; the O(total) note in ADR 0007 goes away |
| `SimpleStateManagerStore.#storageOf` + `#storage` (`src/revm-state-store.ts`) | `storageStack[len-1]`, then `prefix + slotHex` | reads the new per-account structure; also the place to adopt the packed key from Q4 |
| `assertStackShape` (`src/revm-state-store.ts`) | asserts three non-empty arrays of `Map` | must assert the NEW shape, or it guards nothing |
| `dumpState`, `'none'` branch (`src/node.ts`) | `storageStack[len-1]`, `combined.indexOf('_')` | iterates accounts and slots; the SERIALISED format must stay unchanged (hex, `{address: {slot: value}}`) or every persisted state and every `loadState` fixture breaks |
| `loadState` / genesis / `evm_setStorageAt` (`src/node.ts`) | call `sm.putStorage` | unaffected: they go through the interface |
| `test/helpers/conformance.ts` | calls `sm.getStorage` | unaffected, same reason |

Two consequences a tasker should plan for. First, the node's public serialisation format is NOT the internal layout and must not follow it: `dumpState` output is a persistence format with existing data behind it. Second, `assertStackShape` currently gives false comfort, and whatever replaces the layout must bring its own guard, because the failure mode here is silent wrong answers rather than a crash.

## Recommendation

**Re-layer, in one dedicated task, before the write half's post-state stories are built, and make the frame a per-account DIFF rather than a copy: `Map<address, Map<slot, value>>` per checkpoint frame, plus a per-frame `cleared` tombstone set.** That is `per-account-overlay-storage.mjs` here, it is the only shape that removes BOTH terms (checkpoint O(1) at 0.2 µs, `clearStorage` O(1) at 0.55 µs), it holds four transactions at 10-12 ms whether state is 1,000 or 100,000 slots (29x at 100k, and FLAT in state size rather than merely better), and it is the shape revm's own commit semantics and `MemoryStore` already assume, so the write half stops translating between two models. Do it as its own change with the differential probe here as its test, because it is a state-representation change with a real blast radius (nine sites, three of them silent-wrong-answer sites), and landing it underneath a half-finished write path would make any post-state mismatch ambiguous between the two. Bank the packed key encoding at the same time, since the node only owns the key format once it owns the representation, and it is worth 50% of every cold revm access.

**What I would NOT do, and why.**

- **Not the plain per-account copy-on-write layout the task proposed on its own.** It fixes `clearStorage` but leaves the checkpoint O(accounts-with-storage), which is O(total) in the one-slot-per-account limit that per-player game state tends towards: 13.8 ms at 100k sparse in the run above and 85.5 ms in another run of the same probe. Adding the diff frame is a smaller change than the copy-on-write bookkeeping it replaces.
- **Not "keep the flat map and pay the cost".** 289 ms for four transactions at 100,000 slots is seventeen frame budgets, it is invisible to the cross-backend gas gate (gas is identical), and it grows with state, so it would be discovered by a consumer rather than by us.
- **Not flat + overlay frames**, the cheap-looking fix that keeps the key format and every reader of it: it recovers 2.9x of the available 29x and leaves `clearStorage` at 14 ms, because a flat key cannot enumerate an account's slots at any price.
- **Not a wasm-side cache or moving storage ownership into revm.** Nothing measured here needs it, the dominant cost is a JS data structure we control, and the read half already pays ZERO checkpoints, so ownership is not what is expensive.
- **Not a change to the `dumpState` / `loadState` serialised format.** It is persisted data; the internal layout is free to change under it and must.

## Whether upstream is the right home

Partly, and not on the critical path. There is a genuine upstream bug here in the ordinary sense: `checkpointSync` copies the whole of state per frame, so ANY `@ethereumjs/evm` consumer using `SimpleStateManager` pays O(state) per message frame, and `clearStorage`'s no-op signature (already filed as [#4357](https://github.com/ethereumjs/ethereumjs-monorepo/issues/4357) / [#4358](https://github.com/ethereumjs/ethereumjs-monorepo/pull/4358)) is the same class of problem. Filing this one with the numbers costs little and the evidence is already written; a journal-frame checkpoint is what `@ethereumjs/evm` already keeps ABOVE the state manager and what revm keeps inside wasm, so it is not an exotic ask.

But the fix must ship in code we publish, for exactly ADR 0007's reason: `embedded-eth-node` is a LIBRARY, a consumer resolves `@ethereumjs/statemanager` themselves, and a `pnpm patch` would fix only our own test runs while every consumer kept the slow path. This case is stronger than ADR 0007's, because we are not only fixing a bug: we want a storage representation that our own `dumpState` and revm store read directly, and upstream has no reason to keep our accessors stable. So: our own class, published; report upstream; and if upstream ever adopts the same shape, the subclass narrows rather than disappears (the reach-through in `revm-state-store.ts` still needs SOMETHING to reach through).

## Noise, and how to read these numbers

Run-to-run spread on the allocation-heavy rows is tens of percent and occasionally worse: the 100,000-slot sparse copy-on-write checkpoint measured 13.8 ms in the run transcribed here and 85.5 ms in another, because 100,000 live `Map` objects make that case GC-bound. Every figure is a median of 7 batches within a run, and the probes print the whole table, so re-run rather than quote a single digit. **Read the ratios, and prefer the end-to-end transaction table to the microbenchmarks**: it is the one that includes allocation and GC in the same proportion a real transaction does.

Nothing in this spike changed `packages/embedded-eth-node/src/**`, any `package.json`, or `pnpm-lock.yaml`, and the reference gas is untouched: the probes only read the node, and the four prototypes are spike code that nothing imports.
