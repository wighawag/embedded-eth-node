---
title: review-gate non-blocking nits for 'prune-bottom-overlay-tombstones-and-align-the-quoted-speedup' (Gate 2 approve)
date: 2026-08-11
status: open
reviewOf: prune-bottom-overlay-tombstones-and-align-the-quoted-speedup
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'prune-bottom-overlay-tombstones-and-align-the-quoted-speedup' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify decision 1: the fix was applied at BOTH sites a bottom tombstone can be created, not only in commit() as the task named. clearStorageAt() now skips the tombstone when no checkpoint is open (storageOverlays.length > 1 guard), which is the depth-1 path every revm-engine CREATE takes via revm-state-store's synchronous callbacks. Reverse only if you wanted the revm half filed as a follow-up.
  (src/state-manager.ts clearStorageAt() and commit() (belowIsBottom = overlays.length === 2); recorded in work/notes/observations/decisions-prune-bottom-overlay-tombstones-2026-08-11.md section 1. Verified sound: at depth 1 nothing is below, the delete still performs the clear, storageAt falls off the end of the stack and returns undefined, and liveStorage processes the bottom first so its cleared set was always a no-op there.)
- Ratify decision 2: the acceptance criterion named only packages/benchmarks/test/evm.spec.ts, but the one remaining bare 28x in .changeset/per-account-storage-overlays.md was also rewritten to read 'that flatness'. Unreleased release notes, not history; CHANGELOG.md was deliberately left alone.
  (Recorded in the decisions note section 2. Repo-wide grep now finds only 18-28x ranges plus explanatory 28.2x/17.9x in the measurements doc, so the one-number-per-measurement criterion holds.)
- The new invariant 'the bottom overlay holds no tombstones' is documented only in src/state-manager.ts JSDoc, the test and the bundle re-pin block. ADR 0009 and the CONTEXT.md glossary still define an overlay as written slots plus a tombstone set of the accounts cleared in it, with no bottom exception, and ADR 0007's two amendments still say clearStorage is one delete plus a tombstone. Should one sentence be added to ADR 0009 (and the glossary entry) so a future author cannot read bottom.cleared as authoritative?
  (grep for 'bottom' in docs/adr/*.md and CONTEXT.md returns nothing. Impact is low today (nothing reads a bottom cleared set), but the glossary is this repo's stated source of truth for the overlay/tombstone language.)
- The build decisions again live in work/notes/observations/decisions-<slug>-<date>.md with a decisionsFor field, and the done record carries no pointer to them. No per-task action wanted: this is the sixth instance and is already captured, awaiting a maintainer call.
  (work/notes/observations/gate-2-keeps-finding-decision-records-that-are-not-linked-from-the-done-record.md, update of 2026-08-11. Re-patching it here is exactly the per-task noise that note exists to stop.)
