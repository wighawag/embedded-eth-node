---
title: Three work items still cite the observation note discharged by the return-data fix
date: 2026-08-10
---

`stop-forwarding-revms-validation-error-text-as-eth-call-return-data` deleted `work/notes/observations/revm-validation-errors-surface-their-message-as-eth-call-return-data.md` (its own acceptance criterion), and three item bodies still point at that path: `work/tasks/backlog/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors.md` (twice, one of them its stated block), and `work/tasks/ready/close-the-residual-holes-in-the-affordability-classification.md` (twice). Not touched here, since another item's body is not this task's to edit.

Two of them are now more than stale pointers. `close-the-residual-holes…` item 1 asks to BOUND the tolerance in `isCalleeAnswer()`; that tolerance is GONE (revm no longer forwards its validation text, so any return data is the callee's) and the `insufficient funds` hole it names is closed, which likely leaves that item with three of its four findings. And `replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors` is blocked on the decision this change made: revm's reason is quoted VERBATIM inside a node-voiced refusal on `ReadCallResult.error` and translated into no node vocabulary, deliberately, so that the transaction path can own that vocabulary in one place (see the `rejectionMessage` JSDoc in `packages/embedded-eth-node/src/revm.ts`).
