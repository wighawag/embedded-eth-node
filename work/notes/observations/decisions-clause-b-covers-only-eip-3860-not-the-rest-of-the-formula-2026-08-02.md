---
title: Decisions taken while building 'clause-b-covers-only-eip-3860-not-the-rest-of-the-formula'
date: 2026-08-02
status: open
decisionsFor: clause-b-covers-only-eip-3860-not-the-rest-of-the-formula
---

# Decisions taken while building `clause-b-covers-only-eip-3860-not-the-rest-of-the-formula`

The done record's `## Decisions` block, kept here because the task body is moved byte-identical by the runner. Each entry: what was chosen, why, what was rejected, and what it touches. Ratify or reverse.

Entry condition first: the task's premise was re-measured before anything was written, by the new probe (`docs/spikes/clause-b-covers-only-eip-3860-not-the-rest-of-the-formula/probe-intrinsic-terms.mjs`). It holds exactly as stated: all five terms agree at all five admitted forks, and the single disagreement in the whole table is `petersburg/non-zero calldata byte`, where the node charges 16 against the protocol's and revm's 68. So this is a mismatch between the ADR's promise and the check, not a live mis-costing.

## 1. WIDEN the check rather than narrow the claim

**Chosen:** the first of the task's two resolutions. `test/revm-engine.spec.ts` now asserts clause (b) for every term `intrinsicGas()` bakes in (transaction base, non-zero calldata byte, zero calldata byte, creation base, initcode word), three readings each, at every admitted fork; ADR 0008 gains a third amendment stating that scope exactly.

**Why:** the task said to prefer widening if the assertions stay cheap and readable, and they did. The terms are defined ONCE as arithmetic over a party's charge for a probe shape (`INTRINSIC_TERMS` in `test/helpers/revm-engine.ts`) and the same definition is then evaluated against the protocol, against revm and against the node, so five terms cost one table and three one-line adapters rather than fifteen assertions. Nothing in the widening restates a constant the formula contains: even the initcode-word row subtracts the MEASURED zero-byte cost rather than the number 4. A narrowed claim would have been honest but inert, and the next re-admitter is exactly the reader least likely to re-read a paragraph.

**Rejected:** narrowing ADR 0008 to "the automated part covers EIP-3860, here is the list you owe manually". Kept in spirit anyway: the third amendment carries that list, because the widened check still cannot cover the two ends of the range (see 3 below).

**Touches:** `test/revm-engine.spec.ts`, `test/helpers/revm-engine.ts`, `docs/adr/0008-*.md`, and any future task that adds a term to `intrinsicGas()` — it now also has to add a row to `INTRINSIC_TERMS`, which the asserted `intrinsicTermNames` list makes impossible to forget silently.

## 2. The protocol witness for the non-EIP-3860 terms is `@ethereumjs/tx`'s intrinsic-gas arithmetic, not `isActivatedEIP`

**Chosen:** each term's protocol reading comes from `createLegacyTx({...}, {common}).getIntrinsicGas()` at that fork. The EIP-3860 term additionally keeps its `common.isActivatedEIP(3860)` reading, which the existing assertion already used.

**Why:** the activation reading does not exist for the other terms. Measured: `common.isActivatedEIP(2028)` is `false` at every fork including Cancun — ethereumjs models EIP-2028 as a hardfork PARAM (`txDataNonZeroGas`, in `@ethereumjs/tx`'s `paramsTx`), not as an activatable EIP, so asking the activation table about it would have produced a reading that is uniformly false and asserts nothing. `getIntrinsicGas()` is the witness that does exist, it reads those params underneath, and it is strictly stronger than a table lookup: it is the code `@ethereumjs/vm`'s `runTx` charges a transaction actually mined on this node, so a disagreement means the read path disagrees with the node's own write path. The task's criterion asks for `@ethereumjs/common` "for activation" and a measured value for revm; this keeps the second half exactly and satisfies the first through the arithmetic that consults `Common` rather than through a lookup that would be vacuous.

**Rejected:** (a) `common.param('txDataNonZeroGas')` directly — it is the same table one layer lower, but it throws unless the tx params have been registered on that `Common` (`Missing parameter value for txDataNonZeroGas`), i.e. it only works via the very package used instead; (b) hardcoding 68/16 as the expected pre/post-Istanbul values — that restates the constant the check exists to guard, which is what the task explicitly ruled out.

**Touches:** `test/helpers/revm-engine.ts`, the third amendment's description of the witness, and the spike probe. Anyone adding a term whose fork-dependence IS modelled as an EIP activation should add that reading too, as the EIP-3860 row does.

## 3. EIP-2028 is NOT fork-gated in `src/intrinsic-gas.ts`; the boundary is measured instead

**Chosen:** the 16/4 calldata costs stay hardcoded. The header now states the lower bound (Istanbul) and says why the gate is absent, and the suite measures that boundary from both sides (`petersburg` and `istanbul`) on specs the engine does not admit.

**Why:** a gate would be arithmetic nothing can reach. `createNode()` pins Cancun, the engine admits `berlin`..`cancun`, and any fork in neither of `src/revm.ts`'s tables is refused by the "no revm spec is known" guard — so no code path can evaluate a pre-Istanbul branch, and the repo has rejected unreachable fork-gated arithmetic twice already on that exact argument (the EIP-7623 floor, and the first amendment's original reasoning). Adding one would also be a change to shared production arithmetic that this task's acceptance criteria do not ask for, in a file whose whole value is that two callers share one answer. The measurement is the honest substitute: it shows the formula's error at the boundary (52 gas per non-zero byte, in the UNDER-charging direction) instead of asserting that a branch nobody runs is correct.

**Why it is recorded:** it is a decision NOT to make the arithmetic fork-correct, taken in the file a future re-admitter will edit, and the opposite choice is defensible if a pre-Istanbul fork is ever wanted. Both the header of `src/intrinsic-gas.ts` and `REVM_SPEC_BY_HARDFORK`'s doc in `src/revm.ts` now say what that person owes, in the two places they would touch.

**Rejected:** (a) gating the term on `common` now, mirroring EIP-3860's gate — unreachable, and it would have to be measured against a fork the engine refuses to admit, so the test would grow a branch for production code nothing calls; (b) saying nothing and leaving the hardcoded 16 to be discovered — that is the drift this task exists to end.

**Touches:** `src/intrinsic-gas.ts` (header + one comment at the loop), `src/revm.ts` (`REVM_SPEC_BY_HARDFORK`'s doc), and `readmit-refused-hardforks-once-the-node-can-cost-them` in `work/tasks/backlog/` if anyone ever extends re-admission DOWNWARD rather than upward.

## 4. The counter-example is `petersburg`/`istanbul`, not one of the still-refused forks

**Chosen:** the load-bearing counter-example for the EIP-2028 term is the pair of specs either side of Istanbul, neither of which is in either table.

**Why:** the task's criterion offered "the still-refused set (`prague`, `osaka`) or a genuinely pre-Istanbul spec". The refused set is the WRONG side: `prague` and `osaka` sit ABOVE the admitted range, so they witness clause (a)'s failure (they already do, and those assertions are untouched) and say nothing about the formula's lower bound. `istanbul` is included alongside `petersburg` deliberately: one shows where the formula starts being true and the other where it stops, so the bound the header claims is measured rather than asserted. Both are refused at construction, and that refusal is asserted in the same block, so the pair cannot be mistaken for an admitted fork.

**Rejected:** measuring only `petersburg` — it proves the disagreement but not that Istanbul is the exact boundary, which is the claim `src/intrinsic-gas.ts`'s restored header makes.

**Touches:** `test/revm-engine.spec.ts`, `test/helpers/revm-engine.ts`.

## 5. No changeset

**Chosen:** no `.changeset/` entry.

**Why:** the repo's convention (CONTEXT.md) requires one for a USER-FACING change, and nothing user-facing moves here: no API, no behaviour, no gas, no exported value. The only `src/` edits are comments. The precedents point the same way — the last test-only task (`value-bearing-conformance-steps-assert-the-failure-shape`, `cb4c780`) and the last docs-only ADR change (`750fbd5`) both landed without one, while every changeset in the repo's history describes an observable change.

**Touches:** the release stream. If the maintainer would rather see a `patch` for the shipped JSDoc (`src/` is in the package's `files`), it is a one-file addition.
