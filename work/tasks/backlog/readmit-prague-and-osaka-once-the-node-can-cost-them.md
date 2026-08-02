---
title: Re-admit Prague and Osaka once the node can actually cost them
slug: readmit-prague-and-osaka-once-the-node-can-cost-them
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

`prague-intrinsic-gas-floor-or-refuse` resolved the implement-or-refuse fork by REFUSING: `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` removed `prague` and `osaka` from the engine's table and refuses them by name at construction. That was the honest call at the time, and the ADR says so explicitly: "nothing in this ADR argues Prague should stay unsupported forever", and it names `work/tasks/backlog/` as the place the costing work belongs. This task is that placeholder, cut so a deliberate deferral does not quietly become permanent by neglect (raised by the Gate-2 review).

**This task is NOT ready to build as written.** It is a marker with the entry conditions written down, because the work only becomes worth doing when something changes upstream of it. Do not drive it until at least one of these holds:

- the node wants to move its hardfork past Cancun (today `createNode()` pins `Hardfork.Cancun` and `NodeOptions` exposes no hardfork option at all, which is precisely why the refusal is unreachable and why implementing the floor now would ship a branch no test can execute), or
- a consumer actually asks for Prague/Osaka reads, or
- the node gains a hardfork option, which makes the refusal reachable and therefore worth replacing with real support.

**What the work is, when it is time.** ADR 0008 states the bar: implement the missing rules in the SHARED `src/intrinsic-gas.ts` (shared so the node and the engine move together by construction, never forked), and in the engine's read budget, then move the entry from `REVM_REFUSED_HARDFORKS` to `REVM_SPEC_BY_HARDFORK` and let the existing test judge it. The measured gaps, from `docs/spikes/prague-intrinsic-gas-floor-or-refuse/`:

- **Prague, EIP-7623 calldata floor.** A transaction pays at least `21000 + 10 * tokens` (1 token per zero byte, 4 per non-zero). For 100 non-zero calldata bytes the node computes 22600 and revm demands 25000, rejecting with `GasFloorMoreThanGasLimit`. Note the shape problem the current code comment records: the floor is a floor on the transaction's TOTAL gas, not a term of the intrinsic formula, so it cannot simply be added inside `intrinsicGas()` without both callers learning about it.
- **Osaka, EIP-7825 gas cap.** A transaction's gas limit is capped at 16777216, below the node's default read budget of 30000000, so EVERY ordinary `eth_call` is rejected with `TxGasLimitGreaterThanCap`. This is independent of EIP-7623 and must be solved too, or Osaka stays refused.
- **Prague also brings EIP-7702 authorization lists and EIP-2935 block-hash history**, which the node's transaction path has never been checked against. Re-admitting the fork means claiming those too, so they need checking rather than assuming.

Re-admitting without doing the costing is designed to fail loudly: `test/revm-engine.spec.ts` feeds the `eth_estimateGas` result back to revm AS a gas limit under every admitted spec, so moving an entry between the tables without the arithmetic makes the build go red.

## Acceptance criteria

- [ ] An entry point condition above actually holds, and is stated in the work.
- [ ] For each fork being re-admitted, every rule the node computes about a transaction agrees with what revm enforces under that spec, and the agreement is asserted against the ENGINE rather than against a restated formula (follow the existing test's shape).
- [ ] `src/intrinsic-gas.ts` remains SHARED and unforked; if the EIP-7623 floor cannot live inside `intrinsicGas()`, the seam it needs is designed explicitly rather than by duplicating the formula.
- [ ] Osaka is only re-admitted if the EIP-7825 cap is handled too, not just the calldata floor.
- [ ] If EIP-7702 / EIP-2935 have NOT been checked against the transaction path, Prague is not re-admitted on the strength of EIP-7623 alone; that is the exact half-truth ADR 0008 refuses.
- [ ] The entry moves from `REVM_REFUSED_HARDFORKS` to `REVM_SPEC_BY_HARDFORK`, and ADR 0008 gains a short amendment recording that its refusal was lifted, and on what evidence.
- [ ] Cancun behaviour and the reference gas are demonstrably unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None mechanically, but see the entry conditions: this is DEFERRED work, not ready work. Do not auto-select it.

## Prompt

> Goal: lift the Prague/Osaka refusal in ADR 0008 by doing the costing work it defers, so the engine admits those forks because it can cost them rather than because nobody checked.
>
> FIRST, check whether this is worth doing AT ALL: read `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`, the entry conditions above, and `createNode()` in `src/node.ts`. If the node still pins Cancun and exposes no hardfork option, and nobody has asked for Prague, then the honest answer is STOP: the refusal is still correct and this task is still deferred. Say so rather than implementing an unreachable branch, which is the exact reason the original task refused instead of implementing.
>
> Read `docs/spikes/prague-intrinsic-gas-floor-or-refuse/measurements.md` for the measured gaps, and re-run `probe-hardfork-costing.mjs` rather than trusting numbers that may have aged with the package.
>
> THE INVARIANT IS AGREEMENT WITH THE ENGINE, NOT A CORRECT-LOOKING FORMULA. `test/revm-engine.spec.ts` already feeds the node's `eth_estimateGas` result back to revm as a gas limit under every admitted spec; extend that rather than asserting your own arithmetic against itself. Two wrong sides that agree is the failure shape ADR 0008 exists to refuse.
>
> Do NOT fork `src/intrinsic-gas.ts`: it is shared so the node and the engine cannot drift. If EIP-7623's floor does not fit inside it (it is a floor on the transaction's TOTAL gas, not an intrinsic term), design the seam deliberately and record the decision.
>
> Done means: no hardfork the engine admits can have the node's estimate rejected by the engine that produced it, and ADR 0008 records that its refusal was lifted and why.
