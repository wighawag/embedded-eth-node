---
title: Repair the last two pointers at the discharged intrinsic-gas note, and settle on one citation form
slug: repair-the-last-pointers-at-the-discharged-intrinsic-gas-note
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

`work/notes/observations/revm-wasm-intrinsic-gas-ignores-the-spec.md` was discharged by deletion in `68f59e2` once the 0.3.1 upgrade met its condition. Two prose citations of it still resolve to nothing:

- `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`, in the paragraph explaining that the scope was measured, cites the note as where the root cause was "sharpened".
- `work/notes/observations/revm-wasm-gasused-carries-the-eip-7623-floor.md` cites it as a sibling note. That file is a LIVE signal tracking open upstream revm-wasm behaviour and must NOT be deleted; only its dead citation is repaired.

A citation that does not resolve costs the citing document the authority it was written to have, which is the same reason the spike documents were repaired.

**Settle the form while you are here.** The repo now cites a discharged note two different ways: ADR 0008's earlier repair DROPS the dead path entirely and names where the reasoning now lives, while the spike doc's newest repair KEEPS the path inline, annotated with its discharging commit. Both resolve for a reader, and having two forms is the kind of small incoherence that multiplies. Pick one, apply it to both repairs here, and say which at the site so the next author does not fork it again.

Do NOT recreate the deleted note and do not copy its contents into either file.

## Acceptance criteria

- [ ] Neither remaining citation points at a path that does not exist; each names where the reasoning now lives.
- [ ] `work/notes/observations/revm-wasm-gasused-carries-the-eip-7623-floor.md` survives as a live signal, with only its citation repaired.
- [ ] One citation form is chosen and used for both, and the choice is recorded where a future author will meet it.
- [ ] ADR 0008 is amended per this repo's convention (an ADR takes a dated amendment rather than a rewrite) IF the change alters what it asserts; a citation repair that changes no claim follows the precedent already set by the earlier repair in that same file.
- [ ] No changeset: documentation only, no published behaviour changes.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: no citation in this repo points at the discharged intrinsic-gas note, and the repo has ONE way of citing a note that left by deletion.
>
> FIRST, check this task against current reality: it was written on 2026-08-10 and may have DRIFTED. `grep -rn revm-wasm-intrinsic-gas-ignores-the-spec` and confirm exactly which pointers survive; two were already repaired directly in `work/tasks/backlog/readmit-refused-hardforks-once-the-node-can-cost-them.md` and should not be re-repaired.
>
> Under this repo's contract a capture-bucket note leaves the inbox BY DELETION and git history is the archive, so the honest citation names the discharging commit and where the reasoning now lives, rather than resurrecting the file. `harden-and-tidy-the-revm-hardfork-tables` set that precedent in ADR 0008.
>
> CHANGELOG.md is history and is never rewritten, and an ADR takes a dated amendment rather than an edit to what it originally said. Judge whether a citation repair rises to that bar or is the kind of in-place repair the same file has already had, and follow the precedent rather than inventing a third convention.
>
> Done means both pointers resolve, the live upstream-tracking note is still there, and one citation form is written down.
