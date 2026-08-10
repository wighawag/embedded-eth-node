# The money battery is load-bearing: three mutations, three red runs

Taken 2026-08-10, Chromium via `playwright-browser-harness`, `revm-wasm@0.3.1` and `@ethereumjs/*@10.1.2` as installed in `packages/embedded-eth-node`, hardfork Cancun.

The money differential (`packages/embedded-eth-node/test/helpers/fees.ts`, asserted by `test/revm-fees.spec.ts`) passed on its first run against the code as shipped, which says nothing on its own: a battery that cannot go red is decoration. So each bug class it claims to catch was INTRODUCED deliberately, one at a time, and the run recorded. Every mutation was reverted immediately; nothing here is in the tree.

Reproduce a row by applying its one-line edit, running `pnpm exec playwright test revm-fees --project=chromium` in `packages/embedded-eth-node`, and reverting.

## 1. A legacy transaction priced at the base fee (`src/engine.ts`)

The default engine's `effectiveGasPrice()` ends with `return anyTx.gasPrice as bigint;` — the type-0 branch. Replaced with `return blockBaseFee;`, i.e. the plausible bug of pricing a legacy transaction at the block's base fee under a fee market that has one.

```
mismatches:
  legacyOverBaseFee.effectiveGasPrice: reference=7 underTest=10
  access2930.effectiveGasPrice:        reference=7 underTest=11
  refundClear.effectiveGasPrice:       reference=7 underTest=10
  refundNoop.effectiveGasPrice:        reference=7 underTest=10
violations:
  legacyOverBaseFee/reference.senderPaid:        got 211000, expected 148000
  legacyOverBaseFee/reference.coinbaseCredited:  got  63000, expected 0
  access2930/reference.senderPaid:               got 278800, expected 177600
  access2930/reference.coinbaseCredited:         got 101200, expected 0
  refundClear/reference.senderPaid:              got 212060, expected 148442
  refundNoop/reference.senderPaid:               got 232060, expected 162442
```

Note WHICH half moved. The sender's balance was still charged correctly (`runTx` charges `gasPrice`, and no engine-side arithmetic touches that); it is the RECEIPT that started lying. This is exactly the class named in the task — a receipt carrying a wrong `effectiveGasPrice` beside a correct charge — and it is why the identities are checked against the receipt's own numbers rather than against constants alone.

It also shows why a legacy case must sit ABOVE the base fee: at `gasPrice == baseFee` this mutation is invisible, because both answers are then the same number.

## 2. The revm engine reporting GROSS gas (`src/revm.ts`)

`gasUsed: outcome.gasUsed` (net of refunds) replaced with `gasUsed: outcome.totalGasSpent` (before them) — the mapping the READ half legitimately uses, copied one method down.

```
mismatches:
  refundClear.gasUsed: reference=21206 underTest=26006
violations:
  refundClear/underTest.senderPaid:       got 212060, expected 260060
  refundClear/underTest.coinbaseCredited: got  63618, expected  78018
  refundClear/underTest.burnt:            got 148442, expected 182042
```

ONLY the storage-clearing case fires: every other transaction in the battery has a zero refund, so gross and net coincide and the mutation is undetectable. That is the whole reason the refund case exists.

## 3. A SECOND implementation of the fee arithmetic, in the revm engine (`src/revm.ts`)

`effectiveGasPrice: outcome.effectiveGasPrice` (revm's own `Transaction::effective_gas_price`) replaced with a hand-rolled `baseFee + maxPriorityFeePerGas` for the 1559 family — i.e. the recomputation this task exists to prevent, written the way it is most often written: without the `min(maxFeePerGas, …)` cap.

```
mismatches:
  fee1559Capped.effectiveGasPrice: reference=9 underTest=12
violations:
  fee1559Capped/underTest.senderPaid:       got 189250, expected 252250
  fee1559Capped/underTest.coinbaseCredited: got  42000, expected 105000
```

Only the CAPPED case fires (`maxFeePerGas` 9, tip asked 5, base fee 7): where the tip is the binding constraint, the wrong formula and the right one agree. A 1559 case is therefore not one case but two, and only the capped one measures the `min`.

## What the numbers are

The battery runs at a base fee of SEVEN wei so the arithmetic is checkable by eye. The per-case literals live in `test/revm-fees.spec.ts` (`FEES`) and are held against BOTH engines; the split behind every line is `gasUsed * effectiveGasPrice` = the coinbase's `gasUsed * (effectiveGasPrice - 7)` plus the burnt `gasUsed * 7`, with the value on top for the sender.

The task's own worked example is the first row: a 1,000 wei transfer at 21,000 gas and an effective price of 10 charges the sender 211,000, credits the coinbase 63,000 and burns 147,000.
