---
title: Measure the frozen tables' TypeError by NAME, not merely that something threw
slug: measure-the-frozen-table-typeerror-by-name
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

`measure-the-frozen-table-refusal-and-say-frozen-in-adr-0008` existed because the `TypeError` from writing to a frozen hardfork table was ADVERTISED to consumers and never measured. It closed most of that gap: `test/revm-engine.spec.ts` now asserts both re-admitting edits threw. It did not quite close the gap it named, and Gate 2 caught the remainder.

The helper records the outcome as `threw: ${message}`, dropping the constructor name, and the spec asserts `/^threw: /`. That pins THAT something threw, not that a `TypeError` did, while `.changeset/frozen-fork-tables.md` tells consumers the write "now fails at the assignment (a `TypeError` in strict mode)". So the advertised claim is still one step away from the measured one, which is the exact shape this family of tasks exists to remove in this repo: something DESCRIBED where this repo asserts.

There is a good reason not to pin the MESSAGE (V8 and JSC word it differently, and a cross-browser suite should not depend on either wording) but that reason does not extend to the NAME. `TypeError` is fixed by the language specification and is identical on both engines the battery runs. Record and assert the name.

## Acceptance criteria

- [ ] The recorded outcome for a refused table edit carries the error's NAME as well as its message, and both re-admitting edits are asserted to have thrown a `TypeError` specifically.
- [ ] The assertion does not depend on the error MESSAGE's wording, which differs between V8 and JSC; the battery stays green on both Chromium and WebKit.
- [ ] The existing consequence assertions are kept: the tables are unchanged and the guard still refuses `prague`. The throw is the consumer-visible half and the unchanged table is the guard's half, and neither implies the other.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] No changeset: this measures an already-published claim, it does not change it.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: assert the error TYPE the changeset advertises, not merely that some throw occurred.
>
> FIRST, check this task against current reality: it was written on 2026-08-10 and may have DRIFTED. Confirm the helper still records only the message and that the spec still asserts a bare `threw:` prefix.
>
> The test modules are ESM and therefore always strict, which is why the throw happens at all. Keep the strict-versus-sloppy distinction intact wherever it is already drawn (the code JSDoc, the changeset, ADR 0008): a sloppy-mode consumer gets the unchanged table WITHOUT the throw, and that asymmetry is deliberately kept straight in this repo's prose.
>
> Do not pin the error's message text. Pin its name.
>
> Done means a re-admitting write is asserted to fail with a `TypeError`, on both browsers, with the table-unchanged and guard-still-refuses assertions still in place.
