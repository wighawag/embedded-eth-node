# What the storage re-layer actually bought, measured after it shipped

Measured 2026-08-09 by `measure-overlay-storage.mjs` in this folder, which compares the SHIPPED `packages/embedded-eth-node/src/state-manager.ts` against `FlatBaselineStateManager` — the layout the node shipped before, frozen inside the script so the "before" column cannot quietly become the new code compared with itself. Every number below is one of its output lines.

```sh
pnpm install   # also builds packages/embedded-eth-node/dist, which the script reads
node --max-old-space-size=4096 docs/spikes/re-layer-storage-as-per-account-maps-with-per-frame-diffs/measure-overlay-storage.mjs
```

**Run it ALONE and keep the heap cap.** Section 2 holds 100,000-slot maps and copies them repeatedly on the baseline layout, so it is the memory-heavy part; the cap makes an overrun fail as a JS heap error in the script rather than as memory pressure on whatever else is running. About 3 minutes end to end (most of it section 5, which grows the node's storage through 100,000 `evm_setStorageAt` calls on purpose, so the growth uses only the public surface). It exits non-zero if any check fails.

Environment: Node v24.13.1, linux x64, AMD Ryzen 7 PRO 6850U, `@ethereumjs/statemanager` 10.1.2. Same machine as the spike that designed this, so the columns are comparable.

**This is the AFTER measurement. The design, the four candidate layouts, the blast radius and the reasoning are in [`../spike-storage-layout-cost-for-the-revm-write-half/measurements.md`](../spike-storage-layout-cost-for-the-revm-write-half/measurements.md)**, whose prototype `per-account-overlay-storage.mjs` is what shipped.

## Correctness first, and it is not here

Section 1 of the script is a gate, not the bar: the same four transactions must produce identical receipts and identical post-state on both layouts before a single timing prints. Both pass.

The real correctness bar is `packages/embedded-eth-node/test/storage-overlay.spec.ts`, which runs six checkpoint/commit/revert semantics, a 20,000-operation randomised differential against the same frozen flat baseline (every read plus a full storage snapshot every 500 operations), and the same battery against a NAIVE control — a per-account layout whose checkpoint shallow-copies the outer map and shares the inner ones. The control fails **4 of the 6** semantics and diverges on the fuzz, which is what makes the six worth asserting.

## One checkpoint (microseconds)

`dense` spreads the slots over 10 accounts; `sparse` is one slot per account, the shape per-player game state tends towards.

| state | accounts | flat (before) | overlay (shipped) | speedup |
| --- | --- | --- | --- | --- |
| 1,000 slots / dense | 10 | 71.3 | 0.310 | 230x |
| 1,000 slots / sparse | 1,000 | 71.9 | 0.316 | 228x |
| 10,000 slots / dense | 10 | 1,516 | 0.329 | 4,608x |
| 10,000 slots / sparse | 10,000 | 1,366 | 0.322 | 4,242x |
| 100,000 slots / dense | 10 | 22,901 | 0.340 | 67,356x |
| 100,000 slots / sparse | 100,000 | 22,017 | 0.325 | 67,745x |

The shipped column is FLAT: 0.31 to 0.34 microseconds whether state holds 1,000 slots or 100,000, and whether they sit on 10 accounts or 100,000. That is the whole point — a checkpoint pushes an empty overlay and copies nothing — and the ratio column is really just the baseline's O(total) growth restated.

## `clearStorage` on one account of 100 slots (microseconds)

| state | flat (before) | overlay (shipped) | speedup |
| --- | --- | --- | --- |
| 1,000 slots / 10 accounts | 135.1 | 0.570 | 237x |
| 10,000 slots / 100 accounts | 1,623 | 0.587 | 2,765x |
| 100,000 slots / 1,000 accounts | 17,458 | 0.543 | 32,151x |

Flat at ~0.55 microseconds at every state size, against a prefix scan of the whole map. The EVM calls this on EVERY contract creation.

## Four transactions through `@ethereumjs/vm` (median of 5, milliseconds)

Transfer, 3 SSTOREs, 3 nested CALLs each writing, and a CREATE — run back to back after the receipts and post-state were checked identical.

| state | flat (before) | overlay (shipped) | speedup | re-run |
| --- | --- | --- | --- | --- |
| 1,000 slots | 15.8 | 12.0 | 1.3x | 14.3 / 12.1 = 1.2x |
| 10,000 slots | 34.9 | 13.0 | 2.7x | 34.2 / 11.6 = 2.9x |
| 100,000 slots | 336.1 | 11.9 | 28.2x | 301.1 / 16.8 = 17.9x |

**12.0 ms at 1,000 slots and 11.9 ms at 100,000**: flat in state size rather than merely faster, which is the property that matters, because the baseline kept getting worse.

Read this row as **18-28x, and FLAT**, not as 28x. The 100,000-slot cell is the allocation-heaviest in the file and it is the one that moves between runs (11.9 ms and 16.8 ms on two consecutive runs of the same script on the same machine, against a baseline that itself moved 336 to 301 ms). The spike predicted 29x at 100k from its prototype; the shipped class measured 28.2x and 17.9x. What does NOT move is the shape: every overlay column is within a factor of 1.5 of itself from 1,000 slots to 100,000, and every flat column grows ~20x over the same range.

## The node's own public surface (milliseconds, one transaction each)

The table `revm-engine-behind-runtx`'s story 8 should be held against. "before" is the same table from the spike, taken on the same machine; "after" is this script's section 5.

| node storage | `eth_call` | transfer | 3 SSTOREs | nested | CREATE |
| --- | --- | --- | --- | --- | --- |
| 0 slots — before | 0.148 | 2.97 | 2.99 | 3.33 | 3.78 |
| 0 slots — **after** | 0.758 | 3.79 | 2.79 | 2.99 | 2.65 |
| 1,000 slots — before | 0.273 | 3.76 | 4.04 | 4.82 | 4.88 |
| 1,000 slots — **after** | 0.319 | 2.77 | 2.80 | 2.94 | 2.77 |
| 10,000 slots — before | 3.72 | 11.9 | 5.43 | 7.62 | 15.1 |
| 10,000 slots — **after** | 0.313 | 2.61 | 2.60 | 2.84 | 2.63 |
| 100,000 slots — before | 49.6 | 46.1 | 38.9 | 81.4 | 94.0 |
| 100,000 slots — **after** | 0.320 | 2.41 | 2.80 | 2.74 | 2.53 |

Read the LAST pair of rows. At 100,000 slots a transaction went from 39-94 ms (two to six whole 16.6 ms frame budgets) to 2.4-2.8 ms, and an `eth_call` from 49.6 ms to 0.32 ms — a **155x** read and a **17x to 37x** write, with every row now independent of how much storage the node holds. The `0 slots` row is where the two layouts should agree, and it does to within the run-to-run noise (the first row of a run also carries JIT warmup; the `after` `eth_call` there is one un-warmed call).

## Reproduction

Run twice back to back, 2026-08-09, same machine, same heap cap. Both exit 0 and every check passes.

| finding | first run | re-run |
| --- | --- | --- |
| identical receipts + post-state, both layouts | pass | pass |
| one checkpoint, 100k dense, flat | 22,901 µs | 20,213 µs |
| one checkpoint, 100k dense, overlay | 0.340 µs | 0.365 µs |
| one checkpoint, 1k dense, overlay | 0.310 µs | 0.450 µs |
| `clearStorage`, 100k, flat | 17,458 µs | 15,647 µs |
| `clearStorage`, 100k, overlay | 0.543 µs | 0.534 µs |
| four transactions at 100k, flat | 336.1 ms | 301.1 ms |
| four transactions at 100k, overlay | 11.9 ms (28.2x) | 16.8 ms (17.9x) |
| four transactions at 1k, overlay | 12.0 ms | 12.1 ms |
| node surface, 100k slots, transfer | 2.41 ms | 2.74 ms |
| node surface, 100k slots, `eth_call` | 0.320 ms | 0.358 ms |

The only cell that changed its story is the 100k four-transaction speedup, 28.2x against 17.9x. The claim that survives both is the one worth making: FLAT in state size, and between one and two orders of magnitude better than the layout it replaced at 100,000 slots.

## Noise, and how to read these numbers

Run-to-run spread on the allocation-heavy rows is tens of percent: the baseline's 100,000-slot checkpoint measured 17.8 ms in the spike's transcript, 22.9 ms in the first run here and 20.2 ms in the re-run, on the same machine. Every microbenchmark figure is a median of 7 batches, the transaction figures are a median of 5, and the script prints whole tables — re-run rather than quote a single digit, and prefer the transaction tables to the microbenchmarks, because they include allocation and GC in the same proportion a real transaction does.

The one number NOT to read as a speedup is the checkpoint ratio at 100k (55,000-67,000x). It is true, and it is meaningless on its own: a checkpoint is one term of a transaction, and the honest end-to-end figures are 18-28x through `@ethereumjs/vm` and 14-37x through the node.

## What was NOT measured here

The packed storage-key encoding, worth ~50% of a cold revm access by the previous spike's Q4. It is a READ-path change riding on this write-path one, and it was deliberately deferred to its own task (`work/tasks/backlog/revm-state-store-packed-storage-keys.md`) rather than mixed in — the node now owns the key format, which was the precondition, so nothing about that measurement changes.
