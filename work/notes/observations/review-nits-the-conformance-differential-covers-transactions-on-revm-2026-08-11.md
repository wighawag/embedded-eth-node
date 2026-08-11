---
title: review-gate non-blocking nits for 'the-conformance-differential-covers-transactions-on-revm' (Gate 2 approve)
date: 2026-08-11
status: open
reviewOf: the-conformance-differential-covers-transactions-on-revm
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'the-conformance-differential-covers-transactions-on-revm' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The engine-execution bar is a FLOOR (20) while the battery hands the engine close to thirty transactions, so a PARTIAL regression (say five of thirty going back to an in-node path) would still pass. The battery already knows how many transactions it submitted; asserting that exact number instead of a floor would close the slack. Worth doing, or is the floor deliberate given there is exactly one transact call site (src/node.ts:466)?
  (MIN_TRANSACTIONS_ON_THE_ENGINE = 20 in test/helpers/conformance.ts, mirrored as a bare 20 literal in test/revm-conformance.spec.ts:97)
- Ratify: transactionsByEngine is null for the unparameterised run, and conformance.spec.ts asserts BOTH the null and the ABSENCE of the new step. That is a new negative assertion on the default battery, so anyone who later finds a way to observe the default engine must move two specs together. Reasonable, but it is a user-visible shape choice on a shared report type.
  (work/notes/observations/decisions-...-2026-08-11.md decision 2; conformance.spec.ts:148-155)
- Ratify: the three negative cases are added to the battery even though the replay and the unaffordable transaction are covered in depth by test/helpers/invalid-transactions.ts and the refund by test/helpers/fees.ts. The justification (those helpers use a default-engine NODE as their reference, the battery uses the independent trie-backed runTx) is sound, but it costs roughly 1.5x the battery transaction count on every conformance run and means edits to those helpers now also have a battery consequence.
  (decisions note item 3; conformance.ts steps 19-21)
- Ratify the decision-record convention this build introduces: work/notes/observations/decisions-<slug>-<date>.md with a new decisionsFor frontmatter field. The observations bucket is defined as spotted, unverified, append-only signals that leave by deletion, and WORK-CONTRACT explicitly warns against back-filling an observation to narrate completed work; a decision record is neither a signal nor deletable-when-stale. It is also still not linked from the done record (a byte-identical rename), which is the fifth instance of an already-captured recurring gap. Where should build decisions live in this repo?
  (WORK-CONTRACT.md lines 73-76; work/notes/observations/gate-2-keeps-finding-decision-records-that-are-not-linked-from-the-done-record.md)
- Oracle language: the new step 22 (every transaction ran on the installed engine) is a step with no reference oracle at all, and it carries no THE ORACLE IS block. The backlog task the-prose-undercounts-the-conformance-batterys-non-reference-oracles tells its builder to COUNT those comment blocks, so this step can be missed in the recount. Relatedly, steps 19-20 pin BOTH node and reference to the literal refused rather than diffing node against reference, while their comment says the oracle IS the reference: stronger in practice, but a reference that stopped refusing would surface as this step failing rather than as a divergence.
  (conformance.ts step 19 comment vs steps 20-22; CONTEXT.md conformance differential entry)
