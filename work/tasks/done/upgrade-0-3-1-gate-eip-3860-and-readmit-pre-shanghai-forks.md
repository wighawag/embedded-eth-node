---
title: Upgrade to revm-wasm 0.3.1, gate EIP-3860 by fork, and re-admit berlin/london/paris
slug: upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

This is **family 2** of `readmit-refused-hardforks-once-the-node-can-cost-them`, cut out as READY work because its entry condition is now met. That task stays in place as the deferred marker for family 1 (`prague`/`osaka`), which this task does NOT touch.

`wighawag/revm-wasm#4` is fixed in `revm-wasm@0.3.1`: `CallExecutor::new` now calls `set_spec_and_mainnet_gas_params(spec)` instead of assigning `c.spec`, so the intrinsic-gas table is rebuilt for the requested spec rather than staying pinned at `Context::mainnet()`'s OSAKA default. Both probes have been re-run against the shipped artifact and the numbers are section 6 of `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md`. **Read that section first: it is the evidence this task rests on, and it reverses the previous conclusion.**

**The reversal, because it is the whole point.** `berlin`, `london` and `paris` were refused (ADR 0008's amendment) because the node AND revm both charged EIP-3860's initcode word cost on forks that predate Shanghai: they agreed with each other and were both wrong about the protocol. Gating the term locally was rejected then, correctly, because it would have moved only the default engine's estimate and could not move revm's, splitting the two engines. **On `0.3.1` that argument is void.** revm gates the term properly now, so the node is the only party still charging it, and the estimates that used to agree on a wrong number now disagree:

| 64-byte initcode CREATE | default engine | revm `0.3.1` | protocol | after gating |
| --- | --- | --- | --- | --- |
| berlin / london / paris | 53302 | 53298 | 53298 | both 53298 |
| shanghai / cancun | 53302 | 53302 | 53302 | unchanged |

So the fork gate is now the fix that RESTORES agreement, not the one that breaks it.

**The design question, which is the real work.** `intrinsicGas(data, isCreate)` in `src/intrinsic-gas.ts` takes no hardfork, and its whole value is that its two callers share ONE answer: `node.ts` ADDS it to what the read engine reports, and `src/revm.ts` SUBTRACTS it from revm's `totalGasSpent`. If those two ever compute different numbers, `eth_estimateGas` silently differs by engine, which is the drift the file was extracted to prevent. So thread the fork through DELIBERATELY, keep the function shared and unforked, and decide explicitly what the parameter is (a hardfork name? an `isActivatedEIP`-style predicate? the `Common` itself?) and how each caller obtains it. Record the seam decision durably.

**Scope discipline.** Do NOT admit `prague` or `osaka`, and do not implement the EIP-7623 floor. Re-measured on `0.3.1`, both still reject: `GasFloorMoreThanGasLimit { gas_floor: 25000, gas_limit: 22600 }` for the node's estimate on each, and `TxGasLimitGreaterThanCap { gas_limit: 30021000, cap: 16777216 }` for the node's default 30M read budget on Osaka. Their refusal never depended on the upstream bug.

Note also that ADR 0008's clause (b) is enforced for the EIP-3860 term only. That is adequate here (all three forks are AFTER Istanbul, so EIP-2028's 16/4 calldata costs are correctly active for them) but do not widen the claim; `clause-b-covers-only-eip-3860-not-the-rest-of-the-formula` owns that gap.

## Acceptance criteria

- [ ] `revm-wasm` is at `^0.3.1` in `packages/embedded-eth-node` and `packages/benchmarks`, and the lockfile is updated.
- [ ] The EIP-3860 initcode word cost is charged from Shanghai onward and NOT before, via a fork threaded through the SHARED `src/intrinsic-gas.ts`. The function is not duplicated, and both callers (`node.ts`, `src/revm.ts`) demonstrably get the same answer for the same fork.
- [ ] `berlin`, `london` and `paris` move from `REVM_REFUSED_HARDFORKS` to `REVM_SPEC_BY_HARDFORK`, and the now-obsolete `PRE_EIP_3860` reason string is removed.
- [ ] `prague` and `osaka` remain refused, with their reasons unchanged, and at least one of them is asserted as the standing counter-example so the admitted-set assertions stay load-bearing.
- [ ] For every admitted fork, the invariant is asserted AGAINST THE ENGINE: the number `eth_estimateGas` returns is fed back to revm as a gas limit and accepted, and clause (b) holds (`@ethereumjs/common` agrees the EIP-3860 term is active exactly where the node charges it). A CREATE-shaped read is covered, since that is the only shape this term reaches.
- [ ] The two engines return the SAME `eth_estimateGas` for a CREATE on a pre-Shanghai fork, asserted directly. That is the divergence this task exists to close, and nothing currently covers it.
- [ ] Shanghai and Cancun behaviour is demonstrably unchanged, including the EIP-3860 initcode case the conformance differential already covers.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] ADR 0008 records that this refusal was lifted, on what evidence, and that `prague`/`osaka` are untouched. The seam decision for the fork parameter is recorded durably.
- [ ] A changeset, since this changes an observable estimate and widens the admitted fork set.
- [ ] If the bundle-size assertion in `packages/benchmarks/test/evm.spec.ts` fires, the baseline is re-pinned in the SAME change with the reason written into the comment block above it. Never raised silently.

## Blocked by

- None. The upstream fix is released and verified against the shipped artifact.

## Prompt

> Goal: take the upstream fix in `revm-wasm@0.3.1` and re-admit the three pre-Shanghai forks it unblocks, by gating EIP-3860 in the node's shared intrinsic-gas arithmetic.
>
> FIRST, check this task against current reality: read section 6 of `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md`, `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` INCLUDING its amendment, and `src/intrinsic-gas.ts`. Re-run `probe-initcode-costing.mjs` against the installed `0.3.1` yourself rather than trusting the recorded numbers; if the per-word delta is not 4 on berlin/london/paris, STOP, because the premise has moved again.
>
> THE TRAP IS READING ADR 0008 AND STOPPING. Its body argues at length that gating EIP-3860 locally is the WRONG fix. That was true against `0.3.0`, when revm charged the term too. It is void against `0.3.1`. The amendment banner and measurements section 6 record the reversal. Gating is now what makes the two engines agree.
>
> THE REAL WORK IS THE SEAM, not the arithmetic. `intrinsicGas(data, isCreate)` has no fork parameter and is SHARED precisely so `node.ts` (which adds it) and `src/revm.ts` (which subtracts it) can never drift. Adding a fork means both callers must obtain the same one. Choose the parameter shape deliberately, keep one implementation, and record the decision; a duplicated formula here reintroduces exactly the failure the file exists to prevent.
>
> Do NOT admit `prague` or `osaka` and do NOT implement the EIP-7623 floor. Both were re-measured on `0.3.1` and still reject the node's estimate; they are a different task with its own entry conditions.
>
> Assert the fix where nothing currently looks: a CREATE-shaped `eth_estimateGas` on a pre-Shanghai fork must return the SAME number from both engines, and match what `@ethereumjs/common` says the protocol charges.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
