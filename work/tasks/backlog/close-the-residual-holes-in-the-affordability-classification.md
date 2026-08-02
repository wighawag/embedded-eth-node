---
title: Close the residual holes in the affordability classification, and stop the value-bearing bars hard-coding the node's fork
slug: close-the-residual-holes-in-the-affordability-classification
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

`value-bearing-conformance-steps-assert-the-failure-shape` replaced the bare `catch` in both value-bearing bars with a real classification (`packages/embedded-eth-node/test/helpers/affordability.ts`), and it works: the negative cases now demand an ENGINE rejection carrying no callee answer, the rejection is pinned to the wei at `balance + 1`, and two negative controls are ISSUED so the step's ability to go red is demonstrated rather than claimed. Gate 2 approved it and raised four residual findings, none blocking, all of the same family: the classification is much tighter than it was and is still wider than the sentence it names. This task closes them together, because they are one seam and two of them are the same fork-pinning assumption twice.

**1. A revert reason that names BOTH a lack and funds is accepted as an affordability rejection.** `isCalleeAnswer()` returns false for any return data matching `namesLackOfFunds()`, which exists so revm's own `Transaction(LackOfFundForMaxFee { .. })` text (echoed as `returnData`, see `work/notes/observations/revm-validation-errors-surface-their-message-as-eth-call-return-data.md`) is not mistaken for the callee's answer. The near-miss controls in `revm-engine.ts` cover `ERC20: transfer amount exceeds balance` and `ERC20: insufficient allowance`, and both correctly classify as callee answers because neither matches both halves of the vocabulary. A reason saying `insufficient funds` does match both, and a contract is free to revert with exactly that. The tolerance is deliberate and it is currently unbounded; bound it. The obvious lever is that revm's text is structurally recognisable (`Transaction(` + the variant name) where a Solidity revert string is not, so the tolerance can name the ENGINE's shape rather than a vocabulary any callee may borrow.

**2. Code 3 with EMPTY return data still classifies as `REJECTED`.** So a callee that reverts with no data at all satisfies a negative case. The issued control covers revert-WITH-data only. Note this is partly covered already: an unrelated failure that reaches every case would also fail the `value == balance` POSITIVE case, and the wei-exact boundary is what actually names affordability. Decide whether a third control (a bare `REVERT 0, 0` callee) is worth issuing or whether the boundary is sufficient cover, and record the answer where the controls are defined rather than leaving it to be re-derived.

**3. The seam probe hand-pins `cancun`.** `valueReadAtSeam` in `test/helpers/revm-engine.ts` builds its engines outside `createNode()` and constructs a `Common` at hardfork `cancun`, with a comment claiming it is "the fork the node pins". Those are two independent statements today and the comment asserts they are one. If the node's pinned fork ever moves, the probe silently measures a different fork than the node it claims to mirror, which is precisely the drift `src/intrinsic-gas.ts` takes the node's `Common` to avoid. Derive the fork from the node under test (or assert the two agree) so the claim cannot go stale silently.

**4. The negative-control bytecode requires Shanghai.** `REVERT_WITH_REASON_CODE = 0x60ff5f5360015ffd` uses `PUSH0` (`0x5f`), so conformance step 14 now silently depends on the battery being Shanghai or later. It is `cancun`-pinned today so nothing is wrong, but `berlin`, `london` and `paris` were just re-admitted to the revm engine, and the day anything runs the battery per-fork this control becomes an invalid opcode and misreports as a failure of the thing under test. A `PUSH0`-free encoding costs one byte of stack juggling and removes the dependency.

## Acceptance criteria

- [ ] A callee revert reason that names both a lack and funds (e.g. `insufficient funds`) classifies as a CALLEE ANSWER, not as an affordability rejection, and is issued as a control so the distinction is demonstrated.
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
> The tolerance in item 1 exists for a real reason and must not simply be deleted: revm echoes its validation-error text as `returnData` (`work/notes/observations/revm-validation-errors-surface-their-message-as-eth-call-return-data.md`). Narrow it to something a callee cannot imitate rather than removing it.
>
> Done means: a contract that reverts saying `insufficient funds` cannot pass as an unaffordable transfer, and no bar silently assumes a fork it has not checked.
