# Task for reviewer

You are running the REVIEW PROTOCOL over a set of newly-authored work/ tasks in the repo at your cwd (/home/wighawag/.drive-scratch/conductor). Work ONLY from what is on disk. Do not trust any summary; read the actual files.

STEP 1. Read work/protocol/REVIEW-PROTOCOL.md in full. It is the standard you must apply: five lenses IN ORDER, ending in the destination check, with the emitted-verdict shape it specifies. Also read work/protocol/TASKING-PROTOCOL.md (the standard the artifact under review was produced against) and work/protocol/WORK-CONTRACT.md (the on-disk contract).

STEP 2. The ARTIFACT UNDER REVIEW is the tasking output for the spec work/specs/tasked/revm-engine-behind-runtx.md, namely these 12 task files in work/tasks/backlog/:
  re-widen-the-engine-seam-to-cover-transactions
  revm-executes-the-first-transaction-with-commit
  revm-write-callbacks-reproduce-the-post-state
  fees-refunds-and-effective-gas-price-come-from-the-engine
  replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors
  logs-and-the-logs-bloom-come-from-the-engine
  eip-2930-access-lists-are-charged-and-warmed
  the-conformance-differential-covers-transactions-on-revm
  every-node-feature-survives-a-revm-write-engine
  sender-recovery-uses-the-engines-ecrecover
  document-the-type-3-receipt-gap-where-it-would-be-met
  measure-what-transactions-on-revm-actually-cost
plus the trimmed spec itself and the fact that it was moved into work/specs/tasked/.

STEP 3. Apply the lenses ADVERSARIALLY. Try to break this task set. In particular VERIFY CLAIMS AGAINST THE REAL CODE rather than believing the task bodies: the source is packages/embedded-eth-node/src/, the tests are packages/embedded-eth-node/test/, there is a second package packages/benchmarks/, the decisions are in docs/adr/, and the measured evidence is in docs/spikes/. Useful things to check for yourself with grep/read: does every symbol, module, behaviour and file a task claims to exist actually exist and have the assumed shape; is the dependency graph coherent and acyclic; does every blockedBy slug resolve to a real task in work/tasks/backlog/ or work/tasks/done/; is every user story of the spec covered exactly once with no holes and no orphan tasks; is any task built on a premise that the code contradicts; are there two tasks that will collide on the same files without an ordering between them; are the gate axes (humanOnly, needsAnswers) honest; is each ## Prompt genuinely self-contained.

Note that the node depends on the npm package revm-wasm; if you need its API surface, its type declarations are under packages/embedded-eth-node/node_modules/revm-wasm/dist/*.d.ts (they may need a pnpm install first, which you may run READ-ONLY-ish if you wish, or you may simply flag anything you could not verify).

STEP 4. Weight findings by REAL impact, per the protocol's rule 7: who hits this, and what breaks? Do not report checklist conformance misses that nobody would ever be bitten by. A technically-true nit is not a block.

CONSTRAINTS. You are a REVIEWER: emit a verdict and WRITE NOTHING. Do not edit, create, move or delete any file. Do not commit, stage or push anything. Do not run the test suite or any build. Read, grep and reason.

OUTPUT. End your reply with the protocol's verdict JSON, minified on ONE line, exactly as the protocol's "Your output" section specifies (verdict is approve or block; findings is an array of {severity, question, context}). Before the JSON, give a short plain-prose summary of what you checked and what you found, and explicitly list anything you were UNABLE to verify. Be concrete: name files and line numbers. If you find nothing blocking, say so plainly rather than inventing a block.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```