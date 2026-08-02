---
title: review-gate non-blocking nits for 'context-md-conformance-differential-covers-both-oracles' (Gate 2 approve)
date: 2026-08-02
status: open
reviewOf: context-md-conformance-differential-covers-both-oracles
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'context-md-conformance-differential-covers-both-oracles' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The entry says the block-environment step diffs the contract-read values against the node's own block, but two of the six (COINBASE, PREVRANDAO) are diffed against the blockEnv the node was CONFIGURED with, not against the reported block, because eth_getBlockByNumber carries neither. Worth tightening to 'the node's own block plus the blockEnv it was configured with' (the task's own wording) so a reader does not go looking for miner/mixHash in the RPC block.
  (CONTEXT.md:18 vs packages/embedded-eth-node/test/helpers/conformance.ts:918-923 and work/notes/observations/rpc-block-omits-coinbase-and-prevrandao.md)
- The entry says the value-bearing step pins an absolute succeed/fail statement per sender; the step actually pins it per sender AND per value, to the wei (value == balance passes, value == balance + 1 fails), which is the load-bearing half. Adding 'and per value' would match the code comment.
  (conformance.ts:949-957 (THE ORACLE IS ABSOLUTE ... per sender and per value))
- README.md still describes the same battery in the old single-oracle framing (a battery of signed txs through both the node and the reference, asserting field-by-field equality), so the drift this task closed in CONTEXT.md survives on the README surface. The task fenced itself to the glossary deliberately, so this is a follow-up, not a miss: does the human want a README sentence too?
  (README.md:417-420)
- Unrelated live dead-citation spotted while checking the pointer target: docs/spikes/revm-wasm-upgrade-honest-block-environment/measurements.md cites decision 6 of the decisions-revm-wasm-... note that was discharged by deletion in 38e0164. Same class of unresolvable citation that harden-and-tidy-the-revm-hardfork-tables fixed in ADR 0008.
  (docs/spikes/revm-wasm-upgrade-honest-block-environment/measurements.md:38)
- Ratify the one in-scope judgement call: acceptance criterion 2 asks the entry to point at decision 3 of a note path that no longer exists, and the build pointed at the THE ORACLE IS comment blocks instead (per the conductor note) without also naming commit 38e0164, which the note allowed as optional. No Decisions block was recorded on the commit. Is pointing at the code comments alone the citation the maintainer wants, or should the discharge commit be named too?
  (task acceptance criterion 2 + conductor note 2026-08-02; CONTEXT.md:18 final clause)
