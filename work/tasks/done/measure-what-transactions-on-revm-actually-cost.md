---
title: Measure what transactions on revm actually cost, against the CURRENT baseline
slug: measure-what-transactions-on-revm-actually-cost
spec: revm-engine-behind-runtx
blockedBy: [the-conformance-differential-covers-transactions-on-revm, sender-recovery-uses-the-engines-ecrecover]
covers: [8]
---

## What to build

Story 8 says a game developer wants transaction execution measurably faster, and the honest form of that is a MEASUREMENT, not an assertion. Measure it after the write path is correct, and report the answer whatever it is, including "no faster" or "slower", because this spec's real justification is single-EVM coherence and a truthful number is worth more than a favourable one.

**The baseline moved, and the framing this spec was written with is stale.** The spec used to say the interpreter is only about 6% of a transaction's time (the sentence was removed when the spec was trimmed, so do not go looking for it; it is quoted here as the belief to distrust). It was measured while the state manager copied ALL of storage on every message frame, which ADR 0009 removed. So the interpreter's SHARE of a transaction is now larger and unmeasured.

Measure against `docs/spikes/re-layer-storage-as-per-account-maps-with-per-frame-diffs/measurements.md`, and read it the way it asks to be read: the four-transaction row at 100,000 slots is **18-28x and FLAT**, from two runs of the same script on the same machine (336.1 to 11.9, and 301.1 to 16.8), and the document says in bold not to quote the single 28x cell because it is the allocation-heaviest in the file. The durable claim is the FLATNESS, not any ratio. Take the same care with your own numbers: this task's whole subject is numeric honesty, so a single cherry-picked cell in its own report would be self-refuting.

Two more things to measure rather than assume, both named by the spec:

- **The commit path has never been benchmarked**, and with real fees it does strictly MORE host writes than before, because the coinbase is now written on every transaction instead of being deleted. Cost the write callbacks, not just execution.
- **Sender recovery** is a fixed per-transaction cost that moved if the ecrecover task landed. Report the transaction cost with the recovery included and excluded, so the two levers are separable.

Report by transaction SHAPE, because one number for "a transaction" hides the answer: a plain transfer, a storage-writing call, a call touching many DISTINCT storage slots (the shape the host-callback design is most sensitive to, since a boundary crossing is paid per COLD access), a creation, and a log-emitting call. Say where the crossover is, if there is one.

The repo already has the instrument: the benchmark suite's existing rows and the frame budget. Extend those rather than inventing a parallel harness, and record the result the way the other measurement documents in this repo do, with a re-runnable script and the environment stated.

## Acceptance criteria

- [ ] Transaction cost is measured on BOTH engines, by transaction shape (transfer, storage write, many distinct slots, creation, logs), against the post-ADR-0009 baseline.
- [ ] The commit path is measured specifically, including the coinbase write that now happens on every transaction.
- [ ] Sender recovery is reported separately from execution, so the two levers can be told apart.
- [ ] The result is recorded with a re-runnable script and the environment stated, in the style of the repo's existing measurement documents, and the numbers are produced by that script rather than quoted from reasoning.
- [ ] The answer is reported plainly even if it is unfavourable, the stale "interpreter is ~6%" framing is not repeated anywhere, and no single allocation-heavy cell is quoted as if it were the result.
- [ ] If the measurement suggests the design should be revisited (for example a real workload touching thousands of distinct slots per tick), that is stated as a finding rather than acted on.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- `the-conformance-differential-covers-transactions-on-revm` — measure a correct implementation, not a plausible one.
- `sender-recovery-uses-the-engines-ecrecover` — it moves a fixed per-transaction cost that this task has to report with and without, and it authors the same figure. Measuring first would publish a number that task immediately invalidates, and would then have it rewriting this task's document.

## Prompt

> Goal: answer story 8 with a number, produced by a script someone else can re-run, against the CURRENT baseline.
>
> FIRST, check this task against current reality: it was written on 2026-08-09 and may have DRIFTED. Re-read the measurements document it points at and confirm nothing has moved the baseline again since; if something has, measure against THAT, and say which commit the baseline came from.
>
> Read `docs/spikes/re-layer-storage-as-per-account-maps-with-per-frame-diffs/measurements.md` for what a transaction costs today and how that document is structured, the benchmark suite's existing rows and frame budget, and the state-ownership ADR for why a boundary crossing is paid once per COLD state access.
>
> DO NOT QUOTE THE SPEC'S OWN NUMBERS. Its "interpreter is only ~6% of a transaction" was measured before the state manager stopped copying all of storage per message frame; that copying dominated, and removing it changed the denominator. Re-measure.
>
> Measure the COMMIT path too. It has never been benchmarked, and it now does more host writes than it used to, because a coinbase credited a real fee is written rather than deleted.
>
> Report by transaction shape and report honestly. This spec's justification is that a node running two EVMs has two chances to disagree with itself; a disappointing performance number does not undermine that, and an inflated one would.
