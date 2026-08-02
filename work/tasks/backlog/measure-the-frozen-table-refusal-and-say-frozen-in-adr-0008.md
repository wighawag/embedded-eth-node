---
title: Measure the frozen tables' refusal instead of advertising it, and let ADR 0008 say the exports are frozen
slug: measure-the-frozen-table-refusal-and-say-frozen-in-adr-0008
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

`harden-and-tidy-the-revm-hardfork-tables` froze `REVM_SPEC_BY_HARDFORK` and `REVM_REFUSED_HARDFORKS`, asserted the freeze as a runtime property, and recorded why the guard reads the tables rather than a load-time snapshot. Gate 2 approved it and left two small coherence gaps, both of the repo's own standard-holding kind: something is DESCRIBED where this repo asserts, and something is true of the code that the ADR resting on it does not say.

**1. The `TypeError` is advertised and not measured.** `test/helpers/revm-engine.ts` already records `out.tableEditOutcomes` around the two re-admitting edit attempts, and `test/revm-engine.spec.ts` never asserts it: what is asserted is the CONSEQUENCE (the tables are unchanged, the guard still refuses `prague`), not that the write itself failed loudly. Meanwhile `.changeset/frozen-fork-tables.md` tells consumers that writing "now fails at the assignment (a `TypeError` in strict mode)". The test modules are ESM and therefore always strict, so this is one assertion away from being measured rather than claimed, and the claim is the part a consumer reads. Assert both edits threw, and keep the existing consequence assertions: the throw is the consumer-visible half, the unchanged table is the guard's half, and neither implies the other (a sloppy-mode consumer gets the second without the first, which is exactly the case worth keeping straight in the reader's mind).

**2. ADR 0008 does not mention the freeze.** Its consequences section still presents the two exports purely as "the honest answer to which forks this engine serves", which is what they were before they were frozen. A reader who lands on the ADR alone — the document whose whole subject is a construction-time guard — does not learn that the guard cannot be assigned away from outside. The rationale currently lives in `src/revm.ts`'s JSDoc, the README caveat and the changeset. Add the fact to the consequence bullet in the ADR's own voice, pointing at the code site for the reasoning rather than restating it; do not open a fourth amendment for it, because nothing about the DECISION changed.

## Acceptance criteria

- [ ] `test/revm-engine.spec.ts` asserts that both re-admitting edits THREW (not merely that the tables were unaffected), so the `TypeError` the changeset advertises is measured.
- [ ] The existing assertions stay: both tables report frozen, the admitted/refused key lists are unchanged after the edit attempts, and `prague`'s refusal afterwards is the same string in the same words.
- [ ] ADR 0008's consequence bullet about the two exports says they are frozen and what that buys, pointing at `src/revm.ts` for the reasoning. No new amendment section.
- [ ] No behaviour change, no admitted-set change, no refusal-message change.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None. It completes a change that has already landed.

## Prompt

> Goal: this repo asserts its honest edges rather than describing them, and two spots from the freeze change fall short of that bar by a line each.
>
> Read the `FROZEN, AND NOT MERELY Readonly` block in `packages/embedded-eth-node/src/revm.ts`, the `tableEditOutcomes` recording in `test/helpers/revm-engine.ts`, the assertions around `tablesFrozen` in `test/revm-engine.spec.ts`, and the consequences section of `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`.
>
> Both items are small ON PURPOSE. Do not re-open the freeze-versus-snapshot decision (it is recorded at the code site and settled), do not change any refusal message, and do not add an amendment to ADR 0008: nothing about the decision changed, only what the document says about its own consequences.
>
> Done means: the throw a consumer will hit is measured by the suite, and a reader of ADR 0008 alone learns that the guard it installs cannot be assigned away.
