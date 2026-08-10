---
title: review-gate non-blocking nits for 'replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors' (Gate 2 approve)
date: 2026-08-10
status: open
reviewOf: replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- New JSDoc on upfrontCost claims a type-3 (blob) transaction is admitted by the node and refused by the engine as the backstop; the repo's own verified observation says the node cannot PARSE a type-3 transaction at all (createTxFromRLP throws above the seam for want of customCrypto.kzg), so it never reaches upfrontCost or any engine. The same false shape is repeated in the new revm.ts comment (a type-3 transaction's blob fee listed as a cause that still reaches the validation-error line). Should these two sentences be corrected, given the observation already flagged this exact falsehood in revm.ts?
  (packages/embedded-eth-node/src/node.ts upfrontCost JSDoc and src/revm.ts transact comment vs work/notes/observations/the-node-cannot-parse-a-type-3-transaction-at-all.md)
- A transaction whose maxFeePerGas (or legacy gasPrice) is below the block's base fee (default 1 gwei, so gasPrice 0 or a stale fee is a common dev case) is still NOT pre-checked by the node: it surfaces engine-shaped text with no JSON-RPC code and differs by engine, which is the same divergence class this task removed for the other four. It is out of the task's four cases, but the new revm.ts comment enumerates what still reaches the backstop as EIP-3607, blob fee, anything a later revm adds, omitting it. Follow-up task, or amend the enumeration?
  (src/node.ts has no base-fee refusal; refuseIfSenderCannotSend covers nonce + funds only; baseFeePerGas defaults to 1_000_000_000n at src/node.ts:180)
- The intrinsic-gas refusal tells the caller: eth_estimateGas reports what a transaction needs. For the very case the diff added (a type-1 transaction with an access list) eth_estimateGas uses the shared intrinsicGas() with no access-list term and ignores the request's accessList, so it under-reports by 6,200 and points the user at a number that would be refused again. Should the guidance half be qualified for access-list transactions?
  (refuseIfBelowIntrinsicGas message in src/node.ts vs eth_estimateGas at src/node.ts:1015-1029 (no accessList read))
- RATIFY the user-visible refusal contract: geth's leading clauses (nonce too low / nonce too high / insufficient funds for gas * price + value / intrinsic gas too low), RpcError code -32000, and no data field. Consumers branching on error text or code inherit this permanently, and the phrases are now pinned character-for-character in a spec.
  (decisions 2 and 3 in docs/spikes/.../measurements.md; asserted in test/revm-invalid-transactions.spec.ts CLAUSES)
- RATIFY the timing split: the intrinsic-gas floor is now refused EAGERLY at submit, so under manual/interval mining the throw moves from mine() to the eth_sendRawTransaction call, while nonce and funds stay at mine time. That is a behaviour change for a queueing consumer even though the outcome set is unchanged.
  (submit() calls refuseIfBelowIntrinsicGas at src/node.ts:824; refuseIfSenderCannotSend runs inside executeAndMine; decision 4 in measurements.md)
- RATIFY the shared bundle baseline re-pin: DEFAULT_ENTRY_BASELINE goes 417.9 to 419.7 KB raw / 126.0 to 126.6 KB gzip, i.e. 1.8 KB of refusal prose paid by every consumer including the JS-only one. It is argued for and precedented, but it is a cross-task shared assertion other tasks also move.
  (packages/benchmarks/test/evm.spec.ts DEFAULT_ENTRY_BASELINE)
- The captured observation (an invalid tx in a mined BATCH commits the earlier ones with no block) is real and correctly labelled pre-existing, but nothing tasks it: mineBlock splices pending before executing, so a mid-batch refusal also DROPS the rest of the batch while the earlier transactions' state stays committed and invisible. Should this become a task now that the node itself is the thing that throws mid-loop?
  (mineBlock at src/node.ts:548-551 (pending.splice) plus storeBlock only after the loop; work/notes/observations/an-invalid-tx-in-a-mined-batch-commits-the-earlier-ones-without-a-block.md)
