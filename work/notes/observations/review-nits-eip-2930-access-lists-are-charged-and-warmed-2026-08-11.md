---
title: review-gate non-blocking nits for 'eip-2930-access-lists-are-charged-and-warmed' (Gate 2 approve)
date: 2026-08-11
status: open
reviewOf: eip-2930-access-lists-are-charged-and-warmed
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'eip-2930-access-lists-are-charged-and-warmed' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the user-visible RPC behaviour change: eth_estimateGas now adds 2,400 per access-list address and 1,900 per storage key from the request's accessList field, where it previously ignored the field. The task allowed either this or qualifying the refusal text; the agent chose both (the refusal wording also changed). Is charging it the behaviour you want on this method?
  (packages/embedded-eth-node/src/node.ts eth_estimateGas case + accessListGas in src/intrinsic-gas.ts; recorded in the Decisions block of docs/spikes/eip-2930-access-lists-are-charged-and-warmed/measurements.md and in the changeset)
- Ratify the knowing over-estimate: because the read underneath carries no access list, an entry the transaction really touches is priced cold in the estimate, so eth_estimateGas answers 26005 where the mined transaction pays 23505 (up to 2,500 per touched address, 2,000 per touched key too high). Note geth does NOT have this gap since its estimate also pre-warms the list, so the README phrase saying it is as geth charges it is true only of the charging half. Accept the safe-direction skew, or task the seam widening?
  (ESTIMATES in test/revm-access-list.spec.ts pins 26005 vs GAS addressTouched.listed 23505; rationale in the accessListGas JSDoc and Decision 3)
- Ratify leaving eth_fillTransaction uncharged: it builds a type-0/type-2 envelope and silently drops a requested accessList, so viem's prepareTransactionRequest path loses a list the caller sent, with no honest-edge error. It is captured as an observation note but no backlog task owns closing it. Task it, or accept the silent drop?
  (work/notes/observations/fill-transaction-silently-drops-a-requested-access-list.md; eth_fillTransaction in src/node.ts still estimates with intrinsicGas alone)
- Ratify the deliberate tolerance in accessListGas: it never throws on an odd request, so a non-object entry is skipped, a non-array storageKeys is ignored, an array-shaped entry is still charged 2,400, and duplicate addresses/keys are charged per entry (which matches geth). A malformed request therefore gets a quietly different number instead of an error. Is silent tolerance the right choice for this unvalidated JSON-RPC input?
  (accessListGas loop in packages/embedded-eth-node/src/intrinsic-gas.ts)
- The Decisions block says it is linked from the task's done record, but the task file moved to work/tasks/done unchanged (rename at 100 percent similarity) and carries no link, so the three decisions are discoverable only via the changeset or the spike doc. Worth adding the pointer?
  (git shows R100 for work/tasks/backlog -> work/tasks/done/eip-2930-access-lists-are-charged-and-warmed.md; Decisions block lives in docs/spikes/eip-2930-access-lists-are-charged-and-warmed/measurements.md)
