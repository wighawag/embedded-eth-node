---
title: Close the residual holes in the affordability classification, and stop the value-bearing bars hard-coding the node's fork
slug: close-the-residual-holes-in-the-affordability-classification
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

`value-bearing-conformance-steps-assert-the-failure-shape` replaced the bare `catch` in both value-bearing bars with a real classification (`packages/embedded-eth-node/test/helpers/affordability.ts`), and it works: the negative cases now demand an ENGINE rejection carrying no callee answer, the rejection is pinned to the wei at `balance + 1`, and two negative controls are ISSUED so the step's ability to go red is demonstrated rather than claimed. Gate 2 approved it and raised four residual findings, none blocking, all of the same family: the classification is much tighter than it was and is still wider than the sentence it names. This task closes them together, because they are one seam and two of them are the same fork-pinning assumption twice.

**1. RE-SCOPED 2026-08-10 by the conductor: the tolerance this item asked you to BOUND no longer exists, and its hole is already closed. Do NOT go looking for it.** This item originally read: `isCalleeAnswer()` returns false for any return data matching `namesLackOfFunds()`, a deliberate but unbounded tolerance that existed solely because `revm-wasm` echoed its validation-error text as `returnData`, so a contract free to revert with exactly `insufficient funds` would have been misclassified as an affordability rejection.

`stop-forwarding-revms-validation-error-text-as-eth-call-return-data` has since landed and REMOVED the cause: the revm engine now drops a validation error's return data entirely (keyed off revm's own `outcome.status === 'validation-error'`, a structural test rather than a message match) and moves the explanation to the seam result's `error`. With nothing left to tolerate, `isCalleeAnswer()` was reduced to a pure emptiness test, `asText(data) !== ''`. So the misclassification this item names is closed STRUCTURALLY, not by a narrower vocabulary: the predicate contains no vocabulary at all, and no callee revert string, `insufficient funds` included, can imitate its way past it. `namesLackOfFunds()` survives, correctly, for its other job: the per-engine VOCABULARY check on the engine's ERROR at the seam.

What is left of this item is therefore small and is a decision, not a narrowing: verify the above still holds when you build, then decide whether a REGRESSION control is worth issuing, one that reverts with `insufficient funds` and asserts it classifies as a callee answer. It is close to vacuous against an emptiness test, and its real value would be catching a future re-introduction of a vocabulary tolerance. Record the answer where the controls are defined. If the premise above has itself drifted again, say so rather than building on it.

**2. Code 3 with EMPTY return data still classifies as `REJECTED`.** So a callee that reverts with no data at all satisfies a negative case. The issued control covers revert-WITH-data only. Note this is partly covered already: an unrelated failure that reaches every case would also fail the `value == balance` POSITIVE case, and the wei-exact boundary is what actually names affordability. Decide whether a third control (a bare `REVERT 0, 0` callee) is worth issuing or whether the boundary is sufficient cover, and record the answer where the controls are defined rather than leaving it to be re-derived.

**3. The seam probe hand-pins `cancun`.** `valueReadAtSeam` in `test/helpers/revm-engine.ts` builds its engines outside `createNode()` and constructs a `Common` at hardfork `cancun`, with a comment claiming it is "the fork the node pins". Those are two independent statements today and the comment asserts they are one. If the node's pinned fork ever moves, the probe silently measures a different fork than the node it claims to mirror, which is precisely the drift `src/intrinsic-gas.ts` takes the node's `Common` to avoid. Derive the fork from the node under test (or assert the two agree) so the claim cannot go stale silently.

**4. The negative-control bytecode requires Shanghai.** `REVERT_WITH_REASON_CODE = 0x60ff5f5360015ffd` uses `PUSH0` (`0x5f`), so conformance step 14 now silently depends on the battery being Shanghai or later. It is `cancun`-pinned today so nothing is wrong, but `berlin`, `london` and `paris` were just re-admitted to the revm engine, and the day anything runs the battery per-fork this control becomes an invalid opcode and misreports as a failure of the thing under test. A `PUSH0`-free encoding costs one byte of stack juggling and removes the dependency.

## Acceptance criteria

- [ ] It is confirmed against the code that a callee revert reason naming both a lack and funds (e.g. `insufficient funds`) already classifies as a CALLEE ANSWER, and whether that warrants its own regression control is decided explicitly, with the reasoning recorded where the controls are defined.
- [ ] Whether a bare `REVERT 0, 0` callee needs its own negative control is decided explicitly, with the reasoning recorded at the controls; if it does, it is issued.
- [ ] The seam probe's fork is derived from (or asserted equal to) the fork the node under test actually pins, so the comment cannot become false silently.
- [ ] The negative-control bytecode runs on every fork the revm engine admits (`berlin` upward), or the battery's fork requirement is asserted where the control is defined.
- [ ] The four bars this touches still hold: the wei-exact boundary, the no-callee-answer requirement, the per-engine vocabulary (`insufficient balance` / `LackOfFundForMaxFee`), and both conformance specs asserting the step by label.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None. It refines a step that has already landed.

## Prompt

> Goal: the affordability classification is now good enough to go red for the right reason, and still has three narrow ways to go GREEN for a wrong one, plus a fork assumption written twice as if it were checked once. Close them together.
>
> Read `packages/embedded-eth-node/test/helpers/affordability.ts` end to end (its header is the argument), then step 14 of `test/helpers/conformance.ts` and the `valueCases` / `valueReadAtSeam` sections of `test/helpers/revm-engine.ts`.
>
> KEEP THE PROPERTY THE BARS HAVE. They assert an ABSOLUTE succeed/fail statement per sender, not cross-engine agreement, because two engines can agree while both are wrong. Do not weaken any of that while narrowing the tolerances, and do not assert one engine's exact message on the other.
>
> ITEM 1 IS RE-SCOPED and its old instruction is REVERSED. Earlier text here said the `isCalleeAnswer` tolerance existed for a real reason and must not simply be deleted. That is no longer true: `stop-forwarding-revms-validation-error-text-as-eth-call-return-data` removed the cause (revm no longer forwards validation-error text as return data), the tolerance was deleted with it, and the predicate is now a pure emptiness test. The observation note both this task and that one used to cite has been DISCHARGED and is gone; do not go looking for it. Read the current `isCalleeAnswer` and the header of `test/helpers/affordability.ts` for the state that actually holds.
>
> Done means: the fork assumptions are checked rather than asserted, the negative-control bytecode does not silently require Shanghai, and item 1's decision is recorded. A contract that reverts saying `insufficient funds` already cannot pass as an unaffordable transfer; confirm that rather than re-implementing it.
