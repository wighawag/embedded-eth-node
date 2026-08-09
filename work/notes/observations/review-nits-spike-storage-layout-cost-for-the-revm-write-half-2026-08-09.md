---
title: review-gate non-blocking nits for 'spike-storage-layout-cost-for-the-revm-write-half' (Gate 2 approve)
date: 2026-08-09
status: open
reviewOf: spike-storage-layout-cost-for-the-revm-write-half
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'spike-storage-layout-cost-for-the-revm-write-half' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The PR/commit body carries no Decisions block, so the in-scope choices the agent made have to be reconstructed from the deliverable. Please ratify the reconstructed list in findings 2-5 below, and consider requiring the block next time.
  (git log -1 243b3db has a bare subject line and an empty body; measurements.md carries the decisions instead.)
- Ratify the recommendation shape and its sequencing: the spike recommends a FOURTH layout (per-account map plus a per-frame diff/tombstone frame) rather than either option the task framed, and it instructs that this re-layer land as its OWN task BEFORE revm-engine-behind-runtx builds its post-state stories. The task invited a third shape, but the sequencing constraint is a decision imposed on another spec.
  (measurements.md, Recommendation section: re-layer in one dedicated task, before the write half post-state stories are built. The evidence is strong (end-to-end table: 289ms vs 10ms for four transactions at 100k slots, flat in state size), so this looks right, but it reorders another spec.)
- Ratify bundling the packed key encoding into the same re-layer. The recommendation says to adopt revm-wasm packed keys at the same time, which changes the storage KEY FORMAT that ADR 0005 has the read adapter mirror byte for byte. That is a read-path change riding on a write-path task.
  (measurements.md Q4: per-account hex recovers -1 to +2 percent (zero), packed recovers 50 percent; the argument is that the node only owns the key format once it owns the representation.)
- Pin ONE term for the frame concept before a task is cut on it. The deliverable calls the same idea an overlay, a diff frame and a journal frame in different places, and the two prototypes name their field differently (overlays vs diffs), while per-account + overlay is also the name of one measured layout.
  (per-account-overlay-storage.mjs uses this.diffs; overlay-flat-storage.mjs uses overlays; measurements.md table headers say flat + overlay and per-account + overlay while the prose says per-frame DIFF and journal frame.)
- Should ADR 0005 carry an inline correction now, rather than only an observations note? The spike demonstrates one of its claims false, and a future reader lands on the ADR, not on the note inbox.
  (work/notes/observations/adr-0005-swap-the-layout-behind-one-accessor-is-false.md defers superseding to whatever task re-layers storage; ADR-FORMAT.md offers a superseded-by status. Bucket choice (observations, not findings) is correct per WORK-CONTRACT, since this is internal, not external ground truth.)
