---
title: The transaction-cost crossover claim rests on a read-only sweep, while the story it serves is about writes
slug: the-crossover-claim-rests-on-a-read-only-sweep
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`measure-what-transactions-on-revm-actually-cost` measured the revm write path and produced the numbers this repo now cites. Gate 2 approved it and found the strongest claims rest on an axis that is not the one the story is about.

The crossover sweep in section 4 of the spike document is READ-only: it varies work with an `SLOAD` loop. Story 8 is about a tick that WRITES state, and the load-bearing findings (F3, F4, the frame-budget crossover, and the claim that revm never leaves the budget on this axis) are all drawn from that sweep. The write axis is sampled at exactly ONE point, 256 slot writes, and its ceiling is materially different: roughly 1,400 cold zero-to-nonzero `SSTORE`s at 30M gas, against a read ceiling far higher. A curve measured on reads does not license a claim about writes at a single sampled point, particularly when the two have different ceilings.

Nothing measured is wrong, and the read sweep is worth having. The defect is scope: a conclusion stated more broadly than the measurement supports, in a document whose whole purpose is to be a durable, re-runnable record. The repo's own standard is that a wrong answer should be obvious rather than plausible, and a crossover curve that silently describes the wrong axis is the plausible kind.

Close it the cheap way or the thorough way, and say which:

- **Cheap and honest:** add the write sweep to the document's "What was NOT measured" list, and narrow F3, F4 and the crossover claim so each says explicitly that it is a READ-axis result, with the single write sample named as a single sample.
- **Thorough:** sweep the write axis too, so the crossover claim covers the axis story 8 actually cares about, and state both curves and both ceilings.

Prefer the thorough one if the probe extends cheaply, since the write axis is the one a consumer's tick will actually be on.

## Acceptance criteria

- [ ] No finding in the spike document, and no claim in any doc quoting it, states a crossover or budget conclusion about writes that is supported only by the read-only sweep.
- [ ] Either the write axis is swept, with its curve and its ceiling stated, or the absence of a write sweep is named in "What was NOT measured" and every affected finding is narrowed to the read axis.
- [ ] The differing ceilings are stated, since the roughly 1,400 cold zero-to-nonzero `SSTORE`s at 30M gas is what bounds the write axis and it is not the read ceiling.
- [ ] Any figure this repo quotes elsewhere from these findings is checked and updated if it was stated more broadly than the measurement supports.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] No changeset unless a published number changes.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: the crossover claim describes the axis it was measured on, or gets measured on the axis it describes.
>
> FIRST, check this task against current reality: it was written on 2026-08-11 and may have DRIFTED. Re-read section 4 and findings F3 and F4 of `docs/spikes/measure-what-transactions-on-revm-actually-cost/measurements.md` and confirm the sweep is still `sloadLoop`-driven and the write axis still has one sample.
>
> Re-run the probe rather than trusting its recorded numbers; that is what the document is for, and the machine it runs on differs.
>
> Read the ratios and the shapes, not the milliseconds, exactly as that probe's own header instructs. If you add a write sweep, keep it comparable to the read sweep rather than inventing a second methodology.
>
> Reference gas must not move: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052. If any of those changed, that is the finding and you should stop and say so.
