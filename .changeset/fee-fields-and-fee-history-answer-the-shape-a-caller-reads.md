---
'embedded-eth-node': patch
---

**Two RPC responses now have the SHAPE a caller reads, not merely the right values.** Both came out of a downstream debugging session where the symptom was the same unhelpful sentence, `Cannot mix BigInt and other types`, thrown far from the node that caused it. Neither changes a number; both change what a consumer's ordinary idiom does with the answer.

**`eth_feeHistory` returns one `reward` entry per REQUESTED percentile, per block.** It ignored `rewardPercentiles` and always answered a single entry per block, so a caller asking for several and INDEXING them read `undefined` at every index but the first: rocketh requests `[10, 50, 80]` and reads indices 1 and 2. This node has a flat fee model, so every percentile carries the same value — but the shape has to match the request, and a response that is well-formed enough to parse while being wrong for anybody who indexes it is the hardest kind to trace back.

**`eth_getTransactionByHash` OMITS `maxFeePerGas` / `maxPriorityFeePerGas` on a legacy transaction** instead of reporting them as `null`, which is what geth does. The difference is not cosmetic: `'maxFeePerGas' in tx` is the standard way to tell a 1559 transaction from a legacy one, so a key that EXISTS and is `null` routes the caller down the 1559 branch, which then dies on `BigInt(null)`. A key that exists only when it means something keeps that idiom honest. A type-2 transaction still carries both.

Both are now asserted rather than described, and each assertion is the one a value check would miss. The fee-history widths are held for a 3-percentile request AND a 1-percentile one (`viem-surface`), so a hardcoded 3 fails as loudly as a hardcoded 1, and the values are deliberately not asserted because a flat fee model makes them all equal. The fee fields are read by PRESENCE with `in`, off the raw JSON-RPC object rather than through viem (which normalises the shape away), on BOTH transaction types from the same node (`slim-node-checks`), because omitting them always would satisfy the legacy half while breaking every 1559 consumer. Each assertion was confirmed RED against the previous behaviour.
