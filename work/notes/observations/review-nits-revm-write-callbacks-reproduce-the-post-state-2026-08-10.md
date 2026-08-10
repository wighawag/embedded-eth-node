---
title: review-gate non-blocking nits for 'revm-write-callbacks-reproduce-the-post-state' (Gate 2 approve)
date: 2026-08-10
status: open
reviewOf: revm-write-callbacks-reproduce-the-post-state
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'revm-write-callbacks-reproduce-the-post-state' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the DEFAULT-engine behaviour change this task shipped: OverlayStorageStateManager.deleteAccount now clears the account's storage, so in stateMode:'none' every consumer (including those who never touch revm) sees a destroyed contract's slots read zero and dumpState / IndexedDB snapshots stop carrying them. Is aligning 'none' with 'trie' and revm the wanted call, shipped under a revm-scoped task?
  (packages/embedded-eth-node/src/state-manager.ts:389; recorded in the 2026-08-10 amendment to docs/adr/0007, the changeset (minor), README, and the 417.8 -> 417.9 KB baseline re-pin in packages/benchmarks/test/evm.spec.ts. Two lines, easily reversed, and the rejected alternative (narrow the assertion instead) is written down.)
- Ratify the deliberate non-delivery: a deleted account keeps its CODE in 'none' mode on both engines, so dumpState emits a code entry with no account and loadState's putCode resurrects the destroyed address as a codeful zero-nonce account. Should that become a backlog task rather than an open observation?
  (work/notes/observations/none-mode-keeps-a-deleted-accounts-code.md. No cross-engine consequence (both engines are stale identically, so the differential stays green), but it is now the only remaining none-vs-trie asymmetry on deletion, and story 13 of the spec is about persistence behaving as before.)
- Coherence: the repo now has TWO post-state differentials. CONTEXT.md's glossary says the conformance differential already diffs receipts field by field plus post-state (oracle: a trie-backed runTx reference), and this task adds a second battery with a different oracle (a default-engine node in the same state mode, plus a structural dumpState comparison). Should CONTEXT.md or the new file header pin which differential owns which post-state question, so the next author knows where a new shape goes?
  (packages/embedded-eth-node/test/helpers/post-state.ts header explains why it is not the gas gate, but not why it is not folded into helpers/conformance.ts, whose post-state reads run with the revm engine installed via helpers/revm-conformance.ts.)
- Nit: the selfdestruct probe in slim-node-checks asserts the destroyed contract's code is 0x and comments that this shows it was destroyed rather than merely emptied, but the fixture dies in its constructor and never deploys code, so that check cannot fail and does not measure code removal (which, per the observation note, does not happen in 'none' mode). Worth re-wording so a reader does not read it as coverage of code deletion.
  (packages/embedded-eth-node/test/helpers/slim-node-checks.ts, shape 8; SD_INIT is PUSH1 2a PUSH1 00 SSTORE then PUSH20 beneficiary SELFDESTRUCT.)
