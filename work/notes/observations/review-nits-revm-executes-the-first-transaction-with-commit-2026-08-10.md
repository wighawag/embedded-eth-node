---
title: review-gate non-blocking nits for 'revm-executes-the-first-transaction-with-commit' (Gate 2 approve)
date: 2026-08-10
status: open
reviewOf: revm-executes-the-first-transaction-with-commit
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'revm-executes-the-first-transaction-with-commit' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- RATIFY: EIP-4844 blob fields are deliberately not mapped, so a type-3 transaction on a revm-backed node executes as a 1559 one (BLOBHASH answers zero, blob gas is not charged) where the default engine charges and validates it. The binding DOES accept blobVersionedHashes / maxFeePerBlobGas (revm-wasm 0.3.1 ExecuteOptions), so this is a choice, and it is silence rather than the loud refusal this repo prefers elsewhere. It also stales the premise of the owning backlog task document-the-type-3-receipt-gap-where-it-would-be-met, which asserts revm supports blob transactions fully and only two RECEIPT fields are missing.
  (packages/embedded-eth-node/src/revm.ts:462-471 (NOT MAPPED comment) vs work/tasks/backlog/document-the-type-3-receipt-gap-where-it-would-be-met.md, first paragraph.)
- RATIFY a new user-visible divergence the task did not specify: a transaction whose gasLimit exceeds blockGasLimit is now REJECTED on a revm-backed node (CallerGasLimitMoreThanBlock) and still accepted on the default engine, because the node passes skipBlockGasLimitValidation to runTx and revm has no committing equivalent. It is reasoned and documented in three places, but it is a behaviour change for a revm-backed node and no task owns it.
  (packages/embedded-eth-node/src/revm.ts transact options comment (ONE CONSEQUENCE...), README.md scope section, .changeset/revm-executes-transactions.md.)
- RATIFY the new error surface on the mining path: revm reports an invalid transaction as an outcome, and the engine converts it to a thrown plain Error carrying revm's message verbatim (e.g. NonceTooLow), rather than one of the node's own RpcErrors. Shape parity with runTx (which throws) is right; the message/code parity is deferred to replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors. Confirm the interim wording is acceptable to ship.
  (packages/embedded-eth-node/src/revm.ts, the validation-error branch of transact.)
- The sender criterion is met by convention plus a comment rather than structurally, and its test cannot detect a regression: TransactionRequest still carries no explicit sender field, the engine reads request.tx.getSenderAddress() (authoritative in trusted mode only because node.ts shadows that method on the instance), and the only assertion runs in recover mode where the claimed and recovered senders are equal, so an engine that recovered its own sender would pass it. The end-to-end trusted-mode proof is deferred by the task itself; flagging so the residue is visible to whoever builds trusted-sender-transactions-run-on-the-write-engine-as-the-claimed-sender.
  (src/revm.ts transact (const sender = request.tx.getSenderAddress().bytes), src/types.ts TransactionRequest, test/helpers/revm-engine.ts (transactFrom vs transactFromExpected).)
- RATIFY a cross-artifact edit: this change rewrote the ALREADY-LANDED sibling changeset .changeset/engine-seam-covers-transactions.md into the past tense so it no longer advertises an optional transact. The reasoning (both entries land under one version heading, so no published version ever shipped the optional marker) is sound and stated in the file, but it edits another task's artifact and rewrites its released-facing claim.
  (.changeset/engine-seam-covers-transactions.md, lines 17 and 44-56.)
