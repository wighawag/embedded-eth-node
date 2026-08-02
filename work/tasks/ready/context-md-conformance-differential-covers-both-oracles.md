---
title: Pin CONTEXT.md's "conformance differential" so it covers both oracles, not just the trie reference
slug: context-md-conformance-differential-covers-both-oracles
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

`CONTEXT.md` defines *conformance differential* as "the library's own test that runs the same signed transactions through the node AND a trie-backed `@ethereumjs/vm` `runTx` reference, diffing receipts field by field plus post-state". That was exact until `revm-wasm-upgrade-honest-block-environment` landed, and it is now an under-description of the battery it names.

The battery grew two steps that deliberately do NOT use the trie reference as their oracle, for a reason recorded as decision 3 of `work/notes/observations/decisions-revm-wasm-upgrade-honest-block-environment-2026-08-02.md`:

- **`block environment through a contract`** diffs what a contract read (`BASEFEE` / `PREVRANDAO` / `COINBASE` / `NUMBER` / `TIMESTAMP` / `GASLIMIT`) against the node's own block header plus the `blockEnv` it was configured with. The trie reference is a separate chain built by hand with its own timestamps and a zero coinbase, so diffing against it would measure that difference rather than the engine's honesty.
- **`value-bearing read affordability`** pins an absolute succeed/fail statement per sender rather than a field-by-field diff, because a rejected read charges no gas and produces no receipt to diff.

So the term now covers two oracles: the trie reference for the receipt/post-state steps, and the node's own configured block (plus an absolute statement) for the two steps whose class of bug the reference structurally cannot see. Write that into the glossary entry so the next author does not re-fork the term, or quietly "fix" the new steps back onto the reference and destroy exactly the property they were built to have.

Keep it a GLOSSARY edit. Do not restate decision 3 in full; name the distinction and point at the record.

## Acceptance criteria

- [ ] `CONTEXT.md`'s *conformance differential* entry states that the battery uses the trie-backed `@ethereumjs/vm` reference for the receipt + post-state steps AND a different oracle (the node's own block environment / an absolute statement) for the block-environment and value-bearing steps, with the reason in one clause.
- [ ] The entry points at decision 3 of `work/notes/observations/decisions-revm-wasm-upgrade-honest-block-environment-2026-08-02.md` rather than duplicating it.
- [ ] No test or source behaviour changes; this is documentation coherence only.
- [ ] The existing `docs`/glossary voice is preserved (definitional, one entry, no new section).

## Blocked by

- None.

## Prompt

> Goal: close a documentation drift the Gate-2 review of `revm-wasm-upgrade-honest-block-environment` found. `CONTEXT.md`'s *conformance differential* glossary entry describes only the trie-reference oracle, but the battery now has two steps that deliberately use a different one.
>
> Read the glossary entry in `CONTEXT.md`, steps 13 and 14 in `packages/embedded-eth-node/test/helpers/conformance.ts`, and decision 3 of `work/notes/observations/decisions-revm-wasm-upgrade-honest-block-environment-2026-08-02.md`.
>
> This is a GLOSSARY edit, not a new doc section and not a restatement of the decision record. The point is that a reader who only reads `CONTEXT.md` must not conclude that every step diffs against the trie reference, because that belief is exactly what would lead someone to "fix" the two new steps onto the reference and destroy the property they exist to have.
>
> Done means: the term describes the battery as it actually is, in the entry's existing definitional voice, pointing at the decision record for the why.
