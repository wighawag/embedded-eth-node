---
title: Logs and the logs bloom come from the engine, including the log that must NOT appear
slug: logs-and-the-logs-bloom-come-from-the-engine
spec: revm-engine-behind-runtx
blockedBy: [replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors]
covers: [6]
---

## What to build

Receipts carry logs and a 256-byte bloom, and both are fields the conformance differential diffs. Take the bloom FROM THE ENGINE rather than computing it in JS. The reason is single implementation, not speed: a second bloom implementation in JS is the same drift the fee arithmetic just had removed. The speed difference is real and is the tiebreaker, not the case (roughly 0.4 microseconds per keccak against roughly 6.4, so about 24 microseconds on a typical ERC-20 receipt).

The case that must be right and is easy to get wrong: **a log emitted inside a sub-call that later REVERTS does not appear** in the receipt, and does not contribute to the bloom. Cover a transaction with a nested call that emits and then reverts, alongside one that emits and succeeds, and diff the whole receipt against `@ethereumjs/vm`.

Logs also carry positional metadata the node owns and the engine does not: block number, block hash, transaction hash, transaction index, and a log index that is a running total ACROSS the block, not within the transaction. The engine supplies address, topics, data and emission order; the node supplies the rest, exactly as it does today. Keep that division, and make sure a block containing several log-emitting transactions numbers its logs continuously, because that is the part a per-transaction mapping silently gets wrong.

One decoding detail the binding documents and hand-rolled readers get wrong: the 256-byte bloom is present in its outcome ONLY when the log count is non-zero, because a zero-log receipt's bloom is 256 zero bytes the host already knows. Use the package's own decoder.

## Acceptance criteria

- [ ] `logsBloom` on a receipt comes from the engine that executed the transaction; no JS bloom implementation remains on either path.
- [ ] A log emitted inside a reverted sub-call appears in NEITHER the receipt's logs nor its bloom, matching `@ethereumjs/vm`.
- [ ] Logs, topics, data and emission order match `@ethereumjs/vm` field for field for a multi-log transaction.
- [ ] `logIndex` is continuous across a block containing several log-emitting transactions, and block/transaction metadata on each log is unchanged from today.
- [ ] A zero-log transaction produces the all-zero bloom on both engines.
- [ ] `eth_getLogs` returns the same results on both engines for the same block.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- `replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors` — same files; deliberately serialized.

## Prompt

> Goal: one bloom implementation, and a receipt whose logs are right including the ones that must be absent.
>
> Read where the node assembles logs and the bloom into a receipt today, the engine seam's transaction result, and the binding's outcome documentation (its bloom is CONDITIONAL on a non-zero log count, which is the detail that desynchronises a hand-rolled decoder on exactly the calls that are easiest to test with).
>
> THE INTERESTING CASE IS THE ABSENT LOG. A log emitted in a sub-call that then reverts must not appear anywhere, including in the bloom. A receipt that includes it looks completely plausible, and `eth_getLogs` will then report an event that never happened.
>
> Keep the division of labour: the engine owns address, topics, data and order; the node owns block hash, block number, transaction hash, transaction index and the block-wide running `logIndex`. A block with several log-emitting transactions is what catches a per-transaction index.
>
> Do not compute a bloom in JS "just to check". If you want a cross-check, diff the two ENGINES against each other; that is the check that keeps working.
