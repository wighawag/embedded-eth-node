---
title: review-gate non-blocking nits for 'revm-engine-under-conformance-and-gate' (Gate 2 approve)
date: 2026-08-01
status: open
reviewOf: revm-engine-under-conformance-and-gate
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'revm-engine-under-conformance-and-gate' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify decision 1+3 (the load-bearing pair): the battery is engine-parameterised via runBattery(stateMode, makeEngine?) plus runConformanceOnEngine, and the refused mode is asserted rather than assumed. This is the right call (no second drifting copy, no relaxed assertion), but it means anyone adding a battery step now silently adds it to the revm run too, and a future trie-capable revm turns two tests red at once. Confirm that is wanted.
  (packages/embedded-eth-node/test/helpers/conformance.ts:321-874; test/revm-conformance.spec.ts asserts refusals[0].stateMode==trie)
- Ratify the widened bundle-size skip: the pre-existing startsWith('embedded-eth-node-') continue now also skips the new row, so the embedded-eth-node/revm entry point is never weighed by any size row. The story-3 guarantee is still enforced (default-entry baseline + the revm-not-in-graph metafile check), so nothing regresses, but growth of the revm subpath bundle itself stays unmeasured. Accept or add a size row for it later.
  (packages/benchmarks/test/evm.spec.ts, bundle size per backend, the corrected skip comment)
- Un-recorded in-scope decision to ratify: helpers/cut-revm.ts became MODE-DISPATCHED (params.mode of 'revm-engine' or 'conformance') and gained a new refusal path that returns an error string 'unknown mode: X'. It is not in the Decisions note, and it is a cross-task interaction: every future spec mounting that cut must now pass a mode or get an empty-result error instead of the old default behaviour.
  (packages/embedded-eth-node/test/helpers/cut-revm.ts; revm-engine.spec.ts updated to pass mode:'revm-engine')
- Coverage honesty nit: the new spec header calls this the repo's strongest correctness bar pointed at revm, but the battery contains no block-environment step, so the two KNOWN revm divergences from the previous task (BASEFEE forced to 0, PREVRANDAO unavailable) are outside what this run can catch. Worth one sentence in revm-conformance.ts or the spec header naming what the battery does not cover, so a later reader does not read green as total.
  (work/notes/observations/decisions-revm-engine-subpath-2026-08-01.md items 1-2; no basefee/prevrandao step in test/helpers/conformance.ts)
- Ratify decision 8 (no changeset): packages/embedded-eth-node/src is untouched, so this is tests plus the private benchmarks package plus docs, matching the retire-vendored-revm precedent. The root README (which is the package-facing readme) did gain a paragraph; confirm a docs-only README change needs no changeset under this repo's convention.
  (CONTEXT.md Conventions, every user-facing change needs a changeset; README.md +7 lines)
- Ratify decision 7's caveat handling: the spike file records 10.4/13.0 ms for the JS node against the published 12.4/15.0 baselines because it is a different machine. Anyone citing this in engine-seam-docs-and-honest-edges must quote a PAIR from one table. That warning currently lives only in the spike doc and the decisions note, not in the README paragraph that points at the file.
  (docs/spikes/revm-engine-under-conformance-and-gate/frame-measurements.md, How to read it)
