---
title: ADR 0008's clause (b) is stated generally but enforced for EIP-3860 only, so a fork below Istanbul would pass it while being mis-costed
slug: clause-b-covers-only-eip-3860-not-the-rest-of-the-formula
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

ADR 0008's amendment added clause (b) to the admission rule: what the node computes about a transaction must be **what the PROTOCOL charges at that fork**, judged by a witness that is neither the node nor revm. It then says clause (b) "is now enforced where clause (a) already was". The enforcement in `test/revm-engine.spec.ts` checks exactly ONE term: that `@ethereumjs/common` reports EIP-3860 active for every admitted fork, and that revm's measured initcode charge is 2 gas per word.

But `intrinsicGas()` hardcodes more than the initcode term. It charges 16 gas per non-zero calldata byte and 4 per zero byte (EIP-2028, **Istanbul**), and the 21000 / 32000 bases. So a fork admitted BELOW Istanbul would satisfy every clause-(b) assertion the test makes while being mis-costed on calldata, which is the same hole the amendment was written to close, one term further down. The general claim in the ADR is therefore wider than the check behind it.

Impact today is low, and that is why this is a follow-up rather than a fix in the original change: re-admission requires a deliberate edit to the table, and any fork present in NEITHER table is already refused by the "no revm spec is known" guard. So nothing is currently mis-costed; what is wrong is that the ADR promises a general guarantee the test does not deliver, and the next person to re-admit a fork is the one who pays for the gap. (Raised by the Gate-2 review of `intrinsic-gas-charges-eip-3860-on-forks-that-predate-it`.)

> **UPDATED 2026-08-02**, after `upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks`. Three things this task said have moved:
>
> - The admitted set is now `berlin`, `london`, `paris`, `shanghai`, `cancun` (not `shanghai` + `cancun`), and `paris` is no longer available as a counter-example: it is admitted. A widened check needs a counter-example from the still-refused set (`prague`, `osaka`) or a genuinely pre-Istanbul spec.
> - Clause (b) is now enforced more strongly than when this was written: for the EIP-3860 term the test measures three independent readings per admitted fork (`@ethereumjs/common`'s activation table, revm's measured per-word charge, and the node's own formula measured the same way), and asserts the admitted set SPANS the EIP-3860 boundary so those readings cannot pass vacuously. That is the shape to copy for the remaining terms; it is not a reason to consider the gap closed.
> - **This task got MORE urgent, not less.** The fork gate makes re-admission look cheap and routine, and `intrinsicGas()`'s header used to warn that its true-for range "has an end at BOTH sides". That lower bound was dropped when the gate landed, so the file no longer tells the next author that the 16/4 calldata costs are EIP-2028 (Istanbul) and fork-dependent too. **Restoring that clause to the header is now part of this task**, whichever resolution is chosen.



Two honest resolutions, and this task picks one:

**Widen the check.** Assert clause (b) for every EIP the shared formula bakes in, not just EIP-3860: at minimum EIP-2028's calldata costs, and state the bases. The natural shape is the one already there: for each admitted fork, ask `@ethereumjs/common` whether the EIP is active, and measure what revm actually charges by delta, so the assertion keeps testing reality rather than restating a constant.

**Or narrow the claim.** If widening is disproportionate, say plainly in ADR 0008 that the automated part of clause (b) covers the EIP-3860 term specifically, and that a re-admitter owes the rest of the formula a manual check, with the terms LISTED so the obligation is concrete rather than a gesture. A named, bounded obligation is honest; an unbounded general claim backed by one assertion is not.

Prefer widening if the assertions stay cheap and readable, since a check that runs beats a paragraph nobody re-reads. Prefer narrowing if widening would need machinery out of proportion to a guard that only fires on a deliberate table edit.

## Acceptance criteria

- [ ] Either every EIP hardcoded in `src/intrinsic-gas.ts` is covered by a clause-(b) assertion for each admitted fork, or ADR 0008 states exactly which terms the automated check covers and lists the ones left to a re-admitter.
- [ ] Whichever is chosen, ADR 0008's wording and the test agree: no general claim survives that the test does not back.
- [ ] If widening: the assertions follow the existing shape (`@ethereumjs/common` for activation, a measured value for what revm charges) rather than restating constants the formula already contains, and a counter-example is asserted from the still-refused set or a pre-Istanbul spec, the way the EIP-3860 check spans its own boundary.
- [ ] `src/intrinsic-gas.ts`'s header again states the LOWER bound of the range its formula is true for (the 16/4 calldata costs are EIP-2028, Istanbul), which was lost when the EIP-3860 gate landed.
- [ ] The admitted set is unchanged (`berlin`, `london`, `paris`, `shanghai`, `cancun`); this task does not re-open which forks are served.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None.

## Prompt

> Goal: close the gap between what ADR 0008's clause (b) PROMISES and what the test actually CHECKS.
>
> Read the amendment section of `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`, the clause-(b) assertions in `packages/embedded-eth-node/test/revm-engine.spec.ts` and their helper in `test/helpers/revm-engine.ts`, and `src/intrinsic-gas.ts` for the full list of terms the formula bakes in.
>
> THE POINT IS THE MISMATCH, not a live bug. Nothing is mis-costed today: every admitted fork (berlin, london, paris, shanghai, cancun) is at or above Istanbul, so the calldata term is correct for all of them. What is wrong is that the ADR states clause (b) generally while one EIP is enforced, so a future re-admission below Istanbul would sail through a check that looks general and is not. Fix the mismatch in whichever direction you can defend, and make the ADR and the test say the SAME thing.
>
> If you widen the check, keep its existing virtue: it asks `@ethereumjs/common` for activation and MEASURES what revm charges, so it tests reality instead of restating the constant it is meant to guard. Make it load-bearing rather than decorative the way the EIP-3860 check is: that one asserts the admitted set SPANS the boundary, so the readings cannot all pass simply because every admitted fork happens to charge the term.
>
> Do NOT change which forks are admitted, and do not re-open the refusals.
>
> Done means: a reader of ADR 0008 can trust clause (b) to mean exactly what the build enforces, and a future re-admitter is told precisely what they still owe.
