---
title: Adopt revm-wasm's packed key encoding in the revm state store, now that the node owns the storage representation
slug: revm-state-store-packed-storage-keys
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`spike-storage-layout-cost-for-the-revm-write-half` measured where a cold revm storage access actually goes, through the real wasm module, on a contract that SLOADs 2,000 DISTINCT slots (2,000 cold accesses, so 2,000 host callbacks, counted rather than assumed):

| quantity | µs | share of the shipped cold access |
| --- | --- | --- |
| shipped flat-hex access | 1.232 | 100% |
| crossing alone (null store) | 0.195 | 16% |
| key handling (flat minus null) | 1.037 | 84% |
| recovered by per-account hex keys | -0.016 | -1% (i.e. ZERO; +2% on re-run) |
| **recovered by `revm-wasm`'s PACKED encoding** | **0.616** | **50%** |

So: 84% of a cold access is JS-side key handling, the per-account nesting recovers NONE of it (splitting one 109-character key into two shorter ones changes nothing, because the cost is building hex at all), and `revm-wasm`'s packed encoding — two bytes per UTF-16 code unit — recovers half of every cold access. All of it, and the probe that produced it, is in `docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/measurements.md` (Q4) and `probe-cold-access-key-cost.mjs`, which is re-runnable.

That win was available only if the NODE owns the key format. **It now does**: `re-layer-storage-as-per-account-maps-with-per-frame-diffs` shipped `OverlayStorageStateManager` (ADR 0009), so the storage key is ours to choose rather than `SimpleStateManager`'s to dictate. This task is the second half of that spike's recommendation, deliberately deferred so the two would not land mixed together — the layout was a WRITE-path change and this is a READ-path change with a different blast radius, and a post-state mismatch in either would otherwise have been ambiguous between them.

The change is small in surface and precise in location: `src/revm-state-store.ts` builds a storage key in exactly ONE place (`#storageOf`), and `src/state-manager.ts` owns the format on the other side. Both must move together and stay byte-identical to each other, and the async `getStorage`/`putStorage` that `@ethereumjs/evm` drives must produce the SAME key as the synchronous `storageAt` revm drives, or the two engines silently read different slots.

Watch the two places the format escapes the pair:

- **`dumpState` must not change.** Its slot keys are `0x`-prefixed 32-byte hex in a persisted format; if the internal key becomes packed, `liveStorage()` (or `dumpState`) has to convert back. `test/storage-overlay.spec.ts` already asserts the dump byte-identical against `test/fixtures/dumpstate-flat-layout.json`, so this is guarded — do not weaken that assertion to make the change pass.
- **`loadState`, genesis and `evm_setStorageAt`** reach storage through `putStorage`, so they are fine BY ROUTE, not by luck. Keep it that way.

## Acceptance criteria

- [ ] The revm store and the state manager use ONE key encoding, built in one place on each side, and a key built by either is accepted by the other — asserted, not assumed.
- [ ] The measurement is re-run with `probe-cold-access-key-cost.mjs` (or an equivalent against the SHIPPED store rather than a prototype) and the result recorded, so the claim is a number.
- [ ] `dumpState`'s serialised format is unchanged and the existing byte-identical assertion still passes UNWEAKENED.
- [ ] The conformance differential, the GeneralStateTests run and the cross-backend gas gate are unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] A storage read through the revm engine and the same read through `@ethereumjs/evm` return the same value for the same slot, asserted directly (the failure mode here is two engines reading different keys, which changes results without changing gas).
- [ ] A changeset.

## Blocked by

- None. `re-layer-storage-as-per-account-maps-with-per-frame-diffs` is in `work/tasks/done/`.

## Prompt

> Goal: recover 50% of every cold revm storage access by replacing the hex storage key with `revm-wasm`'s packed encoding. The precondition — the node owning its own storage representation — is met as of ADR 0009.
>
> Read `docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/measurements.md` Q4 first; it is the justification and its probe is re-runnable. Then read `docs/adr/0009-none-mode-storage-is-per-account-with-per-checkpoint-overlays.md` and `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md`, which is where the "the adapter must reproduce the key format byte for byte" constraint comes from.
>
> THE DANGEROUS FAILURE IS TWO KEY FORMATS THAT BOTH WORK. `@ethereumjs/evm` writes storage through the async `putStorage`; revm reads it through the synchronous `storageAt`. If those two disagree about the key, every read is a MISS, which reads as zero rather than as an error, and gas is identical either way — so the cross-backend gas gate cannot see it. Assert a cross-engine read of the same slot directly.
>
> Do NOT change the `dumpState` / `loadState` serialised format. It is persisted data; the internal key format moves under it, and there is already a byte-identical assertion guarding this. Do not weaken it.
>
> Measure after, with the spike's own probe, and record the number rather than an adjective.
