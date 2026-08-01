---
title: Decisions taken while building 'revm-engine-under-conformance-and-gate'
date: 2026-08-01
status: open
decisionsFor: revm-engine-under-conformance-and-gate
---

# Decisions taken while building `revm-engine-under-conformance-and-gate`

The done record's `## Decisions` block, kept here because the task body is moved
byte-identical by the runner. Each entry: what was chosen, why, what was
rejected, and what it touches. Ratify or reverse.

## 1. The conformance battery is ENGINE-PARAMETERISED, not duplicated

**Chosen:** `test/helpers/conformance.ts` grew an optional engine FACTORY
(`runBattery(stateMode, makeEngine?)`) plus one new export,
`runConformanceOnEngine({makeEngine, serves, refuses})`. The revm run is the same
20 steps, the same reference and the same diffs, with a different EVM behind the
read path. `runConformance()` (the default-engine, both-modes run) is unchanged
and `conformance.spec.ts` is untouched.

**Why:** the task's trap is making revm pass by loosening something. A second,
revm-shaped copy of the battery would be exactly that in slow motion: it would
drift from the original and nobody would notice which assertions it had lost.
One battery, two engines, is the only shape where "the revm engine faces the same
bar" is checkable by reading one file.

**Rejected:** a `revm` variant of the battery (drift); running the battery once
with whichever engine, parameterising the whole spec (would have removed the
default engine's `'trie'` coverage, which is the named trap).

**Touches:** anyone adding a battery step gets it on both engines automatically,
which is intended. A step that reads `block.basefee` or `PREVRANDAO` would fail
on revm only (see the previous task's decisions note, items 1 and 2) — that is
the gate reporting a real divergence, not a step to skip.

## 2. A FACTORY per node, not one engine, because one engine serves one node

The battery builds two nodes (the main one, plus the manual-mining node for the
back-to-back-in-one-block step), and the refusal probe builds another. A revm
engine instance binds to exactly ONE node and refuses a second `createNode()`
(previous task, decision 11). So the parameter is `() => Promise<ReadEngine>`,
not `ReadEngine`. One compiled `WebAssembly.Module` is shared across all of them,
which is what `createRevmEngine`'s `wasm` option accepting a compiled module is
for. Same shape in the benchmark backend, where the scenario builds a fresh node
per repeat.

## 3. The refused state mode is ASSERTED, not assumed

**Chosen:** `runConformanceOnEngine` takes `refuses: StateMode[]` and records the
error each refused mode threw with; `revm-conformance.spec.ts` asserts `'trie'`
was refused.

**Why:** the acceptance criterion is that the coverage split is EXPLICIT — the
mode revm serves is exercised with it, the other keeps its default-engine
coverage. That split is only honest while the refusal holds. If revm ever served
`'trie'` and nobody noticed, the mode would silently stop being covered on the
engine that could now run it, and the file would still read as if it were
deliberate. Asserting the refusal makes that a red test rather than a quiet gap.

**Rejected:** trusting `revm-engine.spec.ts`'s existing refusal assertion (it
proves the refusal, but it does not tie it to the conformance coverage split,
which is the thing that would rot).

**Touches:** duplicates one assertion with `revm-engine.spec.ts` deliberately.
If `revm-engine-behind-runtx` ever gives revm a trie-capable path, BOTH assertions
go red, which is the correct number of places to be told.

## 4. The benchmark row is named `embedded-eth-node-revm-engine`

**Chosen:** that key, with the display name `embedded-eth-node + revm read engine
(signed eth_sendRawTransactionSync, auto-mine)`.

**Why:** it has to be unmistakable against the two rows it sits between. `revm` is
RAW revm owning its own state; `embedded-eth-node` is the same node on
`@ethereumjs/evm`. A shorter `embedded-eth-node-revm` would read as "the revm one"
and blur into the raw row in a table that is scanned, not studied. `read engine`
is the term `CONTEXT.md` already defines for exactly this scope (reads move,
transactions do not), so the name reuses the glossary rather than inventing.

**Touches:** the `startsWith('embedded-eth-node-')` skip in the bundle-size test
now also skips this row; its comment was corrected, because the old reasoning
("the same package, so no extra bytes") is not why this row is skipped. This row
DOES import a second entry point; what it costs is the `.wasm`, which already has
its own size row and is fetched at runtime, so esbuild could not weigh it anyway.

## 5. The send path stays `'recover'` on the new row

The engine choice is orthogonal to the send mode, so the row could have been
built on any of the three. `'recover'` is the honest default (real signing, real
ecrecover, no cheats), and pairing it with the `embedded-eth-node` row means the
two differ by EXACTLY one `createNode` option. The delta between them is then the
engine swap and nothing else. The trusted/fabricated rows keep isolating
secp256k1 cost on the default engine, which is what they exist for.

## 6. The wasm compile-once helper moved to its own module

`backend-revm.ts`'s private fetch-and-compile cache became
`test/helpers/revm-wasm-module.ts`, because the new backend needs the identical
thing and re-compiling per scenario repeat would land in the `coldStart` row as a
harness artefact. Pure extraction: same code, same rationale comment, no
behaviour change to the raw-revm row. Both backends still get their own INSTANCE
per run, so no run can observe another's state.

## 7. The frame number is REPORTED in three places, asserted in none

The suite prints a dedicated `frame budget: the number to cite` block; the
conditions and both samples are captured in
`docs/spikes/revm-engine-under-conformance-and-gate/frame-measurements.md`; the
benchmarks README points at that file. Nothing asserts on a timing, per the
existing convention (load-sensitive rows, and WebKit's 1 ms `performance.now()`
clamp).

**Touches:** `engine-seam-docs-and-honest-edges` publishes the README figure and
should cite the spike file rather than re-measuring. Note for whoever does: the
JS-node rows measured here (10.4 / 13.0 ms) are LOWER than the published quiet-machine
baselines (12.4 / 15.0), because this was a different machine — quote the pair
from one table, never a new revm number against an old JS number.

## 8. No changeset

`packages/embedded-eth-node`'s `src/` is untouched: this change is tests, the
benchmark package (private, never published), and docs. Same reading as
`retire-vendored-revm-in-benchmarks`, which shipped without one. The library
README gained one paragraph describing the new test, which is repo documentation
rather than a shipped behaviour change.
