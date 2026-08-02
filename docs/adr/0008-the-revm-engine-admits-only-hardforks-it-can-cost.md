# The revm engine admits only the hardforks the node can COST, so Prague and Osaka are refused rather than half-supported

> **Amended 2026-08-02** (`intrinsic-gas-charges-eip-3860-on-forks-that-predate-it`): the admission rule below was necessary but not sufficient, and `berlin`, `london` and `paris` are now refused too. See [the amendment](#amendment-agreement-with-revm-is-necessary-and-not-sufficient) at the end.

`embedded-eth-node/revm` mapped seven ethereumjs hardfork names onto revm specs, including `prague` and `osaka`, but the node's shared intrinsic-gas arithmetic (`src/intrinsic-gas.ts`) implements the pre-Prague formula only. revm ENFORCES more than that from Prague onwards, so an admitted-but-uncosted fork is the silent-wrong-answer case: `eth_estimateGas` returns a plausible number, viem uses it as the transaction's gas LIMIT, and the transaction runs out of gas in the user's face. We therefore removed `prague` and `osaka` from the table and refuse them BY NAME at construction, naming the EIP and this ADR, in the same style as the engine's existing `stateMode:'trie'` refusal. The rule the table now encodes is not "revm has a spec for this fork" but **"everything the node computes about a transaction still agrees with what revm enforces under this spec"**.

## The measurements this rests on

All numbers from `docs/spikes/prague-intrinsic-gas-floor-or-refuse/` (`probe.mjs`, run against the same `revm-wasm@0.3.0` artifact the engine ships), for a call carrying 100 non-zero calldata bytes:

| spec | node's arithmetic (`21000 + 16/byte`) | revm's verdict at that gas limit |
| --- | --- | --- |
| CANCUN | 22600 | runs, `totalGasSpent` 22600 |
| PRAGUE | 22600 | **rejected**: `GasFloorMoreThanGasLimit { gas_floor: 25000, gas_limit: 22600 }` |

EIP-7623's floor is `21000 + 10 * tokens`, tokens being 1 per zero byte and 4 per non-zero byte, and it binds on exactly the transactions the node's read path is for: calldata-heavy and computation-light. 25000 against the 22600 the node would have returned is not a rounding difference, it is a refusal.

Osaka fails a SECOND, independent way, which is what turned a close call into an easy one. EIP-7825 caps a transaction's gas limit at 16777216. The node's default read budget is the 30000000 block gas limit, and the engine passes `gasLimit + intrinsic` to revm, so **every ordinary `eth_call` on Osaka** is rejected before the first opcode with `TxGasLimitGreaterThanCap { gas_limit: 30021000, cap: 16777216 }` — nothing to do with EIP-7623. Implementing the calldata floor would have left Osaka just as broken, only less obviously.

## Considered options

**Implement the EIP-7623 floor instead.** The formula is small (ten lines in `intrinsic-gas.ts`, plus `max(execution + intrinsic, floor)` at the `eth_estimateGas` case, gated on the fork). It was rejected for three reasons, in increasing order of weight. First, it is unreachable: `createNode()` pins `Hardfork.Cancun` and `NodeOptions` exposes no hardfork, so no test that goes through the node's public API can execute the new branch — we would be shipping hardfork-gated arithmetic that nothing exercises, and the conformance differential (the repo's strongest bar) would never see it. Second, it is not sufficient: Osaka's gas-limit cap is a separate divergence in the same table, so "implement the floor" does not restore the invariant it claims to restore. Third, and decisively, it would move this engine from *admitting a fork it cannot cost* to *claiming a fork it has costed on the strength of one rule of many* — Prague also brings EIP-7702 authorization lists and EIP-2935 block-hash history, none of which the node's transaction path has been checked against. That is the plausible-half-truth shape ADR 0004's convention exists to prevent.

**Leave the table alone and document the gap.** Rejected: a comment does not stop `createNode()` from coming up. The whole point of the seam's construction-time refusals is that a misconfiguration fails where the consumer can see it, not at the first opcode and not in production.

## Consequences

- **No user-visible behaviour changes today**, because the node cannot select Prague or Osaka in the first place: the refusal is a guard that fires the day the node's hardfork moves. That is also why removing the entries is cheap to reverse — re-admitting a fork is a two-line change, gated on doing the costing work first.
- **`REVM_SPEC_BY_HARDFORK` and `REVM_REFUSED_HARDFORKS` are exported** from `embedded-eth-node/revm`. They are the honest answer to "which forks does this engine serve", and exporting them lets the test loop over the admitted set rather than restating it: re-adding a fork without doing the costing work makes `test/revm-engine.spec.ts` fail, because the same estimate is then judged under the new spec by revm itself.
- **The invariant is asserted against the engine, not against a formula.** The test takes the number `eth_estimateGas` actually returned for a calldata-heavy call and feeds it back to revm AS a gas limit under every admitted spec, plus the node's default read budget, and requires both to be accepted. The two counter-examples (`PRAGUE` rejecting the estimate, `OSAKA` rejecting the budget) are asserted too, so the refusals stay evidence-backed rather than decorative.
- **The bar for admitting a fork later** is: implement the missing rules in `src/intrinsic-gas.ts` (shared, so the node and the engine move together by construction) and in the engine's read budget, then move the entry between the two tables and let the test judge it. `work/tasks/backlog/` is the place for that work; nothing in this ADR argues Prague should stay unsupported forever.

## Amendment: agreement with revm is NECESSARY and NOT SUFFICIENT

2026-08-02. The rule above compares the node with revm, and that rule cannot see the case where the two agree and are both wrong about the protocol. `berlin`, `london` and `paris` were exactly that case, so they are refused as well and the engine now admits `shanghai` and `cancun` only. **The rule is now: a fork is admissible when everything the node computes about a transaction (a) still agrees with what revm enforces under that spec, AND (b) is what the PROTOCOL charges at that fork, judged by a witness that is neither of those two.**

The case that forced it. `src/intrinsic-gas.ts` adds EIP-3860's initcode word cost (`ceil(len/32) * 2`) to every CREATE with no hardfork gate, and EIP-3860 arrived in Shanghai. The spike behind the original decision noticed this and set it aside because `revm-wasm` over-charges identically, so the two agree and no cross-engine divergence reaches an estimate. Re-measured against the shipped artifact (`docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`), that observation is CONFIRMED and the conclusion drawn from it is not:

| 64-byte initcode, 2 words | node's formula | `revm-wasm@0.3.0` | protocol (`@ethereumjs/common` + `@ethereumjs/tx`) |
| --- | --- | --- | --- |
| berlin / london / paris | 53296 | 53296 | **53292** |
| shanghai / cancun | 53296 | 53296 | 53296 |

On those three forks `eth_estimateGas` for a deployment over-charges by `2 * ceil(len/32)` gas (3072 for a maximum-size initcode) against what this node's OWN transaction path spends, because `@ethereumjs/vm`'s `runTx` gates the term correctly on `isActivatedEIP(3860)` while the read path does not. The node disagreed with itself, and nothing could see it.

Why the fix is a refusal and not a fork gate in the shared formula. The engine SUBTRACTS `intrinsicGas()` from revm's `totalGasSpent` and the node adds the same number back, so on the revm engine the estimate IS revm's number whatever the node's formula says. Gating the term would therefore move the default engine's estimate to 53298 and leave revm's at 53302: an agreed wrong number converted into a cross-backend gas divergence, which is the failure the gate in `packages/benchmarks` exists to catch. No change to this node alone can make those forks correct on this artifact, and that is what makes refusing them the honest edge (ADR 0004) rather than the lazy option. The gate would also have been unreachable arithmetic — the same argument that rejected implementing the EIP-7623 floor above — and would have had to thread a hardfork through a function whose whole value is that its two callers share ONE answer.

The scope was measured too, because "this artifact ignores the spec" would have been a much larger finding: opcode gating is exactly right at every fork checked (`BASEFEE` halts on Berlin, `PUSH0` halts before Shanghai, `TLOAD` halts before Cancun). The divergence is confined to revm-wasm's pre-execution intrinsic-gas computation, which behaves as though evaluated at a fixed late spec — the same root cause as `work/notes/observations/revm-wasm-gasused-carries-the-eip-7623-floor.md`, sharpened in `work/notes/observations/revm-wasm-intrinsic-gas-ignores-the-spec.md`: it does not merely REPORT a post-fork cost pre-fork, it CHARGES one.

Clause (b) is now enforced where clause (a) already was, in `test/revm-engine.spec.ts`: for every admitted fork, `@ethereumjs/common` must say EIP-3860 is active (the table the node's own `runTx` consults) and revm's per-word charge is MEASURED by delta across an initcode word boundary. Re-admitting a pre-Shanghai fork fails the build, with `paris` asserted as the standing counter-example. What clause (b) needs in general is a witness independent of both parties; `@ethereumjs/common` is the one this repo already trusts, and it is free.

Decisions taken while amending this: `work/notes/observations/decisions-intrinsic-gas-charges-eip-3860-on-forks-that-predate-it-2026-08-02.md`.
