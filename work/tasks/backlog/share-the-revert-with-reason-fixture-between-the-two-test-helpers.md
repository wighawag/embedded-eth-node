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

Worth carrying while you are there: that bytecode uses `PUSH0` (`0x5f`), so it silently requires Shanghai or later. `close-the-residual-holes-in-the-affordability-classification` owns making it fork-portable (its item 4). If that task has already landed, share whatever encoding it settled on rather than re-introducing the `PUSH0` form; if it has not, do not pre-empt its decision, just make sure there is ONE copy for it to fix instead of two.

## Acceptance criteria

- [ ] `REVERT_WITH_REASON_ADDR` and `REVERT_WITH_REASON_CODE` are defined in exactly ONE place and imported by both helpers; no verbatim duplicate remains.
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
