---
title: Share the revert-with-reason fixture between the two test helpers instead of duplicating its bytecode
slug: share-the-revert-with-reason-fixture-between-the-two-test-helpers
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

`stop-forwarding-revms-validation-error-text-as-eth-call-return-data` needed a callee that reverts WITH a reason in a second place, and copied the fixture rather than sharing it. `REVERT_WITH_REASON_ADDR` and `REVERT_WITH_REASON_CODE` now exist verbatim in both `packages/embedded-eth-node/test/helpers/conformance.ts` and `packages/embedded-eth-node/test/helpers/revm-engine.ts`.

The trap is silent rather than loud. Both helpers assert on the payload the fixture produces (a single `0xff` byte). If one copy's bytecode is ever edited, the other helper keeps asserting the same expected payload against a fixture that no longer produces it, and the two stop describing the same thing without anything going red at the point of the edit. This repo already shares the affordability classification vocabulary through `test/helpers/affordability.ts`, so a shared home for test fixtures is an established pattern here rather than a new one.

Share the fixture from one home and have both helpers import it, so its bytecode and the payload it is expected to produce cannot drift apart.

**The encoding question is SETTLED (updated 2026-08-10).** `close-the-residual-holes-in-the-affordability-classification` has landed and made the fixture fork-portable: both copies now read `0x60ff60005360016000fd`, which uses `PUSH1 00` instead of `PUSH0` and so no longer silently requires Shanghai. Share THAT encoding; do not re-introduce a `PUSH0` form.

That task also added a per-fork control loop which executes the fixture at every hardfork the revm engine admits, and this is the second reason to share rather than merely tidy: the loop reads `revm-engine.ts`'s constant ONLY. The conformance battery's verbatim copy, and the newer funds-naming fixture, are asserted `PUSH0`-free by COMMENT alone and are never executed anywhere but the node's pinned fork. So today someone could revert the conformance copy to a `PUSH0` form, or add `PUSH0` to the funds-naming fixture, and the per-fork loop would not notice. Sharing one definition is what puts the fixtures that are ASSERTED portable and the fixture that is MEASURED portable behind the same bytes.

## Acceptance criteria

- [ ] `REVERT_WITH_REASON_ADDR` and `REVERT_WITH_REASON_CODE` are defined in exactly ONE place and imported by both helpers; no verbatim duplicate remains.
- [ ] The fixture the per-fork control loop EXECUTES is the same definition the conformance battery uses, so a fixture asserted `PUSH0`-free cannot drift away from the one actually measured per fork. Include the funds-naming fixture if it shares the same exposure.
- [ ] The expected payload the fixture produces is asserted against the shared definition, so editing the bytecode cannot leave a stale expectation behind in the other helper.
- [ ] The full battery still passes on both engines and both state modes, with the same steps asserted by label as before.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] No changeset: this is test-only and changes no published behaviour.

## Blocked by

- None — can start immediately. It does not conflict with `close-the-residual-holes-in-the-affordability-classification`, but if both are in flight, land that one first so this shares its final encoding.

## Prompt

> Goal: one definition of the revert-with-reason fixture, imported by both test helpers, instead of two copies that can silently stop describing the same contract.
>
> FIRST, check this task against current reality: it was written on 2026-08-10 and may have DRIFTED. Confirm both copies still exist and are still verbatim identical before moving anything; if one has already changed, that divergence is itself the finding and should be reported rather than quietly reconciled.
>
> Look at how `test/helpers/affordability.ts` already serves as a shared home for classification vocabulary used across helpers, and follow that pattern rather than inventing a new one. This is test-only work: no production source changes, no changeset.
>
> Done means one definition, both consumers importing it, the battery green on both engines and both state modes, and no expectation left asserting a payload against a fixture it no longer shares.
