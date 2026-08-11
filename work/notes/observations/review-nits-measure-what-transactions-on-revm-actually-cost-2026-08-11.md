---
title: review-gate non-blocking nits for 'measure-what-transactions-on-revm-actually-cost' (Gate 2 approve)
date: 2026-08-11
status: open
reviewOf: measure-what-transactions-on-revm-actually-cost
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'measure-what-transactions-on-revm-actually-cost' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify amending an accepted ADR in place: ADR 0010 gained a 2026-08-11 amendment declaring its revisit trigger measured-and-not-fired and the wasm-side cache unbuilt. That is a durable design disposition (not just a measurement) and it is NOT listed in the doc's Decisions block. Is amending the ADR the right home, or should the disposition live only in the spike doc's F3 until a human decides?
  (docs/adr/0010-...md new section 'Amendment, 2026-08-11'; the Decisions block in docs/spikes/measure-what-transactions-on-revm-actually-cost/measurements.md lists only the 3 measurement-design choices)
- Ratify decision 1 (recorded): the shapes were measured by a new Node probe under docs/spikes/ and packages/benchmarks was used unchanged as a Chromium cross-check, rather than teaching the benchmark scenario the new shapes. This is a cross-task interaction: anyone who later wants these shapes in the browser must make the change this task declined, and the two documents then need reconciling.
  (measurements.md, Decisions 1; ADR 0010 amendment last paragraph calls it a deviation from what the ADR caveat asked for)
- Section 4's crossover sweep is READ-only (a SLOAD loop), yet story 8 is about a tick that WRITES state, and the strong claims (F3, F4, the frame-budget crossover, 'revm never leaves the budget on this axis') rest on it. The write axis is sampled at one point only (256 slot writes) and its ceiling is different (~1,400 cold zero-to-nonzero SSTOREs at 30M gas). Should the write axis be swept too, or at least named in 'What was NOT measured'?
  (measure-transaction-cost.mjs SWEEP uses sloadLoop(k); measurements.md section 4 and findings F3/F4; the 'What was NOT measured' list does not mention the write sweep)
- Factual slip in a durable record: the ADR 0010 amendment says teaching the benchmark scenario 'five transaction shapes', while the probe and the doc's decision 1 say six (transfer, storage write, 256 distinct slots, 256 slot writes, creation, logs). Worth correcting so the ADR does not disagree with the document it cites.
  (docs/adr/0010-...md:50 vs measurements.md Decisions 1 and the SHAPES array in measure-transaction-cost.mjs)
