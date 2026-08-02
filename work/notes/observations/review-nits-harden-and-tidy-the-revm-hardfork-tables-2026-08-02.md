---
title: review-gate non-blocking nits for 'harden-and-tidy-the-revm-hardfork-tables' (Gate 2 approve)
date: 2026-08-02
status: open
reviewOf: harden-and-tidy-the-revm-hardfork-tables
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'harden-and-tidy-the-revm-hardfork-tables' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the release-bump choice: the changeset marks this a patch, but freezing is a runtime behaviour change for any consumer that previously wrote to REVM_SPEC_BY_HARDFORK / REVM_REFUSED_HARDFORKS (the write now throws a TypeError under strict mode instead of succeeding). Is patch the intended level, or should it be a minor on a 0.x package?
  (.changeset/frozen-fork-tables.md declares patch for embedded-eth-node (version 0.2.0); the task did not specify a bump level.)
- Ratify the citation strategy the task asked the builder to name: ADR 0008 now cites the discharging commits 38e0164 and 40e0c73 rather than dropping the dead note pointers. Both commits are reachable on this history and 38e0164's body does name where each decision now lives, but a bare SHA is a new kind of citation for this repo; confirm it is the preferred durable form.
  (docs/adr/0008-...md lines 58 and 85, replacing the two deleted work/notes/observations/decisions-*.md pointers.)
- The helper records out.tableEditOutcomes but the spec never asserts it, so the strict-mode TypeError the changeset advertises is described and not measured. Worth asserting both edits threw, since the test modules are ESM (always strict).
  (test/helpers/revm-engine.ts records tableEditOutcomes around the two edit attempts; test/revm-engine.spec.ts asserts only tablesFrozen, the two key lists and the prague refusal.)
- Coherence nit: ADR 0008's decision bullet describing the two exports still presents them only as the honest answer to which forks the engine serves, with no mention that they are frozen. A reader who lands on the ADR alone does not learn the guard cannot be assigned away; the freeze rationale lives only in src/revm.ts, README and the changeset.
  (docs/adr/0008-...md line 33 vs the new JSDoc block at src/revm.ts:104-131.)
