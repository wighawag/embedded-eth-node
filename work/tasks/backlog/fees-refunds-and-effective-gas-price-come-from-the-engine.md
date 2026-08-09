---
title: Fees, refunds and effectiveGasPrice come from the engine, not from a second implementation in JS
slug: fees-refunds-and-effective-gas-price-come-from-the-engine
spec: revm-engine-behind-runtx
blockedBy: [revm-write-callbacks-reproduce-the-post-state]
covers: [3, 4]
---

## What to build

A transaction's money must be real: the sender is charged `value + gasUsed * effectiveGasPrice`, the coinbase is credited the priority portion, and the base fee is burnt. On the revm path the engine already does all of that inside its committing execute, and its outcome carries the effective gas price it actually used. Take that number. Do NOT recompute `min(maxFee, baseFee + tip)` in JS beside it: a second implementation of fee arithmetic is precisely the drift this spec exists to avoid, and it is the field the engine's own authors expect to disagree first.

The node currently computes `effectiveGasPrice` in JS for its receipts. After this task that JS computation is the DEFAULT engine's implementation of the seam's contract and nothing else: it lives behind the default engine, the revm engine answers from its outcome, and the receipt takes whatever the engine that ran the transaction reported. One implementation per engine, none in the node.

Refunds are the case a hand-rolled version gets wrong, so cover it: a storage-clearing refund is priced at the EFFECTIVE gas price, and the node must not price it any other way. Include a transaction that clears storage and check both the gas and the resulting balances against `@ethereumjs/vm`.

Where the first disagreement is most likely, per the engine's own authors, and therefore what to test first: `effectiveGasPrice` on a LEGACY transaction with a non-zero base fee, and the zero-priority-fee coinbase that vanishes from post-state under EIP-161.

Measured on the engine side, so a wrong answer is recognisable rather than merely different: for a 1,000 wei transfer at 21,000 gas and an effective price of 10, the sender is charged 211,000, the coinbase is credited 63,000 with a base fee of 7, and 147,000 is burnt.

## Acceptance criteria

- [ ] `effectiveGasPrice` on a receipt comes from the engine that executed the transaction; the node contains no fee arithmetic of its own on either path.
- [ ] Sender charged, coinbase credited and base fee burnt match `@ethereumjs/vm` exactly, for legacy, EIP-2930 and EIP-1559 transactions, asserted on balances rather than only on the receipt.
- [ ] A legacy transaction under a non-zero base fee is covered explicitly, as the most likely first disagreement.
- [ ] A storage-clearing refund is priced at the effective gas price and matches `@ethereumjs/vm` in both gas and resulting balances.
- [ ] The zero-priority-fee coinbase case is covered and its EIP-161 disappearance asserted as expected on both engines.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- `revm-write-callbacks-reproduce-the-post-state` — balances must already be trustworthy before fees can be judged on them, and both tasks own the same files.

## Prompt

> Goal: exactly one implementation of fee arithmetic per engine, and none in the node. Then prove the money is right by diffing balances, not receipts.
>
> FIRST, check this task against current reality: it was written on 2026-08-09 and may have DRIFTED. Confirm where the node still computes a fee, and confirm the engine seam's transaction result carries an effective gas price at all. If an earlier task already moved the arithmetic, narrow this one rather than redoing it.
>
> Read where the node currently computes `effectiveGasPrice` for receipts, the engine seam's transaction result, and the binding's outcome (its last field is the effective gas price it used).
>
> DELETE, DO NOT DUPLICATE. If after this task the node can still compute a fee itself, the task failed: the whole point of story 4 is that the number has one source, so a fee bug shows up as a diff between engines rather than as two subtly different right-looking answers.
>
> Assert on BALANCES. A receipt can carry the right `effectiveGasPrice` while the wrong amount left the sender. The cross-backend gas gate cannot see this class of bug at all.
>
> Test the legacy-transaction-under-a-non-zero-base-fee case first: it is where the engine's own authors expect the first disagreement.
>
> Refunds are priced at the effective gas price. A storage-clearing transaction is the case that catches a version that prices them any other way.
