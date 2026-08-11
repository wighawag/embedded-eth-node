---
title: review-gate non-blocking nits for 'every-node-feature-survives-a-revm-write-engine' (Gate 2 approve)
date: 2026-08-11
status: open
reviewOf: every-node-feature-survives-a-revm-write-engine
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'every-node-feature-survives-a-revm-write-engine' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: the pre-existing dump/load round trip in helpers/slim-node-checks.ts was NOT parameterised by engine, which a literal reading of acceptance criterion 1 (the persistence-reload, genesis-cheats and dump/load suites run on BOTH engines) asks for. Instead a new engine-parameterised suite was added and slim-node-checks stays default-engine-only. Is that substitution accepted?
  (helpers/state-roundtrip.ts header (WHY THE DUMP/LOAD ROUND TRIP LIVES HERE) argues slim-node-checks is a multi-mode honesty suite building trie nodes and stub engines meant to be refused, so parameterising it would drop or fake its trie half. The substitute is stronger (dump reload plus a follow-on transaction, on both engines), so the story-13 goal is met.)
- Ratify a cross-test default: the revm persistence run writes to its own IndexedDB database name rather than sharing the default run's. Correct isolation, but it is an unrecorded convention a third engine must remember to repeat.
  (test/helpers/revm-persistence-reload.ts defines DB as slim-reload-test-revm; PersistenceOptions.db in helpers/persistence-reload.ts defaults to the original name so the default spec is untouched.)
- Consistency: state-roundtrip.ts proves WHICH EVM ran by counting at the seam (countingEngines) and its own header says node.engine.id is not enough, yet the two sibling revm suites added in the same commit assert only engineId. Should they adopt the same seam count?
  (revm-genesis-cheats.spec.ts asserts s.customGenesis.engineId and s.cheats.engineId; revm-persistence-reload.spec.ts asserts write.engineId / read.engineId. Real impact is low, since transact is required and there is no second EVM to fall back to.)
- Vacuous reading: cheats.secondTxNonce is filled from the compile-time constant CHEAT_SENDER_NONCE and then asserted against that same constant in both specs, so it measures nothing while being documented as the cheated nonce the second transaction was accepted at. Read it from the node, or drop the field.
  (test/helpers/state-roundtrip.ts sets secondTxNonce: String(CHEAT_SENDER_NONCE); the load-bearing evidence is cheatSenderNonceAfter (6, read via eth_getTransactionCount) plus the fact that the transaction was admitted at all.)
- Claim precision: the README paragraph and the new suite headers assert that every other differential in this repo lives inside ONE transaction. The conformance battery and the post-state differential each run many transactions against a single node, so the accurate narrower claim is that they never mutate state OUTSIDE a transaction, which is what makes a write-through cache invisible to them.
  (README.md new paragraph; helpers/state-roundtrip.ts and revm-state-roundtrip.spec.ts headers. The control run in docs/spikes/.../measurements.md supports the substance; only the generalisation is loose.)
- Ratify: assertions in the pre-existing genesis-cheats-perf.spec.ts were rewritten to reference a new shared module test/genesis-cheats-expected.ts. Values were verified identical, so this is an extraction rather than the assertion edit the task calls a failure signal, but it does touch an existing suite.
  (All eight literals match the originals, including the 1234n * 10n ** 18n and 5n * 10n ** 18n expressions carried over verbatim.)
