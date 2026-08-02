# The revm engine admits only the hardforks the node can COST, so Prague and Osaka are refused rather than half-supported

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
