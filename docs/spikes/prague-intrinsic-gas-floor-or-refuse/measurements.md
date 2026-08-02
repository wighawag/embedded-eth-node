# Which hardforks the node can actually COST, measured

Measured 2026-08-02 against `revm-wasm@0.3.0` (revm 42.0.1), by `./probe-hardfork-costing.mjs` in this folder. Re-run it (`node docs/spikes/prague-intrinsic-gas-floor-or-refuse/probe-hardfork-costing.mjs`) if the package moves; every number below is that script's output, not a summary of it.

The question: for each hardfork `embedded-eth-node/revm` could admit, does what the NODE computes about a transaction still match what revm ENFORCES? The node computes `eth_estimateGas` as `executionGas + intrinsicGas(data, isCreate)` (`packages/embedded-eth-node/src/intrinsic-gas.ts`, shared by the node and the engine), and a client uses the answer as the transaction's gas LIMIT.

## 1. The node's estimate, judged as a gas limit by revm

100 non-zero calldata bytes to a codeless address: the node's arithmetic says 22600, EIP-7623's floor says `21000 + 10 * (4 * 100)` = 25000.

| spec | verdict at gas limit 22600 |
| --- | --- |
| BERLIN / LONDON / MERGE / SHANGHAI / CANCUN | `success`, `totalGasSpent` 22600 |
| PRAGUE | `validation-error`, `Transaction(GasFloorMoreThanGasLimit { gas_floor: 25000, gas_limit: 22600 })` |
| OSAKA | `validation-error`, same `GasFloorMoreThanGasLimit` |

This is the user-visible failure in one line: on Prague the number the node returns from `eth_estimateGas` is rejected by the engine that produced it, and a client that used it as a gas limit gets an out-of-gas transaction with no warning.

## 2. Osaka fails a SECOND, independent way

The node's default read budget is the 30000000 block gas limit, and the engine passes `gasLimit + intrinsic` to revm (it charges intrinsic gas out of the transaction limit). EIP-7825 caps a transaction's gas limit at 16777216:

| spec | empty calldata, gas limit 30021000 |
| --- | --- |
| BERLIN ... PRAGUE | `success`, `totalGasSpent` 21000 |
| OSAKA | `validation-error`, `Transaction(TxGasLimitGreaterThanCap { gas_limit: 30021000, cap: 16777216 })` |

So **every ordinary `eth_call`** on Osaka is rejected before the first opcode, for a reason that has nothing to do with EIP-7623. Implementing the calldata floor would have left Osaka just as broken, only less obviously — which is what settled the implement-or-refuse question (ADR 0008).

## 3. What the node's arithmetic gets RIGHT, on the forks that stay admitted

A CREATE-shaped read (64-byte initcode, 2 words, returning empty code) at gas limit 1000000, checking `totalGasSpent - intrinsicGas(data, true)`:

| spec | `totalGasSpent` | minus the node's intrinsic |
| --- | --- | --- |
| BERLIN ... OSAKA | 53302 | 6, on every spec |

6 is exactly the execution gas of `PUSH1 0 / PUSH1 0 / RETURN`, so the node's intrinsic term — including the EIP-3860 initcode word cost — agrees with revm on every one of these specs. Worth noting for anyone reading the table: revm charges the EIP-3860 word cost on BERLIN too, i.e. earlier than the EIP shipped, but since the node's formula charges it unconditionally as well, the two agree and no divergence reaches an estimate.

## 4. One thing NOT to build on: `Outcome.gasUsed` carries the floor on every spec

The same call at a large gas limit:

| spec | `totalGasSpent` | `gasUsed` |
| --- | --- | --- |
| BERLIN ... OSAKA | 22600 | 25000 |

25000 is the EIP-7623 floor, reported on pre-Prague specs where the floor does not exist. The engine reads `totalGasSpent` (documented as "gas spent before refunds"), not `gasUsed`, so nothing here is affected — but a future change that reaches for `gasUsed` would pick up a post-Prague floor on a Cancun read. Captured as `work/notes/observations/revm-wasm-gasused-carries-the-eip-7623-floor.md`.
