---
title: Re-layer the node's storage as per-account maps with per-frame diffs, so a checkpoint stops copying all of state
slug: re-layer-storage-as-per-account-maps-with-per-frame-diffs
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`spike-storage-layout-cost-for-the-revm-write-half` measured what `SimpleStateManager`'s flat `${address}_${slot}` storage map costs this node, and the answer is larger than anyone had assumed. `checkpointSync()` copies the ENTIRE account, code and storage maps, and `@ethereumjs/evm` checkpoints once per message frame, so **every transaction pays `frames + 1` full copies of all of state**. Measured end to end: four ordinary transactions cost 289 ms at 100,000 slots on the shipped layout and 10 ms on a layout that copies nothing per frame, a 29x gap that grows with state. Through the node's own public surface, one transaction at 10,000 slots already eats between a third and nine tenths of the 16.6 ms frame budget. All numbers, the probes that produced them, and a full reproduction run are in `docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/measurements.md`.

**This is a cost the node pays TODAY, on the default engine.** It is not a revm problem and swapping the interpreter cannot touch it, because the copying happens in the state manager. It is filed against `revm-engine-behind-runtx` because that spec's post-state stories are the ones that would otherwise be built on top of it, and because the spike says to land this FIRST, as its own change, so that a post-state mismatch in the write half is never ambiguous between the two.

**Build the fourth layout the spike measured, not the one ADR 0005 sketched.** Storage becomes `Map<address, Map<slot, value>>`, and a checkpoint pushes a per-frame DIFF plus a per-frame cleared-tombstone set rather than copying anything. Measured: checkpoint O(1) at ~0.2 microseconds at every state size, `clearStorage` O(1) at ~0.55 microseconds, and the four-transaction figure flat at 10 to 12 ms whether state holds 1,000 or 100,000 slots. The prototype is `docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/per-account-overlay-storage.mjs`; the plain per-account copy-on-write layout is NOT good enough, because it still copies the outer map and that is the same O(total) when state is one slot per account, which is what per-player game state looks like.

### Pin the vocabulary first, in one word

The spike calls the same idea an overlay, a diff frame and a journal frame in different places, and its two prototypes name the field `overlays` and `diffs`. Pick ONE term before writing anything, use it in the code, the tests and the commit, and add it to `CONTEXT.md`'s glossary the way the other domain terms are defined there. A future reader meeting three names for one concept will assume they are three concepts.

### The blast radius is nine sites and three of them fail SILENTLY

ADR 0005 said the layout could change "behind that one accessor, and only the accessor changes". The spike demonstrated that false against the shipped readers, and the ADR now carries an inline correction pointing at the demonstration. With a per-account layout underneath and no other change: `assertStackShape` still passes, `SimpleStateManagerStore.getStorage` answers "zero" for a slot holding `0x2a` with no throw, and `dumpState`'s `'none'` branch dumps no storage at all. Work from the nine-site list in the spike's Blast radius section rather than from a grep, and treat the three silent sites as the real risk: the failure mode here is wrong answers, not a crash.

Two constraints that fall out of that list:

- **The `dumpState` / `loadState` serialised format MUST NOT change.** It is persisted data with existing state behind it, and the internal layout is free to move under it. Assert that a state dumped before the change loads after it.
- **`assertStackShape` currently gives false comfort** and must be replaced by a guard that actually constrains the NEW representation, or it guards nothing.

### The packed key encoding is a SEPARATE step, sequenced inside this task

The spike also found that 84% of a 1.23 microsecond cold revm access is JS-side key handling, that the per-account nesting recovers none of it (measured at -1% and +2% on two runs: zero), and that `revm-wasm`'s packed key encoding recovers 50%. It recommends banking that at the same time, on the argument that the node only owns the key format once it owns the representation.

Take that recommendation, but land it as its own commit AFTER the layout change is green, not mixed into it: it is a read-path change (ADR 0005 has the read adapter mirror the key format byte for byte) riding on a write-path change, and the two have different blast radii. If the layout change turns out to be big enough on its own, split the key encoding into a follow-up task and say so rather than rushing it.

## Acceptance criteria

- [ ] Storage is per-account with per-frame diffs and a per-frame cleared-tombstone set; a checkpoint copies no storage, and `clearStorage(address)` is O(that account).
- [ ] Checkpoint, commit and revert semantics are asserted directly: a write inside a reverted frame does not survive, a write inside a committed frame does, a clear inside a reverted frame does not survive, and a slot written then cleared then written again in nested frames resolves correctly. The spike's naive shared-inner-map control is the shape these assertions must be able to FAIL.
- [ ] The randomised differential from the spike (or an equivalent) runs against the shipped behaviour, so the new layout is proven to answer identically rather than merely to be faster.
- [ ] Every one of the nine sites in the spike's Blast radius list is addressed, and the three silent ones (`assertStackShape`, `SimpleStateManagerStore.getStorage`, `dumpState`'s `'none'` branch) are covered by assertions that would have caught the silent failure.
- [ ] `dumpState`'s serialised format is byte-identical for the same state, and a state dumped by the previous version loads correctly into the new one, asserted.
- [ ] The conformance differential, the cross-backend gas gate and the reference numbers are unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] One term for the frame concept, used everywhere, and defined in `CONTEXT.md`'s glossary.
- [ ] The improvement is MEASURED after the change with the spike's own probes, and the result recorded, so the claim in the changeset is a number rather than an adjective.
- [ ] A changeset: this changes published behaviour (performance, and the state manager the `'none'` mode ships).
- [ ] The packed key encoding, if taken, is a separate commit landed after the layout change is green, with its own measurement; if deferred, a follow-up task exists and this task says why.
- [ ] ADR 0005's `clearStorage` section is superseded properly (this is the task the inline correction defers to), and the observation note `adr-0005-swap-the-layout-behind-one-accessor-is-false.md` is discharged in the same change.

## Blocked by

- None. The spike that justifies it is in `work/tasks/done/`.

## Prompt

> Goal: stop the node copying all of state on every message frame. This is a cost the DEFAULT engine pays today, measured at 29x on four transactions at 100,000 slots, and it is invisible to the cross-backend gas gate because gas is identical either way.
>
> Read `docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/measurements.md` end to end FIRST. It is the justification, the design, the blast radius and the test plan, and its probes are re-runnable. Note its warning about running the memory-heavy probe alone under a heap cap.
>
> CORRECTNESS BEFORE SPEED, in that order and demonstrably. The spike ships a naive shared-inner-map control precisely because it is the plausible wrong version: a shallow copy of the outer map shares the inner maps, so a child frame's write leaks into the parent and a revert does not undo it. Your assertions must be able to fail against that control before any timing number is worth reporting.
>
> THE DANGEROUS PART IS NOT THE DATA STRUCTURE, it is the readers. Three shipped sites read the layout directly and answer WRONG rather than throwing when it changes underneath them. They are listed in the spike. Do not grep for them and hope.
>
> Do NOT change the `dumpState` / `loadState` serialised format. It is persisted data; the internal layout moves under it.
>
> Land the layout change first and green, then the packed key encoding as its own commit, or defer the encoding to a follow-up and say why. Do not mix them.
