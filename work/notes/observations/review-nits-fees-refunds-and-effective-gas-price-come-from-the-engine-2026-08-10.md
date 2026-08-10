---
title: review-gate non-blocking nits for 'fees-refunds-and-effective-gas-price-come-from-the-engine' (Gate 2 approve)
date: 2026-08-10
status: open
reviewOf: fees-refunds-and-effective-gas-price-come-from-the-engine
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'fees-refunds-and-effective-gas-price-come-from-the-engine' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the narrowing: this branch changes ZERO library source (only tests + docs + a changeset). Is that the intended shape of the task? I verified it is correct against the bytes: the JS arithmetic lives behind the default engine (src/engine.ts effectiveGasPrice(), landed by re-widen-the-engine-seam-to-cover-transactions), the revm engine reports revm's own outcome value (src/revm.ts:588, landed by revm-executes-the-first-transaction-with-commit), and the node only copies it (src/node.ts:456). So the de-drift note held and only the proof was owed.
  (git show --stat 51628dd lists only test helpers, revm-fees.spec.ts, README.md, docs/spikes/.../measurements.md and a changeset.)
- No Decisions block was recorded anywhere (the commit body is empty and there is no PR-description artifact in the tree). The in-scope choices I found and think a human should ratify are listed in the other findings; please confirm none are missing.
  (git show 51628dd --no-patch shows a single subject line, no body.)
- Ratify shipping a patch-level changeset for a tests-only change (.changeset/fees-and-refunds-match-across-engines.md). It cuts a published version of embedded-eth-node with no library-code delta. Precedent is mixed: post-state-matches-across-engines.md is minor but carried a real behaviour change.
  (.changeset/fees-and-refunds-match-across-engines.md ends with 'Tests only - no library code changed'.)
- Cross-task interaction to de-drift before someone claims it: the new access2930 case pins gasUsed 25300 (21000 + 2400 + 1900) absolutely on BOTH engines, so the revm path is now MEASURED to charge an access list. The backlog task eip-2930-access-lists-are-charged-and-warmed still reads as if that mapping and its load-bearing proof are outstanding; its first two clauses are now largely discharged (src/revm.ts already maps accessList and even names that task in a comment). Re-scope it to the WARMING half plus the untouched-entries and address-only shapes.
  (packages/embedded-eth-node/test/revm-fees.spec.ts FEES.access2930 vs work/tasks/backlog/eip-2930-access-lists-are-charged-and-warmed.md)
- Test-only fixture choices made by the agent, none specified by the task: base fee 7 wei instead of the node default gwei, a pinned timestamp and a distinctive coinbase, a hand-written 6-byte clearer contract, and a revm-only 'fees' cut mode rather than a mode on the shared cut.ts. All are documented in place and follow the post-state precedent; flagged only so they are ratified rather than assumed.
  (packages/embedded-eth-node/test/helpers/fees.ts BASE_FEE/COINBASE/TIMESTAMP/CLEARER, test/helpers/cut-revm.ts mode 'fees')
- Naming nit inside the report struct: the refund setup guards (slot was already zero / slot never cleared) push into mismatches, which the type documents as 'every case/field the two engines disagreed about'. A setup failure is not a cross-engine disagreement, so a red run reports it under the wrong vocabulary. A separate setupFailures field (or violations) would read truthfully; the run still goes red either way.
  (packages/embedded-eth-node/test/helpers/fees.ts, the two refundClear.setup / refundClear.result pushes)
