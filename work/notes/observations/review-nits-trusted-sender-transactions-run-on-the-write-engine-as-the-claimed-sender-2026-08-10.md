---
title: review-gate non-blocking nits for 'trusted-sender-transactions-run-on-the-write-engine-as-the-claimed-sender' (Gate 2 approve)
date: 2026-08-10
status: open
reviewOf: trusted-sender-transactions-run-on-the-write-engine-as-the-claimed-sender
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'trusted-sender-transactions-run-on-the-write-engine-as-the-claimed-sender' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- RATIFY: the instance-shadowing mechanism was RELOCATED, not deleted. The default engine builds a per-call prototype view of the transaction whose getSenderAddress returns request.sender (asSender in src/engine.ts). The task asked for the shadowing trick to be gone from the transaction path; the agent read that as gone from the NODE and kept a scoped bridge inside the @ethereumjs engine, since runTx has no sender option. Is that reading ratified? Note the fragility the doc does not mention: the view has NO own properties, so any future @ethereumjs/vm that spreads, clones or enumerates the tx (structuredClone, Object.keys, JSON) would see an empty object rather than the transaction.
  (packages/embedded-eth-node/src/engine.ts:181-186 (Object.create(tx, {getSenderAddress: {value: () => sender}})) vs the task criterion 'the instance-shadowing trick is gone from the transaction path rather than left as a second mechanism'. The node itself is clean: parseTx parses FROZEN in both sender modes and carries sender as data.)
- RATIFY a new user-visible refusal: sender recovery is now EAGER in parseTx, so a transaction whose signature cannot be recovered is rejected by the eth_sendRawTransaction* call rather than by a later mine() in manual/interval mining. It surfaces as the raw @ethereumjs error (no RpcError wrapping, no error-code contract) and no test pins the new timing or shape. Intended, and does it need to be in the node's own error vocabulary?
  (packages/embedded-eth-node/src/node.ts:551-557; recorded in the changeset and in the parseTx JSDoc. Overlaps work/tasks/backlog/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors.md, which owns 'each rejection reaches the caller as the node's own error'.)
- COHERENCE: the word 'pin' now has two statuses. CONTEXT.md's sender-mode entry declares it RETIRED, while ADR 0006 amendment 3 and src/engine.ts reuse it for the engine-side per-call bridge (PINNED FOR runTx, 'the pin lives for exactly one call'). Either narrow the glossary sentence to 'pin no longer means shadowing on the node's instance' or pick another word in the engine, so the next author is not told a live term is dead.
  (CONTEXT.md:16 ('The word pin is retired here') vs docs/adr/0006-...:49 and packages/embedded-eth-node/src/engine.ts:121-122,171.)
- The unreleased changeset .changeset/engine-seam-covers-transactions.md still describes TransactionRequest as 'the signed transaction the node parsed, plus the block it is mined in' — one field short as of this commit. Both entries ship in the same release notes; worth a one-line amend so the composed CHANGELOG does not define the type twice, differently.
  (.changeset/engine-seam-covers-transactions.md:24-25 vs .changeset/trusted-sender-crosses-the-seam.md:9.)
