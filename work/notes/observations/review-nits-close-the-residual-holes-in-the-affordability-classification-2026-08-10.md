---
title: review-gate non-blocking nits for 'close-the-residual-holes-in-the-affordability-classification' (Gate 2 approve)
date: 2026-08-10
status: open
reviewOf: close-the-residual-holes-in-the-affordability-classification
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'close-the-residual-holes-in-the-affordability-classification' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The per-fork measurement only covers revm-engine.ts's copy of the fixture. The conformance battery executes its OWN verbatim copy of REVERT_WITH_REASON_CODE, and the new REVERT_NAMING_FUNDS_CODE is asserted PUSH0-free by comment only, never executed anywhere but the node's pinned fork. Reverting the conformance copy to a PUSH0 form (or adding PUSH0 to the funds-naming fixture) would go unnoticed by controlAtFork. Is the named follow-up enough, or should the byte-identity be asserted now?
  (test/helpers/conformance.ts:88-118 (both fixtures) vs test/helpers/revm-engine.ts:940-990 (controlAtFork loop, which reads only its own constant). Follow-up work/tasks/backlog/share-the-revert-with-reason-fixture-between-the-two-test-helpers.md exists and is cited at both sites.)
- Ratify the two decisions the task delegated: (a) the insufficient-funds regression control IS issued even though it passes by construction against an emptiness test, and (b) NO bare REVERT 0,0 control is issued, on the ground that such a callee is indistinguishable from a refused transfer above the seam and would therefore fail the control loop rather than act as one. Both readings check out against the code; confirm the direction.
  (test/helpers/conformance.ts:1117-1160 (reasoning recorded at the controls); classifyValueRead in test/helpers/affordability.ts returns REJECTED for code 3 with empty data, so a bare revert genuinely cannot be issued in this control shape.)
- Ratify: the per-fork control execution runs on the DEFAULT engine only (berlin..cancun), not on revm, on the argument that ethereumjs's per-fork opcode table is the authority on bytecode validity at a fork. revm's own per-spec opcode admission is therefore never exercised for this fixture below cancun.
  (test/helpers/revm-engine.ts:952-990, comment beginning On the DEFAULT engine deliberately.)
- Ratify the new mechanism: the fork is derived by constructing a throwaway createNode() with a non-executing fork-probe engine that only records context.common, then disposing it. It derives the fork createNode DEFAULTS to (the probe node is built with none of the options the nodes under test use), which is identical today because node.ts hardcodes Hardfork.Cancun, but would not track a future per-node fork option.
  (test/helpers/revm-engine.ts:194-235 (nodePinnedCommon) vs src/node.ts:149-153 (Common built with hardfork: Hardfork.Cancun, no option).)
- No Decisions block was recorded for this change: the commit message is the one-line title only, and the decisions above live solely in code comments. Should the runner require the block so a human ratifies from the PR rather than from the diff?
  (git log -1 shows only the feat(...) subject; no Decisions section anywhere in the change.)
- The backlog task share-the-revert-with-reason-fixture-between-the-two-test-helpers still states the fixture uses PUSH0 and points at this task's item 4 as the owner of making it portable. That is now stale; its encoding note should read as settled.
  (work/tasks/backlog/share-the-revert-with-reason-fixture-between-the-two-test-helpers.md, Worth carrying while you are there paragraph. Its Prompt does carry a drift-check, so the risk is low.)
