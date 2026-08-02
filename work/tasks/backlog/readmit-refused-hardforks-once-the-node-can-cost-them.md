---
title: Re-admit a refused hardfork once the node can actually cost it
slug: readmit-refused-hardforks-once-the-node-can-cost-them
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

`embedded-eth-node/revm` admits `shanghai` and `cancun` and refuses everything else by name at construction (`REVM_REFUSED_HARDFORKS`, `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` and its amendment). Both refusals were the honest call, and the ADR says the door is not meant to stay shut: "nothing in this ADR argues Prague should stay unsupported forever", and it names `work/tasks/backlog/` as where the costing work belongs. This task is that placeholder, cut so a deliberate deferral does not quietly become permanent by neglect (raised by the Gate-2 reviews of `prague-intrinsic-gas-floor-or-refuse` and `intrinsic-gas-charges-eip-3860-on-forks-that-predate-it`).

**This task is NOT ready to build as written.** It is a marker with its entry conditions written down, and it covers TWO families of refusal whose triggers are completely different. Take whichever family has actually become unblocked; do not treat them as one job.

### Family 1: ABOVE the range (`prague`, `osaka`) is blocked on OUR arithmetic

`src/intrinsic-gas.ts` implements the pre-Prague formula only, while revm enforces more from Prague onwards. Measured in `docs/spikes/prague-intrinsic-gas-floor-or-refuse/`:

- **EIP-7623 calldata floor** (Prague). A transaction pays at least `21000 + 10 * tokens` (1 token per zero byte, 4 per non-zero). For 100 non-zero calldata bytes the node computes 22600 and revm demands 25000, rejecting with `GasFloorMoreThanGasLimit`. Note the shape problem the code comment records: this is a floor on the transaction's TOTAL gas, not a term of the intrinsic formula, so it cannot be dropped inside `intrinsicGas()` without both callers also learning about it.
- **EIP-7825 gas cap** (Osaka). A transaction's gas limit is capped at 16777216, below the node's default read budget of 30000000, so EVERY ordinary `eth_call` is rejected with `TxGasLimitGreaterThanCap`. Independent of EIP-7623: solving the floor alone leaves Osaka just as broken.
- **EIP-7702 authorization lists and EIP-2935 block-hash history** (Prague) have never been checked against the node's transaction path. Re-admitting the fork claims those too.

Entry conditions: the node wants to move its hardfork past Cancun, or a consumer asks for Prague/Osaka reads, or the node gains a hardfork option. Today `createNode()` pins `Hardfork.Cancun` and `NodeOptions` exposes no hardfork at all, which is why implementing the floor now would ship a branch no test going through the public API can execute. That unreachability is the argument that settled implement-vs-refuse the first time; if it still holds, STOP and say so.

### Family 2: BELOW the range (`berlin`, `london`, `paris`) is blocked UPSTREAM

Nothing about the node's own arithmetic is wrong here. `revm-wasm` computes intrinsic gas at a fixed late spec and CHARGES EIP-3860's initcode word cost on all three forks, which predate Shanghai. Both sides then agree on a number the protocol does not charge, over-charging by `2 * ceil(len/32)` gas (3072 for a maximum-size initcode). Measured in `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`; filed as **`wighawag/revm-wasm#4`**; tracked locally by `work/notes/observations/revm-wasm-intrinsic-gas-ignores-the-spec.md`.

**Do not try to fix this family locally.** A fork gate in `src/intrinsic-gas.ts` would move the DEFAULT engine's estimate and could not move revm's (the engine subtracts the node's intrinsic gas from `totalGasSpent` and the node adds it straight back), converting an agreed-wrong number into a real cross-backend gas divergence, which is exactly what the gate in `packages/benchmarks` exists to catch.

Entry condition: `wighawag/revm-wasm#4` is fixed AND this repo has upgraded to the release carrying the fix. Verify against the shipped artifact rather than the changelog: re-run `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/probe-initcode-costing.mjs` and confirm the per-word delta is 4 rather than 6 on those specs.

### Both families

The bar is the same either way, and ADR 0008 states it: implement whatever is missing in the SHARED `src/intrinsic-gas.ts` (shared so the node and the engine move together by construction, never forked) and in the engine's read budget, then move the entry from `REVM_REFUSED_HARDFORKS` to `REVM_SPEC_BY_HARDFORK` and let the existing test judge it. Re-admitting without doing the work is designed to fail loudly: `test/revm-engine.spec.ts` feeds the `eth_estimateGas` result back to revm AS a gas limit under every admitted spec.

**Check `clause-b-covers-only-eip-3860-not-the-rest-of-the-formula` before re-admitting anything.** ADR 0008's clause (b) is stated generally but enforced for the EIP-3860 term alone, so the automated check would NOT catch a fork mis-costed on EIP-2028's 16/4 calldata costs (Istanbul). That matters most for family 2, whose forks sit nearest the Istanbul boundary. Either land that task first or do its check by hand here.

## Acceptance criteria

- [ ] An entry condition for the family being re-admitted actually holds, and is stated in the work.
- [ ] For each fork re-admitted, everything the node computes about a transaction (a) agrees with what revm enforces under that spec AND (b) is what the PROTOCOL charges at that fork, judged by a witness that is neither party, per ADR 0008's amended rule.
- [ ] The agreement is asserted against the ENGINE rather than a restated formula, following the existing test's shape, and a still-refused fork remains as a counter-example so the assertions stay load-bearing.
- [ ] Clause (b) is verified for EVERY term the shared formula bakes in, not just EIP-3860, either because `clause-b-covers-only-eip-3860-not-the-rest-of-the-formula` landed first or by explicit manual check recorded here.
- [ ] `src/intrinsic-gas.ts` remains SHARED and unforked; if EIP-7623's floor cannot live inside `intrinsicGas()`, the seam it needs is designed deliberately rather than by duplicating the formula.
- [ ] Family 1 only: Osaka is re-admitted only if the EIP-7825 cap is handled too, and Prague is not re-admitted on the strength of EIP-7623 alone while EIP-7702 / EIP-2935 are unchecked. That is the half-truth ADR 0008 refuses.
- [ ] Family 2 only: the upstream fix is verified against the shipped artifact by re-running the probe, not taken from a changelog.
- [ ] The entry moves between the two tables, and ADR 0008 gains a short amendment recording that the refusal was lifted and on what evidence.
- [ ] Cancun and Shanghai behaviour and the reference gas are demonstrably unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None mechanically, but see the entry conditions per family: this is DEFERRED work, not ready work. Do not auto-select it. Family 2 additionally depends on an upstream fix this repo does not control.

## Prompt

> Goal: lift one of ADR 0008's hardfork refusals by doing the work it defers, so the engine admits a fork because it can cost it rather than because nobody checked.
>
> FIRST, work out whether anything is worth doing AT ALL, and which family you are in. Read `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` INCLUDING its amendment, the entry conditions above, `createNode()` in `src/node.ts`, and `work/notes/observations/revm-wasm-intrinsic-gas-ignores-the-spec.md`. If the node still pins Cancun and nobody has asked for Prague, family 1 is still correctly deferred. If `wighawag/revm-wasm#4` is still open, family 2 is still blocked upstream and CANNOT be fixed here. In either case STOP and say so rather than implementing an unreachable branch or papering over an upstream bug: that judgement is the task, not a failure to do it.
>
> Re-run the probes in `docs/spikes/` rather than trusting numbers that may have aged with the package. For family 2 the probe IS the acceptance evidence.
>
> THE INVARIANT IS AGREEMENT WITH THE ENGINE AND WITH THE PROTOCOL, not a correct-looking formula. Two wrong sides that agree is the exact failure ADR 0008's amendment exists to catch, and it is how `berlin`/`london`/`paris` got refused in the first place. Extend the existing assertions instead of writing your own arithmetic to check the arithmetic.
>
> Do NOT fork `src/intrinsic-gas.ts`, and do NOT gate a term locally to work around an upstream mis-charge: on the revm path the engine subtracts what the node adds, so a local gate splits the two engines instead of fixing either.
>
> Done means: no hardfork the engine admits can have the node's estimate rejected by the engine that produced it, none is mis-costed against the protocol, and ADR 0008 records which refusal was lifted and why.
