---
title: Stop forwarding revm's validation-error text as eth_call return data, so the two engines answer a refused transfer identically
slug: stop-forwarding-revms-validation-error-text-as-eth-call-return-data
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

A value-bearing `eth_call` the sender cannot afford fails on BOTH engines, which is correct and is asserted by the conformance battery. What the two engines hand back with that failure is NOT the same, and this is a live divergence on an admitted fork.

`revm-wasm` puts the TEXT of a validation error into `outcome.returnData`, and `packages/embedded-eth-node/src/revm.ts` passes `outcome.returnData` through verbatim, so `node.ts` throws `RpcError(3, 'execution reverted', '0x5472616e…')` whose data decodes to the ASCII of `Transaction(LackOfFundForMaxFee { fee: 1, balance: 0 })`. The default `@ethereumjs/evm` engine returns `0x` for the identical call. Measured while building `value-bearing-conformance-steps-assert-the-failure-shape`; recorded in `work/notes/observations/revm-validation-errors-surface-their-message-as-eth-call-return-data.md`.

**Why it is worth fixing rather than documenting.** The `data` field of an `execution reverted` error has ONE meaning to a client: it is the callee's revert payload. viem will try to decode it as a revert reason, and `Transaction(LackOfFund…)` is not one. So the node is not merely verbose here, it is putting a non-answer where an answer is expected, and it is doing so on ONE engine only. `revm-wasm-upgrade-honest-block-environment` shipped on the promise that no known engine divergence remained; this is one, found later, and it is the same class as the ones that change deleted: an engine-specific artifact leaking into a surface that is meant to be engine-independent.

**The shape to build, unless you can defend better.** Two halves, and the second is what stops this being a mere deletion:

1. On the read path in `src/revm.ts`, a VALIDATION failure (revm rejecting the transaction before execution) contributes NO return data. Execution failures are untouched: a callee that reverts with a reason must still deliver those bytes, on both engines, because that is a real answer. The distinction to key off is revm's own, not a string match on the message if the outcome carries a structural way to tell the two apart.
2. The engine's own explanation is not thrown away, it is moved somewhere it cannot be mistaken for callee bytes: the ERROR, not the data. The node's own honest-edge convention (`src/engine.ts`, the `stateMode` and hardfork refusals) is that a refusal says what happened and what to do about it, so a validation rejection that says `insufficient funds for transfer` and carries revm's detail in its MESSAGE is the shape that fits. Do not invent a new RPC error code without saying why.

**Do not weaken the bars this crosses.** `test/helpers/affordability.ts` currently TOLERATES the divergence: `isCalleeAnswer()` treats return data naming a shortfall of funds as engine text rather than a callee answer, and that tolerance exists solely because of this bug. When the bug is gone the tolerance should narrow or disappear, and the negative controls must still pass. Coordinate with `close-the-residual-holes-in-the-affordability-classification`, which is narrowing the same predicate for a different reason: whichever lands second inherits the other's shape.

## Acceptance criteria

- [ ] An unaffordable value-bearing `eth_call` returns the SAME error data on both engines (`0x`), asserted in the engine-against-engine checks rather than only described.
- [ ] A callee that reverts WITH a reason still delivers its bytes on both engines, asserted, so the fix does not swallow real revert payloads.
- [ ] revm's own explanation of the rejection survives somewhere a caller can read it, in the error rather than in the data, following the repo's existing honest-edge voice (say what happened and what to do).
- [ ] The tolerance in `test/helpers/affordability.ts` that exists only for this divergence is narrowed or removed, and the value-bearing bars still hold: the wei-exact boundary, the no-callee-answer requirement, the per-engine vocabulary at the seam, and both conformance specs asserting the step by label.
- [ ] `work/notes/observations/revm-validation-errors-surface-their-message-as-eth-call-return-data.md` is discharged (deleted) in the same change, since the artifact then carries its signal.
- [ ] A changeset, because this changes published behaviour on the `embedded-eth-node/revm` subpath.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None.

## Prompt

> Goal: remove the last known behavioural divergence between the revm read engine and the default engine on the forks revm admits. An unaffordable `eth_call` fails on both, and only revm attaches its internal error text where a client expects the callee's revert payload.
>
> Read `work/notes/observations/revm-validation-errors-surface-their-message-as-eth-call-return-data.md`, the `returnData` handling in `packages/embedded-eth-node/src/revm.ts`, how `node.ts` turns an engine failure into `RpcError(3, 'execution reverted', data)`, and `test/helpers/affordability.ts` (which tolerates the divergence today, deliberately and with a pointer here).
>
> MEASURE BEFORE YOU CHANGE ANYTHING. Establish how a validation rejection and an execution revert differ in what revm hands back, and key the fix off that difference. A message-substring test is the fallback, not the design, and if it IS the only way, say so in the decisions and at the code site.
>
> DO NOT SWALLOW REAL REVERT DATA. A contract that reverts with a reason must still deliver those bytes on both engines; that is an answer, not an artifact.
>
> DO NOT THROW AWAY THE ENGINE'S EXPLANATION. Move it into the error's message, where it cannot be decoded as a contract's revert reason.
>
> Done means: the same call returns the same error data on both engines, a real revert still returns its own bytes, and the affordability bars no longer need a tolerance for this.
