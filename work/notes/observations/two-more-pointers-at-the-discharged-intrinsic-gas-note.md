---
title: Two citations outside the spike docs still point at the discharged revm-wasm-intrinsic-gas-ignores-the-spec note
date: 2026-08-10
status: open
---

Spotted while repairing the spike-document citations for `finish-the-two-oracle-correction-on-the-other-doc-surfaces`, whose scope was the two `docs/spikes/*/measurements.md` files only. `work/notes/observations/revm-wasm-intrinsic-gas-ignores-the-spec.md` was discharged by deletion in commit `68f59e2` (its own condition met), and two citations of it elsewhere still resolve to nothing: `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` (the "same root cause as ..." sentence in the first amendment) and the sibling note `work/notes/observations/revm-wasm-gasused-carries-the-eip-7623-floor.md` (its closing `./revm-wasm-intrinsic-gas-ignores-the-spec.md` pointer). Both want the same repair the ADR's other discharged-note citations already got: name the discharging commit and where the signal now lives.
