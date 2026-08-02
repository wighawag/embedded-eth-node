---
title: Make the value-bearing conformance steps assert the failure SHAPE, not merely that something threw
slug: value-bearing-conformance-steps-assert-the-failure-shape
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

The `value-bearing read affordability` step added by `revm-wasm-upgrade-honest-block-environment` classifies its negative cases with a bare `catch`: anything thrown counts as "failed". The step therefore proves "this call did not succeed", when what it NAMES is "this call was rejected because the sender could not afford the transfer".

Those are not the same statement, and the gap is load-bearing for a step that exists precisely to catch a silent-wrong-answer bug. A future param-validation refusal, an engine construction error, a typo'd address, or an RPC-shape change would each throw, be swallowed by the bare `catch`, and keep all three negative cases GREEN while the affordability rule they guard had stopped being exercised at all. A bar that cannot go red for the right reason is not a bar.

Tighten the classification so the negative cases keep proving what they name. The step is a differential, so the assertion must stay engine-agnostic: `@ethereumjs/evm` surfaces the insufficient balance through `_reduceSenderBalance` and the node turns it into `execution reverted`, while revm returns a `validation-error` carrying `LackOfFundForMaxFee` (both shapes are recorded in `docs/spikes/revm-wasm-upgrade-honest-block-environment/measurements.md`). Do not assert one engine's exact message on both; assert the property both must have.

Sites: the `catch` in step 14 of `packages/embedded-eth-node/test/helpers/conformance.ts`, and the `valueCases` loop in `packages/embedded-eth-node/test/helpers/revm-engine.ts`.

## Acceptance criteria

- [ ] The negative value-bearing cases assert something stronger than "threw": at minimum that the failure is an affordability rejection (its shape/message names insufficient funds on each engine's own terms) and that no return data was produced.
- [ ] An unrelated failure at the same call site (e.g. a param-validation refusal or a construction error) makes the step go RED rather than pass. Demonstrate this, at least by a comment recording how it was checked, ideally by a test-level proof.
- [ ] The assertion stays engine-agnostic: it must hold for `@ethereumjs/evm`'s `execution reverted` path and revm's `validation-error` / `LackOfFundForMaxFee` path without special-casing one engine's exact string.
- [ ] The positive cases (affordable value from a funded sender, zero value from an unfunded sender) still pass unchanged.
- [ ] Reference gas is untouched: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] Both conformance specs still assert the step runs by label, so it cannot silently stop running.

## Blocked by

- None. It refines a step that has already landed.

## Prompt

> Goal: a conformance step that says "the sender could not afford this transfer" must actually check that, not merely that the call did not succeed. Raised as a non-blocking nit by the Gate-2 review of `revm-wasm-upgrade-honest-block-environment`.
>
> Read step 14 in `packages/embedded-eth-node/test/helpers/conformance.ts`, the `valueCases` loop in `packages/embedded-eth-node/test/helpers/revm-engine.ts`, and `docs/spikes/revm-wasm-upgrade-honest-block-environment/measurements.md` for the two engines' actual failure shapes.
>
> THE HAZARD IS A FALSE GREEN, so fix it in the direction of "can this go red for the right reason". A bare `catch` makes every unrelated throw indistinguishable from the rejection under test, which means the step can keep passing long after it stopped exercising affordability at all.
>
> KEEP IT A DIFFERENTIAL. The two engines fail this differently by design: `@ethereumjs/evm` surfaces it as `execution reverted` via `_reduceSenderBalance`, revm as a `validation-error` carrying `LackOfFundForMaxFee`. Assert the property both must have, not one engine's string on both. Do NOT weaken the step to cross-engine equality alone: the absolute succeed/fail statement per sender is the point, because two engines can agree while both being wrong.
>
> Done means: an unrelated error at that call site turns the step red, and the affordability rejection still passes on both engines.
