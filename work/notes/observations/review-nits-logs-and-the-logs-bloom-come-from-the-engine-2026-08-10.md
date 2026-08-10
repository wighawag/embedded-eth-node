---
title: review-gate non-blocking nits for 'logs-and-the-logs-bloom-come-from-the-engine' (Gate 2 approve)
date: 2026-08-10
status: open
reviewOf: logs-and-the-logs-bloom-come-from-the-engine
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'logs-and-the-logs-bloom-come-from-the-engine' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the drift narrowing: the task's headline move (bloom off JS, onto the engine) was already true before this branch, so the change is TEST-ONLY. Is closing spec story 6 on cases alone acceptable, and is a patch changeset on a no-behaviour-change diff the convention you want?
  (src/engine.ts:152 uses res.bloom.bitvector; src/revm.ts:603 uses the decoded outcome.logsBloom; no JS bloom implementation exists in src/ or test/. .changeset/the-log-that-must-not-appear.md states this openly.)
- Ratify the fixture decision: the new cases live in a SEPARATE DiscardedLogProbe.sol rather than as two functions on ConformanceProbe, to avoid moving the deploy gas that trusted-sender pins as an absolute literal. Agreed, at the cost of one more committed generated helper?
  (test/contracts/DiscardedLogProbe.sol header; test/helpers/discarded-log-probe.ts is auto-generated like counter.ts/probe.ts. Selectors and topic0s in the committed bytecode match the .sol source (verified by keccak).)
- Ratify the assertion strategy for bloom ABSENCE: it is stated as byte-equality against a baseline emitTwo(3,4) receipt plus the reference diff, with no bloom computed test-side, and guarded by a check that the bloom is not all-zero. Sound, but it holds only while the two transactions keep identical addresses/topics; a future edit to either function silently weakens it.
  (test/helpers/conformance.ts step 9, cmp on bloom == baseline plus the ZERO_LOGS_BLOOM guard.)
- Ratify the oracle choice in the new logIndex step: node5 is a separate manual-mining node whose block is NEVER diffed against the @ethereumjs/vm reference, so log address/topics/data on THAT block are only compared to the node's own receipts. Cross-engine equality there rests on step 9 diffing the same functions with different arguments. Is that residual gap acceptable?
  (test/helpers/conformance.ts step 15 comment admits the reference cannot mine this block; acceptance criterion 6 (eth_getLogs same on both engines) is met by transitivity, not directly.)
- A block header's logsBloom is still a hard-coded 256 zero bytes, and the README's zero-placeholder list names only stateRoot/receiptsRoot/transactionsRoot. A consumer that pre-filters blocks by the header bloom before calling eth_getLogs sees no logs at all. Pre-existing, but adjacent to this task's subject: document it or task it?
  (src/node.ts:72 EMPTY_LOGS_BLOOM, used at src/node.ts:861 in blockToRpc; README.md:151 lists the placeholders without mentioning logsBloom.)
- Label-assertion asymmetry: revm-conformance.spec.ts names all four new step labels, conformance.spec.ts names only two (the discarded-sub-call and logIndex steps), so the zero-log-bloom and reverted-top-level steps are guarded on the default engine only by the steps.length >= 20 bar. Worth naming them there too?
  (test/conformance.spec.ts vs test/revm-conformance.spec.ts in commit 80ab9cf.)
