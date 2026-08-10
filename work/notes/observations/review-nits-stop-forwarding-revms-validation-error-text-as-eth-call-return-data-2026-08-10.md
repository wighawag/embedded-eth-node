---
title: review-gate non-blocking nits for 'stop-forwarding-revms-validation-error-text-as-eth-call-return-data' (Gate 2 approve)
date: 2026-08-10
status: open
reviewOf: stop-forwarding-revms-validation-error-text-as-eth-call-return-data
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'stop-forwarding-revms-validation-error-text-as-eth-call-return-data' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the decision NOT to translate revm's reason into a node vocabulary. The task's suggested shape said the refusal should say 'insufficient funds for transfer' (paraphrased) plus revm's detail; the agent instead emits a generic node-voiced sentence with revm's reason quoted verbatim, arguing at the code site that the per-variant vocabulary belongs to the transaction-path task and must not be forked twice. This is a defensible deviation (the task allowed 'unless you can defend better') and it also protects namesLackOfFunds from being trivially satisfied by boilerplate, but it is the decision the blocked task replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors must now inherit, so a human should ratify it.
  (packages/embedded-eth-node/src/revm.ts:620-652 (rejectionMessage JSDoc); task criterion 3)
- Ratify that the explanation stays BELOW the seam. node.ts discards ReadCallResult.error entirely and always throws code 3 execution reverted, so an RPC client now gets strictly less than before (previously the hex text, misplaced). Criterion 3 says the explanation must survive somewhere a caller can read it: it does, on the exported ReadCallResult.error, symmetrically with the default engine's insufficient balance. Confirm that seam-level readability is the intended bar and that no RPC-visible surface was expected.
  (packages/embedded-eth-node/src/node.ts:833-838, 847-848, 879-881)
- Cross-task interaction left live: work/tasks/ready/close-the-residual-holes-in-the-affordability-classification.md item 1 and its Prompt instruct an agent that the isCalleeAnswer tolerance must NOT simply be deleted, and cite a note this PR deletes. This PR deletes exactly that tolerance, so a claimable READY task now carries a false, load-bearing premise. The agent captured this in a new observation note rather than editing another item's body (correct per protocol), but nothing gates the ready task. Recommend re-scoping it or setting needsAnswers before it can be claimed.
  (work/notes/observations/three-work-items-still-cite-the-deleted-revm-validation-return-data-note.md; work/tasks/ready/close-the-residual-holes-in-the-affordability-classification.md:13,42)
- The changeset claims this was the last known behavioural divergence between the two engines on the forks revm admits. Scoped to the READ path (as the task's Prompt words it) that is right, but the transaction path still diverges in the words a rejection reaches the caller with, and that divergence is open and tasked. Consider narrowing the published sentence to the read path.
  (.changeset/revm-validation-errors-are-not-revert-data.md paragraph 1 vs work/tasks/backlog/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors.md criterion 3)
- REVERT_WITH_REASON_ADDR / _CODE are now duplicated verbatim in test/helpers/conformance.ts and test/helpers/revm-engine.ts rather than shared (the repo already shares the classification vocabulary through test/helpers/affordability.ts). If one copy's bytecode is ever changed, the other helper's expected 0xff payload silently stops describing the same fixture.
  (test/helpers/conformance.ts:93-94 vs test/helpers/revm-engine.ts:252-255)
