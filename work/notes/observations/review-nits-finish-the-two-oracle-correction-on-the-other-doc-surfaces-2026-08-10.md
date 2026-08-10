---
title: review-gate non-blocking nits for 'finish-the-two-oracle-correction-on-the-other-doc-surfaces' (Gate 2 approve)
date: 2026-08-10
status: open
reviewOf: finish-the-two-oracle-correction-on-the-other-doc-surfaces
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'finish-the-two-oracle-correction-on-the-other-doc-surfaces' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The new note claims only two surviving pointers at the deleted revm-wasm-intrinsic-gas-ignores-the-spec note, but there are four across three files. The one it misses is the highest-impact: work/tasks/backlog/readmit-refused-hardforks-once-the-node-can-cost-them.md cites it at line 37 and, worse, at line 80 its Prompt instructs the future builder to READ that deleted file as an entry condition. Should the note be widened before the follow-up is cut, so the repair does not skip the live claimable task?
  (work/notes/observations/two-more-pointers-at-the-discharged-intrinsic-gas-note.md names only docs/adr/0008 (line 52) and the sibling gasUsed note; grep finds readmit-refused-hardforks-once-the-node-can-cost-them.md:37 and :80 too.)
- Section 4 of the intrinsic-gas spike doc was repaired too, a FOURTH citation beyond the three the task named, and it uses a DIFFERENT form from the other two: it keeps the dead path work/notes/observations/revm-wasm-intrinsic-gas-ignores-the-spec.md inline (annotated as discharged in 68f59e2), whereas the section 5 and section 7 repairs drop the dead path entirely, matching ADR 0008's precedent. Ratify the extra repair, and decide whether naming a deleted path is acceptable given the task goal says no citation should point at a file that is not there.
  (docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md:64 vs :67 and :120; ADR 0008:58 names no dead path.)
- The README names TWO steps whose oracle is not the trie reference (block-environment, value-bearing), but conformance.ts carries THREE oracle-is comment blocks: step 15 (block gas limit) is also absolute, and there the reference is provably blind because Reference.mineBlock passes skipBlockGasLimitValidation. The README hedges with not-for-all-of-them and points at the comments (plural), so nobody is badly misled, but step 15's non-reference oracle is stated in no prose surface (CONTEXT.md's glossary undercounts identically, and the task inherited that framing). Worth a capture so the same fixing-it-back-onto-the-reference hazard is closed for step 15.
  (packages/embedded-eth-node/test/helpers/conformance.ts lines 896, 989 and 1214; README.md:468-475; CONTEXT.md:19.)
- Acceptance asked for roughly one clause or sentence in the README's consumer voice, with the glossary carrying the full definition. What landed is one ~570-character sentence that roughly doubles the paragraph and re-states most of the glossary's reasoning (the hand-built chain, its own timestamps, a zero coinbase, no receipt for a refused read) rather than pointing at it. Accept as-is, or trim the parenthetical and lean on the CONTEXT.md pointer already present?
  (README.md:468-475 vs the guidance in the task body (do not import the glossary sentence wholesale).)
- No Decisions block was recorded on the PR/commit, yet several in-scope choices were made unilaterally: repairing a fourth citation, adding a new Reading order preamble plus a section 3 supersession banner (the task only asked to check section 5's conclusion was not mistakable, and it was already marked), minting a new observations note, and citing BOTH CONTEXT.md and the code comments in the README where the task offered either. All look right; please ratify.
  (git log -1 12fef19 has an empty body; diff adds the reading-order paragraph at measurements.md:7 and the section 3 banner at :42.)
