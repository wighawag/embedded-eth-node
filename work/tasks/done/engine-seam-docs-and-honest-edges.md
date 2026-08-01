---
title: Document the engine seam, and fail loudly when an engine cannot serve a configuration
slug: engine-seam-docs-and-honest-edges
spec: revm-engine-behind-eth-call
blockedBy: [revm-engine-subpath, revm-engine-under-conformance-and-gate]
covers: [10, 12]
---

## What to build

Two things that finish the seam as a PUBLIC feature rather than an internal one.

**Document it** in the README, beside the existing `stateMode` and `senderMode` sections, so it is discoverable without reading source: what an engine is, that the default is `@ethereumjs/evm` and costs nothing, how to opt into revm, both wasm delivery shapes, which `stateMode` the revm engine can serve, and what is and is not routed through it today (reads only — transactions remain on `@ethereumjs/vm`).

Those sections justify themselves with real measured numbers rather than adjectives, and this one must too — with the numbers for THIS configuration. The 12.4 ms against 3.8 figures that motivated the spec were measured on RAW backends, not on the node with the engine installed, and the node's own dispatch overhead becomes the dominant term after the swap. `revm-engine-under-conformance-and-gate` produces the honest node-with-revm number; publish that one.

**Fail loudly at the new edges.** The node's convention is that an unimplemented or impossible thing throws a real JSON-RPC error rather than degrading quietly. The engine seam adds new ways to be misconfigured: an engine that fails to initialise, or one that cannot serve the node's configuration. Neither may silently fall back to a different engine, because a consumer who asked for revm and quietly got `@ethereumjs/evm` would measure the wrong thing and never know.

## Acceptance criteria

- [ ] The README has an engine section beside the existing mode sections, covering the default, opting into revm, both wasm delivery shapes, the reads-only scope, and which `stateMode` the revm engine serves.
- [ ] The README states the measured reason the feature exists, using the number measured for the NODE with the revm engine (from the benchmark row `revm-engine-under-conformance-and-gate` delivers), not the raw-backend number, and says which configuration each number describes.
- [ ] An engine that fails to initialise surfaces a real error naming the cause; the node does NOT silently construct with the default engine instead.
- [ ] The node-side mechanism for refusing a configuration an engine cannot serve exists and fails loudly rather than degrading. (The revm + `stateMode:'trie'` INSTANCE is owned by `revm-engine-subpath`; this criterion is the general mechanism and its test, not a second copy of that check.)
- [ ] The RPC-surface table in the README notes which methods route through the engine.
- [ ] Passing an engine to `createWorkerNode` fails HONESTLY. `WorkerNodeOptions extends NodeOptions`, so `engine` is now typed-legal on the Worker path, but comlink structured-clones the options object and an engine is a function-bearing object — today that produces an opaque `DataCloneError` from deep inside comlink, which is exactly the plausible-looking-failure this repo's honest-edge convention exists to prevent. Either reject it at the worker client with a real error naming the reason, or make it work; do not leave it as a `DataCloneError`. (Raised by the Gate-2 review of `engine-seam-with-ethereumjs-default`.)
- [ ] Tests cover the failure paths, in the style of the existing honest-edge checks.

## Blocked by

- `revm-engine-subpath` — the thing being documented and the failure paths both need a real second engine to exist.
- `revm-engine-under-conformance-and-gate` — the README's measured justification has to be the node's own number, and that task is what produces it.

## Prompt

> Goal: make the engine seam a documented, honestly-failing public feature.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? Read the API that `engine-seam-with-ethereumjs-default` and `revm-engine-subpath` actually shipped, and document THAT, not this description of it.
>
> Read `CONTEXT.md`, in particular *honest edge*: an unimplemented or deliberately-absent method fails LOUDLY with a real JSON-RPC error, never a plausible-looking fake. That convention is the repo's identity and `docs/adr/0004-no-account-or-signing-methods.md` is an instance of it. This task extends it to a new surface.
>
> The failure that matters most is a SILENT FALLBACK. If a consumer passes a revm engine and it cannot initialise, constructing the node with `@ethereumjs/evm` instead would produce a node that works, returns correct results, and is an order of magnitude slower than the consumer believes. They would measure it, be confused, and have no signal. Fail instead.
>
> For the README, follow the shape of the existing `stateMode` and `senderMode` sections: what the options are, which is the default, a short measured justification, and the caveats. Those sections state real measured numbers rather than adjectives, and this one should too.
>
> BE CAREFUL WHICH NUMBER YOU PUBLISH. The motivating measurement — `@ethereumjs/evm` at roughly 20 MGas/s against revm at roughly 200, i.e. 12.4 ms against 3.8 on Chromium and 15.0 against 5.0 on WebKit for a 100-small-reads frame against a 16.6 ms 60fps budget — compares RAW engines. The node with the revm engine installed still pays the node's own dispatch overhead per call, which the spec's own notes expect to become the dominant term after the swap. Publishing the raw figure as the node's figure would overstate what a consumer gets, and they would measure it and find out. Take the node-with-revm number from the benchmark row `revm-engine-under-conformance-and-gate` adds, and label each number with the configuration it describes. Be precise about scope: reads only, transactions unchanged.
>
> Seams to test at: `test/slim-node-checks.spec.ts` is the existing home for honest-edge assertions (it pins the `-32601` behaviour of the account methods). Add the engine failure paths there, in the same style.
>
> Done means: someone who has never read this conversation can find the feature in the README, understand what it does and does not cover, and cannot be silently given an engine they did not ask for.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
