# Every term of the intrinsic-gas formula, read three ways, fork by fork

Measured 2026-08-02 against `revm-wasm@0.3.1` (revm 42.0.1), `@ethereumjs/tx@10.1.2` and `@ethereumjs/common@10.x`, by `./probe-intrinsic-terms.mjs` in this folder. Re-run it (`node docs/spikes/clause-b-covers-only-eip-3860-not-the-rest-of-the-formula/probe-intrinsic-terms.mjs`) if any of the three moves; every number below is that script's output, not a summary of it.

The question. ADR 0008's clause (b) says everything the node computes about a transaction must be **what the PROTOCOL charges at that fork**, judged by a witness that is neither the node nor revm. The enforcement behind it measured ONE term, EIP-3860's initcode word cost, while `packages/embedded-eth-node/src/intrinsic-gas.ts` also hardcodes the 21000 base, the 32000 creation base and EIP-2028's 16-per-non-zero / 4-per-zero calldata bytes. So: at which forks does each of those terms actually match the protocol, and where does the match end?

How a term is measured, and why it is not read off a table. Each term is a DELTA between two probe transactions, and the same delta is evaluated against three parties: the protocol (`@ethereumjs/tx`'s own intrinsic-gas arithmetic at that `Common`, i.e. the code `@ethereumjs/vm`'s `runTx` charges a mined transaction on this node), revm (`totalGasSpent`, measured), and the node (the real exported `intrinsicGas()`, imported from source). The probe shapes keep EXECUTION gas out of every answer: a CALL goes to a codeless address, and a CREATE deploys empty code, so either both sides of a delta run the same three opcodes or neither runs anything. Nothing in the probe restates a constant from the formula — even the initcode-word row subtracts the MEASURED zero-byte cost rather than the number 4.

## 1. The full table

`(not admitted)` marks a fork outside `REVM_SPEC_BY_HARDFORK`, which the engine refuses at construction.

| hardfork | transaction base | non-zero calldata byte (EIP-2028) | zero calldata byte | creation base (EIP-2) | initcode word (EIP-3860) |
| --- | --- | --- | --- | --- | --- |
| petersburg *(not admitted)* | 21000 / 21000 / 21000 | **68 / 68 / 16** | 4 / 4 / 4 | 32000 / 32000 / 32000 | 0 / 0 / 0 |
| istanbul *(not admitted)* | 21000 / 21000 / 21000 | 16 / 16 / 16 | 4 / 4 / 4 | 32000 / 32000 / 32000 | 0 / 0 / 0 |
| berlin | 21000 / 21000 / 21000 | 16 / 16 / 16 | 4 / 4 / 4 | 32000 / 32000 / 32000 | 0 / 0 / 0 |
| london | 21000 / 21000 / 21000 | 16 / 16 / 16 | 4 / 4 / 4 | 32000 / 32000 / 32000 | 0 / 0 / 0 |
| paris | 21000 / 21000 / 21000 | 16 / 16 / 16 | 4 / 4 / 4 | 32000 / 32000 / 32000 | 0 / 0 / 0 |
| shanghai | 21000 / 21000 / 21000 | 16 / 16 / 16 | 4 / 4 / 4 | 32000 / 32000 / 32000 | 2 / 2 / 2 |
| cancun | 21000 / 21000 / 21000 | 16 / 16 / 16 | 4 / 4 / 4 | 32000 / 32000 / 32000 | 2 / 2 / 2 |

Each cell is `protocol / revm / node`.

**One disagreement in the whole table, and it is at a fork the engine does not admit:** `petersburg/non-zero calldata byte`, where the protocol and revm both charge 68 and the node charges 16 — the node UNDER-charging by 52 gas per non-zero calldata byte.

## 2. What that says about clause (b) as it was enforced

Nothing is mis-costed today: at all five admitted forks (`berlin`, `london`, `paris`, `shanghai`, `cancun`) every term of the formula matches the protocol exactly. The gap was in the CHECK, not in the arithmetic.

The EIP-3860 term's readings were load-bearing because the admitted set SPANS EIP-3860's boundary (`berlin`/`london`/`paris` predate it, `shanghai`/`cancun` do not), so an ungated formula fails them. **EIP-2028's boundary is different: no admitted fork spans it.** Every admitted fork is at or above Istanbul, so a per-fork reading of the calldata term passes just as happily against a formula that hardcodes 16 — which is exactly what `intrinsicGas()` does. Measuring it at the admitted forks alone is therefore decorative, and that is the difference this spike exists to make visible.

What makes it load-bearing instead is measuring the BOUNDARY, from both sides, on specs the engine does not admit: `istanbul` (all three parties agree) and `petersburg` one fork below it (they do not). That pair is asserted in `packages/embedded-eth-node/test/revm-engine.spec.ts`, so re-admitting a pre-Istanbul fork moves the measured disagreement into the per-fork loop and fails the build.

## 3. Which direction the error runs, and why it matters

The node's error below Istanbul is an UNDER-charge, and that is the worse direction. `eth_estimateGas` is `executionGas + intrinsicGas(...)`, a client uses the estimate as the transaction's GAS LIMIT, and the transaction is then validated by a node that charges 68. For a 1000-byte calldata call the estimate would be short by 52000 gas — an out-of-gas failure in the user's face, which is precisely the silent-wrong-answer shape ADR 0008 refuses forks to avoid. (The EIP-3860 case that prompted the original amendment ran the other way: an OVER-charge, which wastes gas rather than failing.)

Note also that a pre-Istanbul re-admission is caught TWICE over, independently: the clause-(a) assertion that already existed feeds the node's estimate back to revm as a gas limit, and revm rejects it — measured, on `PETERSBURG` admitted experimentally: `Transaction(CallGasCostMoreThanGasLimit { initial_gas: 89000, gas_limit: 37000 })`. Clause (b)'s widened readings are what say WHY, and at which term.

## 4. The bound this pins on `intrinsic-gas.ts`

The formula is protocol-correct over **Istanbul .. Cancun**, and the range has an end at BOTH sides:

- ABOVE, at Prague: EIP-7623's calldata floor is not implemented (deliberately — it is a floor on the transaction's total, not a term of the formula), and Osaka adds EIP-7825's gas-limit cap. Both forks are refused BY NAME.
- BELOW, at Istanbul: EIP-2028 set the 16-gas non-zero calldata byte, and the formula hardcodes it. Anything below Istanbul is refused by the "no revm spec is known" guard, since it is in neither table.

`REVM_SPEC_BY_HARDFORK` admits `berlin`..`cancun`, which sits strictly inside that range.
