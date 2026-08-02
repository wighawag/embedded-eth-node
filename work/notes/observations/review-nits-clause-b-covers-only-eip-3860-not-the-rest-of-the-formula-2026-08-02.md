---
title: review-gate non-blocking nits for 'clause-b-covers-only-eip-3860-not-the-rest-of-the-formula' (Gate 2 approve)
date: 2026-08-02
status: open
reviewOf: clause-b-covers-only-eip-3860-not-the-rest-of-the-formula
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'clause-b-covers-only-eip-3860-not-the-rest-of-the-formula' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the protocol witness: for the four non-EIP-3860 terms the third party is @ethereumjs/tx's getIntrinsicGas() at that Common, not @ethereumjs/common's activation table as the task criterion literally asked. Is that substitution accepted?
  (test/helpers/revm-engine.ts protocolCharge(); decision 2 in work/notes/observations/decisions-clause-b-...md. Verified independently: 2028 does not appear in @ethereumjs/common's eips table (isActivatedEIP(2028) is false at every fork) and txDataNonZeroGas 68->16 lives in @ethereumjs/tx's paramsTx, so the activation reading would have been vacuous. getIntrinsicGas reads those params and is what runTx charges, so it is strictly stronger.)
- Ratify the inverted tripwire: the suite now ASSERTS that the node disagrees with the protocol at petersburg (node 16 vs protocol/revm 68). A future author who correctly gates EIP-2028 on Common will make that assertion FAIL even though the fix is right. Is asserting the known-wrong reading the intended shape, or should it assert only the protocol/revm boundary?
  (test/revm-engine.spec.ts: expect(c.lowerBoundDisagreements.petersburg).toEqual(['petersburg/non-zero calldata byte (EIP-2028): revm 68, protocol 68, node 16']); decision 3 records the not-gating choice but not this consequence.)
- De-drift the dependent backlog task: readmit-refused-hardforks-once-the-node-can-cost-them.md still tells its builder that clause (b) is enforced for the EIP-3860 term alone and to either land this task first or hand-check EIP-2028. That premise is now stale.
  (work/tasks/backlog/readmit-refused-hardforks-once-the-node-can-cost-them.md:56; the repo de-drifts dependents in a follow-up chore commit (see 68e48f9).)
- Ratify the absolute anchors, and note the decision record overstates them: it says nothing in the widening restates a constant the formula contains, but the spec asserts exact per-party numbers at berlin and cancun (21000 / 16 / 4 / 32000 / 0 and 2).
  (test/revm-engine.spec.ts intrinsicTermReadings.berlin and .cancun vs decision 1's claim. The anchors are defensible (three parties can agree and be uniformly wrong, which is exactly the pre-0.3.1 world) but they are constants, so the record and the code should say the same thing.)
- Ratify no changeset. src is published (package.json files: dist, src), so the shipped JSDoc text changes, though no API, behaviour or gas moves.
  (decision 5; cited precedents cb4c780 (test-only) and 750fbd5 (docs-only) landed without one. A patch changeset is a one-file addition if preferred.)
- ADR 0008's first amendment still names paris as the standing clause-(b) counter-example, which the second amendment made stale by re-admitting it. Pre-existing, but this diff amends the same document and adds a trailer note just above it.
  (docs/adr/0008-...md, first amendment closing paragraph. Adjacent to harden-and-tidy-the-revm-hardfork-tables' citation-hygiene item.)
