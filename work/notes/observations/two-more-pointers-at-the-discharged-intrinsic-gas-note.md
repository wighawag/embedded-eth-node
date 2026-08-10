---
title: Pointers at the discharged intrinsic-gas note still survive in two places
date: 2026-08-10
status: open
---

`work/notes/observations/revm-wasm-intrinsic-gas-ignores-the-spec.md` was discharged by deletion in `68f59e2`, its own condition having been met by the 0.3.1 upgrade. `finish-the-two-oracle-correction-on-the-other-doc-surfaces` repaired the spike-document citations it was scoped to.

UPDATED 2026-08-10 by the conductor, after Gate 2 found this note undercounted. There were FOUR surviving pointers, not two. The two that instructed a future builder to READ the deleted file have been repaired directly, because they sat in `work/tasks/backlog/readmit-refused-hardforks-once-the-node-can-cost-them.md` (line 37, and line 80 where its Prompt made reading the note an ENTRY CONDITION); that task is deliberately deferred, so nothing else was going to reach them.

Two remain, and both are prose citations rather than instructions:

- `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` (in the scope-was-measured paragraph) cites the note as where the root cause was "sharpened".
- `work/notes/observations/revm-wasm-gasused-carries-the-eip-7623-floor.md`, itself a live note tracking open upstream behaviour, cites it as a sibling.

Both are tracked by `repair-the-last-pointers-at-the-discharged-intrinsic-gas-note`. Note the repo has now used TWO citation forms for a discharged note: ADR 0008's earlier repair drops the dead path entirely, while the spike doc's newest repair keeps the path inline annotated with its discharging commit. Either resolves for a reader; the repo should settle on one.
