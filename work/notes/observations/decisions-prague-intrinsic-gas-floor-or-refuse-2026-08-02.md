---
title: Decisions taken while building 'prague-intrinsic-gas-floor-or-refuse'
date: 2026-08-02
status: open
decisionsFor: prague-intrinsic-gas-floor-or-refuse
---

# Decisions taken while building `prague-intrinsic-gas-floor-or-refuse`

The done record's `## Decisions` block, kept here because the task body is moved byte-identical by the runner. Each entry: what was chosen, why, what was rejected, and what it touches. Ratify or reverse.

Context: the task offered two honest resolutions — implement the EIP-7623 calldata floor in the shared `src/intrinsic-gas.ts`, or stop admitting the hardforks the node cannot cost — and asked for one to be picked. The evidence behind every entry here is `docs/spikes/prague-intrinsic-gas-floor-or-refuse/` (probe + measurements), and the durable rationale is `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`.

## 1. REFUSED rather than implemented: `prague` and `osaka` leave `SPEC_BY_HARDFORK`

**Chosen:** the revm engine admits `berlin, london, paris, shanghai, cancun` and refuses `prague` / `osaka` by name at `connect`, naming the EIP, the shared file that would have to change, and ADR 0008.

**Why:** three measured reasons, in increasing weight. (a) The floor branch would be UNREACHABLE — `createNode()` pins `Hardfork.Cancun` and `NodeOptions` exposes no hardfork, so no test through the node's public API could execute it, and the conformance differential (the repo's strongest bar) would never see it. (b) It would not be SUFFICIENT: Osaka's EIP-7825 gas-limit cap (16777216) is below the node's default read budget (30000000 + intrinsic), so every ordinary `eth_call` on Osaka is rejected with `TxGasLimitGreaterThanCap` regardless of EIP-7623 — a second divergence in the same table. (c) Admitting Prague on the strength of one implemented rule would CLAIM a fork whose other rules (EIP-7702 authorization lists, EIP-2935 block-hash history) the node's transaction path has never been checked against: the plausible-half-truth shape the honest-edge convention exists to prevent.

**Rejected:** implementing the floor (above); leaving the table alone and documenting the gap in a comment (a comment does not stop `createNode()` from coming up).

**Touches:** `packages/embedded-eth-node/src/revm.ts` only. No user-visible behaviour changes today, because the node cannot select Prague or Osaka in the first place; the refusal is a guard that fires the day the node's hardfork moves. It is cheap to reverse — re-admitting a fork is a two-line change, gated on doing the costing work first. `src/intrinsic-gas.ts` is deliberately UNCHANGED.

## 2. The two hardfork tables are EXPORTED from `embedded-eth-node/revm`

**Chosen:** `REVM_SPEC_BY_HARDFORK` (admitted) and `REVM_REFUSED_HARDFORKS` (refused, with the reason as the value) are public named exports of the subpath; the internal const was renamed from `SPEC_BY_HARDFORK` to match the `REVM_ENGINE_ID` naming already used for this module's exports.

**Why:** it makes the test loop over the admitted set rather than restate it, so re-adding a fork without doing the costing work FAILS `test/revm-engine.spec.ts` (the same estimate is then judged by revm under the new spec). It is also the honest answer to "which forks does this engine serve", which a consumer can otherwise only discover by triggering the refusal.

**Rejected:** keeping both tables private and hardcoding the fork list in the test (the guard would then be a snapshot of intent rather than of the code, and a re-added fork would go untested).

**Touches:** the public surface of `embedded-eth-node/revm` (two added exports, a `minor` changeset). Nothing in the core entry point.

## 3. The invariant is asserted against the ENGINE, not against a re-implemented formula

**Chosen:** `test/helpers/revm-engine.ts` takes the number `eth_estimateGas` actually returned for a calldata-heavy call and feeds it back to a second `revm-wasm` instance AS a gas limit, once per admitted spec, plus the node's default read budget; both must be accepted. The two counter-examples (`PRAGUE` rejecting the estimate with `GasFloorMoreThanGasLimit`, `OSAKA` rejecting the budget with `TxGasLimitGreaterThanCap`) are asserted too.

**Why:** the acceptance criterion is "cannot return a value the engine would reject", and the only authority on that is the engine. A test that recomputed the floor in TypeScript would pass while both sides were wrong in the same way. The counter-examples keep the refusals evidence-backed rather than decorative: if a revm upgrade ever dropped the floor, the test says so.

**Rejected:** asserting `estimate >= floor(data)` with a floor computed in the test (re-implements the rule under test); driving the check through the node (impossible — the node cannot be put on Prague).

**Touches:** `test/helpers/revm-engine.ts` + `test/revm-engine.spec.ts`. The second `revm-wasm` instance runs on an empty `MemoryStore`, which is honest here because what is under test is revm's TRANSACTION VALIDATION — it runs before the first opcode and reads only the calldata and the gas limit.

## 4. The refusal probe reaches `engine.connect()` directly

**Chosen:** the test builds a `Common` on `prague` / `osaka` and calls `engine.connect(context)` itself, rather than going through `createNode()`.

**Why:** there is no other way in — the node hardcodes Cancun. That is precisely what the guard is for, so the test has to stand where the node would stand the day its hardfork moves. The same probe checks that `cancun` still connects, which is the "default path demonstrably unchanged" criterion at this seam.

**Rejected:** adding a `hardfork` option to `NodeOptions` to make the refusal reachable through the public API — a user-visible default and a much larger question (the transaction path, the conformance reference and the block environment would all have to follow), and out of this task's scope.
