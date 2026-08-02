---
title: Implement the EIP-7623 calldata floor for Prague, or refuse the hardforks we cannot cost
slug: prague-intrinsic-gas-floor-or-refuse
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

Close a gap the Gate-2 review of `revm-engine-subpath` found: the revm engine's `SPEC_BY_HARDFORK` admits `PRAGUE` and `OSAKA`, but the shared `src/intrinsic-gas.ts` implements only the pre-Prague intrinsic-gas formula. It has no EIP-7623 calldata floor, which revm DOES enforce (`GasFloorMoreThanGasLimit` is in the wasm's error set).

So on a Prague-or-later hardfork the node can under-charge intrinsic gas relative to what the engine will enforce, and `eth_estimateGas` can return a number that the engine itself would reject. That is the exact shape of failure the node's estimate exists to prevent: viem takes the estimate as a gas LIMIT and the real transaction fails.

Two honest resolutions, and this task picks one:

**Implement it.** Add the EIP-7623 floor to `intrinsic-gas.ts`, hardfork-gated so pre-Prague behaviour is untouched, and make `eth_estimateGas` return `max(execution + intrinsic, floor)`.

**Or refuse.** If the node does not intend to support Prague yet, `SPEC_BY_HARDFORK` should not admit it: refuse the hardfork loudly at construction, the way the engine already refuses `stateMode:'trie'` and an unknown hardfork. Admitting a hardfork we cannot cost correctly is the silent-wrong-answer case the honest-edge convention exists to prevent.

Prefer implementing it if the formula is small and testable; prefer refusing if it needs more than that, because a documented refusal beats a wrong number.

## Acceptance criteria

- [ ] The node's intrinsic-gas cost and the engine's enforcement AGREE for every hardfork the engine admits. Whichever resolution is chosen, that is the invariant.
- [ ] If implemented: the EIP-7623 floor is applied for Prague and later and NOT before, with a test on both sides of the boundary, including a calldata-heavy transaction where the floor is what binds.
- [ ] If refused: `SPEC_BY_HARDFORK` no longer admits a hardfork the node cannot cost, and the refusal names the reason and where to look, in the style of the existing engine refusals.
- [ ] `eth_estimateGas` on a calldata-heavy call cannot return a value the engine would reject with `GasFloorMoreThanGasLimit`. Asserted directly, since this is the user-visible failure.
- [ ] The default hardfork path (Cancun) is demonstrably unchanged.
- [ ] Tests cover the new behaviour (mirror the repo's existing test style).

## Blocked by

- None.

## Prompt

> Goal: make the node's intrinsic-gas arithmetic and the engine's enforcement agree on every hardfork the engine will accept, or stop accepting the ones where they cannot.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): read `src/intrinsic-gas.ts`, the `SPEC_BY_HARDFORK` map in `src/revm.ts`, and the `eth_estimateGas` case in `src/node.ts`. If the floor already exists, or the hardfork list already excludes Prague, close this rather than re-doing it.
>
> Read `CONTEXT.md` for *honest edge*, and `docs/adr/0004-no-account-or-signing-methods.md` for the convention this extends: a thing we cannot do correctly FAILS LOUDLY rather than returning a plausible number.
>
> THE FAILURE MODE, so you weight it correctly. `eth_estimateGas` is not decoration: viem takes the returned value and uses it as the transaction's gas LIMIT. An estimate below what the engine will enforce therefore does not produce a warning, it produces a transaction that runs out of gas in the user's face, and the node looks broken. The same asymmetry already motivated the EIP-2929 warm/access reset, which has a long comment at its site explaining exactly this; read it before deciding, because the reasoning transfers wholesale.
>
> EIP-7623 in one line: post-Prague, a transaction pays at least a floor derived from its calldata (tokens counted as 4 per zero byte and 16 per non-zero, times a per-token floor cost), so calldata-heavy, computation-light transactions are charged more than the old formula gave. The node currently computes only the old formula.
>
> Note the intrinsic-gas helper is SHARED: `src/intrinsic-gas.ts` was extracted so the node and the revm engine agree by construction. Whatever you change there changes both, which is the point. Do not fork it.
>
> Seams to test at: the conformance differential already asserts estimateGas exactness against a `runTx` reference, including the EIP-3860 initcode case, which is the closest existing analogue of a hardfork-gated intrinsic cost. Follow that shape.
>
> Done means: there is no hardfork the engine accepts where the node's estimate can be rejected by the engine that produced it.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
