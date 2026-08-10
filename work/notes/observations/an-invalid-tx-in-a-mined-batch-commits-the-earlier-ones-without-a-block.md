# An invalid transaction in a mined BATCH commits the earlier ones without a block

Spotted 2026-08-10 while building `replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors`. Pre-existing, not introduced by it: the engines threw at the same point in the same loop before the node started refusing these itself.

`executeAndMine` in `packages/embedded-eth-node/src/node.ts` executes the batch tx by tx and calls `storeBlock` only after the loop, so a refusal part-way through leaves the EARLIER transactions' state changes committed with NO block, NO receipts and no `latestNumber` advance. On a `manual`-mining node, submitting nonce 0 and nonce 5 and then calling `node.mine()` throws `nonce too high` and leaves the sender's nonce at 1 and the recipient one wei richer at block number 0 — state a consumer cannot see through any block or receipt, and which the next `mine()` will build on. A real node would drop the offending transaction from the block and mine the rest.

Auto mining (the default) is unaffected: its batch is one transaction, so the refusal takes nothing else down with it.
