---
title: Decisions taken while building 'engine-seam-docs-and-honest-edges'
date: 2026-08-01
status: open
decisionsFor: engine-seam-docs-and-honest-edges
---

# Decisions taken while building `engine-seam-docs-and-honest-edges`

The done record's `## Decisions` block, kept here because the task body is moved
byte-identical by the runner. Each entry: what was chosen, why, what was
rejected, and what it touches. Ratify or reverse.

## 1. The node-side refusal mechanism is one function, `connectReadEngine`

**Chosen:** `src/engine.ts` gained `connectReadEngine(engine, context)`, and
`node.ts` calls it where it used to call `readEngine.connect?.(...)` inline. It
validates the engine object, calls `connect`, and rethrows any failure wrapped in
a node-side message that names the engine, states that the default engine is NOT
substituted, and repeats the engine's own message verbatim (plus `cause`).

**Why:** the acceptance criterion is that the *mechanism* exists and is loud, not
that one engine refuses one mode. Putting it in `engine.ts` (which already owns
the node-side half of the seam) gives the no-fallback rule one code site to be
documented at and one place to break if someone adds a `catch` that continues.
The engine's own message is repeated INSIDE the message rather than only as
`cause` because browser consoles routinely show a message without its cause.

**Rejected:** leaving the bare `await readEngine.connect?.()` (it already
propagated, but a third-party engine's opaque `TypeError` would reach the
consumer with nothing saying the ENGINE was what failed, nor that no fallback
happened); converting it to an `RpcError` (there is no JSON-RPC request in
flight at construction, and `RpcError` codes are the request surface's language).

**Touches:** every engine, including `embedded-eth-node/revm`. The revm
`stateMode:'trie'` refusal message is now nested inside the node's wrapper;
`revm-engine.spec.ts` / `revm-conformance.spec.ts` match on substrings
(`'trie'`, `/revm/i`, `/createNode/i`), which still hold, verified green.

## 2. An object that is not a `ReadEngine` is refused at construction (NEW refusal)

**Chosen:** `connectReadEngine` throws if `engine.call` is not a function or
`engine.id` is not a string.

**Why:** without it, `createNode({engine: createRevmEngine({wasm})})` (a
forgotten `await`, i.e. a Promise) or any stray object constructs a node that
comes up fine and dies at the first `eth_call` with `engine.call is not a
function` — a late failure that reads like a node bug rather than a
configuration error. Same family as the failures this task exists to remove.

**Rejected:** structural validation of the whole interface (`connect`'s arity,
etc.) — over-fitting; `id` + `call` are the two fields the node itself uses.

**Touches:** a NEW user-visible error, hence recorded. It could in principle
reject an exotic engine that populates `call` lazily. Nothing in this repo does,
and an engine that does can bind `call` before `createNode()`.

## 3. `createWorkerNode({engine})` is REFUSED, not made to work

**Chosen:** `worker-client.ts` throws a real error naming the reason and the
supported alternative, and `WorkerNodeOptions['engine']` is typed `never` so
TypeScript stops it at compile time too.

**Why:** the criterion allows either "reject with a real error" or "make it
work". Making it work is not available at this layer: the options object is
structured-cloned into the Worker, and an engine is a function-bearing object
holding thread-local state (a wasm instance, a binding to the node's state
manager). The only way to carry one across would be for the WORKER ENTRY to
resolve engines BY NAME and import them, which is exactly what ADR 0006 refuses
(the core would then import an engine a consumer did not, and the JS-only
consumer would pay for revm). So the honest answer is a refusal that points at
the supported shape: build the engine inside your own worker module.

**Rejected:** silently dropping `engine` on the worker path (that is the silent
fallback this whole task exists to prevent, in its worst form — the consumer
would believe they were on revm); leaving the `DataCloneError` (the plausible
failure the honest-edge convention exists to prevent).

**Touches:** `WorkerNodeOptions` no longer *usefully* extends `NodeOptions` in
one field; the type narrowing is a compile-time break for any code that passes
`engine` there, which today can only be code that was getting a `DataCloneError`.
If `revm-engine-behind-runtx` or a later task ever makes the package's own
`worker-entry` engine-aware, this refusal is the thing to revisit, and ADR 0006
is the constraint it must satisfy.

## 4. The published README figure is the node's; raw-engine figures stay, labelled

**Chosen:** the README's engine section publishes a three-row table —
`createNode({})` 10.3 ms Chromium / 13.0 ms WebKit, `createNode({engine: revm})`
3.8 / 4.0, raw revm-wasm 3.2 / 4.0 — each row labelled with the configuration it
describes, sourced from
`docs/spikes/revm-engine-under-conformance-and-gate/frame-measurements.md`, and
explicitly warns not to quote the raw row or to mix these with the 12.4 → 3.8 ms
raw-backend numbers (different machine, no node in the path).

**Why:** the task's central warning. The spike file's own guidance is to quote a
PAIR from one table rather than a new revm number against an old JS number, and
that is what the section does.

**Rejected:** publishing the headline 11×/19× raw ratios as the node's (they are
interpreter-to-interpreter and would overstate a consumer's win on this call
shape); omitting the raw row entirely (it is what shows the node's dispatch
overhead is small, which is the interesting part).

**Touches:** anyone re-measuring must update both the README table and the spike
file. The percentages of the 16.6 ms budget are derived from the same rows.

## 5. The bundle-size baseline is re-pinned to 413.5 KB raw / 124.6 KB gzip

**Chosen:** `packages/benchmarks/test/evm.spec.ts` re-pins the default entry's
asserted size (was 412.4 / 124.1), in the same change that grows it, as that
assertion's own comment instructs.

**Why:** the 1.1 KB is the TEXT of the new refusal messages in
`src/engine.ts` — core code every consumer bundles, including the JS-only one.
It is 0.27% of the entry, and it is the feature: an error that does not say what
happened is precisely what this task removes. The metafile check
(`revm-wasm` absent from the default entry's graph) is unaffected and still
passes, so the "pay nothing for revm" promise is untouched.

**Rejected:** shortening the messages to stay under the old bound (optimising the
feature away to protect a baseline); leaving it red for the next task to
discover at land time.

**Touches:** the next change that legitimately grows the core re-pins from
413.5 / 124.6.
