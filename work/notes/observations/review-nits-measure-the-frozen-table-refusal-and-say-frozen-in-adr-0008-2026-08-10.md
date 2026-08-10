---
title: review-gate non-blocking nits for 'measure-the-frozen-table-refusal-and-say-frozen-in-adr-0008' (Gate 2 approve)
date: 2026-08-10
status: open
reviewOf: measure-the-frozen-table-refusal-and-say-frozen-in-adr-0008
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'measure-the-frozen-table-refusal-and-say-frozen-in-adr-0008' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: the suite pins only THAT the edit threw, not that it threw a TypeError, while the changeset advertises 'a TypeError in strict mode'. The helper records `threw: ${message}` and drops the constructor name, so `toMatch(/^threw: /)` cannot tell a TypeError from any other throw. Was recording only the message (rather than also e.name / an instanceof TypeError reading) the intended choice, given the task framed this as measuring the advertised TypeError? Cross-browser wording is a reason not to pin the MESSAGE, but the NAME is spec-fixed and identical on V8 and JSC.
  (test/helpers/revm-engine.ts:1222 records `threw: ${String((e as Error)?.message ?? e)}`; test/revm-engine.spec.ts:285-286 assert /^threw: /; .changeset/frozen-fork-tables.md says writing 'now fails at the assignment (a TypeError in strict mode)'.)
- ADR 0008's new sentence says 'writing fails at the consumer's own line' with no strict/sloppy qualifier, while the code JSDoc, the changeset and this very diff's test comment all keep the two halves apart (strict throws, sloppy drops the write silently). A reader of the ADR alone, which is the audience this task exists to serve, takes away a stronger claim than holds. One qualifying clause would close it.
  (docs/adr/0008-...md, Consequences bullet 2 (added text) vs packages/embedded-eth-node/src/revm.ts:141-142 and test/revm-engine.spec.ts:279-283.)
