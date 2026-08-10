---
title: Close the three loose edges of the block gas limit refusal, including the knob it names on a blockEnv node
slug: close-the-edges-of-the-block-gas-limit-refusal
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`the-block-gas-limit-relaxation-diverges-by-engine` removed the divergence: `skipBlockGasLimitValidation` is gone, the node itself refuses an over-limit transaction at submit ahead of either engine, and the refusal names the numbers and the knob. Gate 2 approved it and raised three non-blocking edges of that same refusal, which this task closes together because they are one behaviour's loose ends rather than three unrelated chores.

**1. The refusal names a knob that does nothing on a `blockEnv` node.** The mined block's limit resolves as `blockEnv?.gasLimit ?? blockGasLimit`, so `blockEnv` WINS when it is set. The refusal's one actionable instruction is nonetheless `createNode({blockGasLimit: Xn})`, which a node created with an explicit `blockEnv.gasLimit` would ignore, so the message sends such a consumer to turn a knob that cannot move the limit they hit. `blockEnv.gasLimit` is mentioned only in a trailing clause, as a statement about the default rather than as the knob to turn. The refusal must name whichever knob actually governs the limit it just enforced, and no path should be left untested.

**2. ADR 0006 still justifies the flag this change deleted.** `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md` says `@ethereumjs/vm`'s two `skip*Validation` flags stayed INSIDE the default engine, and argues for it with revm's refusal to combine its equivalent relaxation with committing. That reasoning is now the reasoning for a flag that no longer exists, and only one of the two flags remains. ADR 0006 is a live, actively amended doc that already carries dated amendments for this seam, and the same change filed an observation note for the analogous stale phrasing in ADR 0008, so the sweep is incomplete by its own standard. Per this repo's rule an ADR takes a DATED AMENDMENT, never a rewrite of what it originally said.

**3. The equality boundary is unasserted.** The claim that a transaction passing the node's check also passes the engine's rests on three separate comparisons agreeing: the node's `gasLimit <= minedBlockGasLimit`, `runTx`'s block-header comparison, and revm's `CallerGasLimitMoreThanBlock` (revm receives `tx.gasLimit` raw on the transact path, with no intrinsic added, unlike the read path). The battery exercises 40M vs 30M, 40M vs 60M and 60M+1 vs 60M, but never the case where the transaction's gas limit EQUALS the block limit. That is the single point where an off-by-one, or a future intrinsic add on the transact path, would silently reopen a cross-engine divergence of exactly the class the parent task existed to remove.

## Acceptance criteria

- [ ] On a node created with an explicit `blockEnv.gasLimit`, the refusal names `blockEnv.gasLimit` as the knob that governs the limit it enforced; on a node without one it still names `blockGasLimit`. The message never instructs a consumer to turn a knob that their node ignores.
- [ ] A test covers the `blockEnv.gasLimit` refusal path on BOTH engines, asserting the node's own answer per engine (not a node-versus-reference diff).
- [ ] A transaction whose gas limit EQUALS the block gas limit is ACCEPTED and mined, asserted on BOTH engines and both state modes, so the equality boundary is pinned against an off-by-one in any of the three comparisons.
- [ ] ADR 0006 carries a DATED AMENDMENT recording that `skipBlockGasLimitValidation` was removed by `the-block-gas-limit-relaxation-diverges-by-engine`, that only `skipBalance` remains inside the default engine, and that the block gas limit is now enforced by the node ahead of both engines. The original text is amended, never rewritten.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] If the refusal's prose grows the default entry point's bundle, the baseline in `packages/benchmarks/test/evm.spec.ts` is re-pinned in THIS change with the reason in the comment block above it, per that assertion's own instruction. It is never raised silently.
- [ ] A changeset only if consumer-visible behaviour changes (the message's wording on a `blockEnv` node does change what a consumer reads).

## Blocked by

- None — can start immediately.

## Prompt

> Goal: finish the block gas limit refusal that `the-block-gas-limit-relaxation-diverges-by-engine` introduced, closing three edges Gate 2 raised against it. The parent task is in `work/tasks/done/`; read it and the refusal it built before changing anything.
>
> FIRST, check this task against current reality: it was written on 2026-08-10 and may have DRIFTED. Confirm all three edges still exist before acting on them, in particular that the refusal still names `createNode({blockGasLimit: ...})` unconditionally and that ADR 0006 still describes two `skip*Validation` flags living inside the default engine.
>
> The node, not the engine, answers this refusal, and that is deliberate: the block is the node's half of the engine seam, so answering there is what makes the refusal identical on every engine by construction rather than by two error strings that happen to match. Do not move it into the engines.
>
> On edge 1, the fix is to name the knob that actually governs the limit that was enforced. Resolve which one that is from the same precedence the limit itself resolves through, so the message cannot drift from the behaviour again.
>
> On edge 3, the important case is EQUALITY, not another over-limit case. A transaction whose gas limit is exactly the block gas limit must be mined, on both engines, and the test should make plain that it is pinning the boundary where three independent comparisons must agree. Note the transact path hands revm `tx.gasLimit` raw with no intrinsic added, unlike the read path, which is why the boundary is worth pinning rather than assuming.
>
> On edge 2, this repo's convention is that CHANGELOG.md is history and is never rewritten, and an ADR takes a DATED AMENDMENT rather than an edit to what it originally said. Follow that: append an amendment, leave the original prose intact.
>
> RECORD non-obvious in-scope decisions you make while building, durably and linked from the done record, per the repo's decision-recording rule.
