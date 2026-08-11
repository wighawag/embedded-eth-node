---
title: Prove the revm-in-a-Worker recipe the README recommends, as a runnable example and a browser test
slug: prove-the-revm-in-a-worker-recipe-the-readme-recommends
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`createWorkerNode({engine})` is refused, correctly and out loud: options are structured-cloned into the Worker, an `Engine` is a function-bearing object, and it holds thread-bound live state (a wasm instance, a binding to that thread's state manager), so cloning could not work even in principle. The refusal is typed `never`, thrown at runtime for JS consumers, and asserted with a real Worker so it is demonstrably about the engine.

The README then tells a consumer the supported shape: build the engine INSIDE your own worker module, `createNode({engine: await createRevmEngine({wasm})})` there, and comlink-expose the node. **Nothing in this repo does that, so nobody has proven it works.** `test/helpers/cut-revm.ts` has no worker mode at all, and `worker.spec.ts` covers only the default engine (it asserts `engineId === '@ethereumjs/evm'`).

That is the one combination a consumer most likely wants — revm AND off the main thread, which is much of the point of reaching for revm — and it is the only one this repo recommends without evidence. This repo's standard everywhere else is to measure rather than assert; a recipe in a README is an assertion.

Build two things, and they are the same thing seen twice:

1. **A worker module shaped like consumer code**, which constructs the revm engine inside the Worker and comlink-exposes the node. It should read like something a consumer could copy: import by PACKAGE NAME (`embedded-eth-node`, `embedded-eth-node/revm`) rather than by relative `src/` path, so it also exercises the published export map the way a real consumer resolves it, as `packages/benchmarks` already does.

2. **A browser spec that drives it** on both Chromium and WebKit, proving the recipe end to end rather than merely that it loads.

There is a real integration risk here, and finding it is part of the value: the harness bundles the page and the worker separately, and the revm `.wasm` needs an esbuild loader plus a served asset (see how `revm-engine.spec.ts` mounts both delivery shapes, and how `worker.spec.ts` passes a `worker` entry). Whether that wasm configuration reaches the WORKER bundle is exactly the unknown. **If it does not work, say so plainly and report what fails** rather than reshaping the recipe until something passes: a README recipe that cannot be made to work is a far more valuable finding than a green test, and it would mean the README bullet needs changing rather than illustrating.

Remember revm requires `stateMode:'none'` and refuses anything else at `createNode()`. That constraint travels into the Worker unchanged.

## Acceptance criteria

- [ ] A worker module exists that builds the revm engine INSIDE the Worker and comlink-exposes the node, importing `embedded-eth-node` and `embedded-eth-node/revm` by package name.
- [ ] A browser spec drives that Worker on BOTH Chromium and WebKit and proves revm actually ran there: the node's engine identity reads `revm-wasm` across the boundary, not the default engine's id.
- [ ] A committing TRANSACTION lands across the Worker boundary (not only an `eth_call`), and the resulting state is observable through the node's own surface afterwards.
- [ ] Reference gas measured THROUGH the Worker matches exactly: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`. This is what proves revm really executed rather than a silent fallback.
- [ ] The main thread stays responsive while the Worker runs heavy compute, asserted the way `worker.spec.ts` does it: a load-invariant RATIO measured in one window on one clock, never a fixed millisecond bound (WebKit clamps `performance.now()` to 1 ms and a fixed bound reddened this gate before).
- [ ] The README's "Not on the Worker path" bullet points at the now-proven example, so the recipe a consumer reads is one that is executed on every run rather than described.
- [ ] If the recipe CANNOT be made to work, the task reports exactly what fails and where, and no test is reshaped to pass around it.
- [ ] A changeset. It documents a consumer-facing recipe as proven and points at a runnable example; it is expected to carry no library-code delta, so `patch` is the honest level and the changeset should SAY that it is documentation and an example rather than implying a behaviour change.
- [ ] The default entry point's bundle is untouched by this work. If it does move, the baseline in `packages/benchmarks/test/evm.spec.ts` is re-pinned in THIS change with the reason in the comment block above it, never silently.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: the one engine-and-thread combination this repo recommends but has never run is executed on every test run, and a consumer has a file they can copy.
>
> FIRST, check this task against current reality: it was written on 2026-08-11 and may have DRIFTED. Confirm that `createWorkerNode` still refuses an injected engine, that `test/helpers/cut-revm.ts` still has no worker mode, and that `worker.spec.ts` still asserts the DEFAULT engine's id. If a revm worker path already exists, say so and stop.
>
> Read `src/worker-client.ts`'s refusal comment first: it already contains the supported recipe in full, including why the package's own `worker-entry` deliberately does NOT build engines for you (it would mean the core naming engines by string and importing them, which ADR 0006 refuses, and a JS-only consumer would then pay for revm). Do NOT "fix" this by teaching `worker-entry` about revm. The whole point is that the consumer owns their worker module.
>
> For the harness, `worker.spec.ts` shows how a worker entry is bundled and served, and `revm-engine.spec.ts` shows how the revm `.wasm` is delivered in both shapes (a bundler-resolved asset via an esbuild `binary` loader, and a runtime-fetched URL via a served asset). Getting that wasm configuration to apply to the WORKER bundle is the unknown; treat a failure there as a finding to report, not an obstacle to route around.
>
> Prove revm RAN rather than that the code loaded. The engine id crossing the boundary is necessary but weak on its own; the reference gas figures are the strong evidence, because they are identical across backends and would not survive a silent fallback to the default engine.
>
> revm requires `stateMode:'none'` and refuses anything else at `createNode()`. Do not work around that; it is the documented constraint.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record, per the repo's convention.
