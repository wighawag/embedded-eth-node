---
title: Make the Worker node proxy reusable instead of hand-copied, and ship the example a consumer is told to copy
slug: make-the-worker-node-proxy-reusable-instead-of-hand-copied
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`prove-the-revm-in-a-worker-recipe-the-readme-recommends` proved the revm-in-a-Worker recipe works. Writing it exposed two things about the surface a consumer meets.

**1. The proxy block cannot be reused, so it gets hand-copied.** `src/worker-entry.ts` calls `expose(workerApi)` at MODULE SCOPE, so a consumer's own worker module cannot import it to reuse the `SlimNode` proxy: importing it would expose the wrong API on that thread. Every consumer following the README's revm recipe therefore hand-copies the whole `proxy({request, mine, dumpState, loadState, getStateRoot, stateMode, senderMode, engine, onNewHead, dispose})` block.

That is exactly the block which silently dropped `senderMode` once, reading as `undefined` on a property typed `'recover' | 'trusted'`, hidden from the compiler by `worker-client`'s `as any`. There are now three copies of it (the package's, the example's, and every consumer's), so the same omission can recur in any of them independently. The new spec asserts `stateMode`, `senderMode` and `engine` on the example, so those three would be caught there; a plain field added to `SlimNode` in future would not.

**THE DIRECTION IS DECIDED (maintainer, 2026-08-11): ship the EXPORT.** The package should make revm-in-a-Worker easy rather than leaving every consumer to hand-copy a proxy block. Do not implement the parity-assertion alternative instead; a single shared proxy solves the future-field problem structurally, by there being one copy rather than a test that watches three.

The shape: keep the side effect where it is, and let a consumer COMPOSE the rest. Split `worker-entry` into an exposable module plus a thin wrapper that calls `expose()`, and export a factory that takes the ENGINE the worker thread built. The consumer's whole worker module should then reduce to roughly three lines, something in the spirit of:

```ts
import {exposeNode} from 'embedded-eth-node/worker-entry';
import {createRevmEngine} from 'embedded-eth-node/revm';
import wasm from 'revm-wasm/revm.wasm';

exposeNode({engine: () => createRevmEngine({wasm})});
```

Treat that sketch as the INTENT, not the required signature; pick the naming and the exact form that fit this package, and say why. Two things it must get right whatever the shape: the main thread keeps passing its own options (`chainId`, `miningConfig`, and the rest) through `createWorkerNode()` unchanged, while the ENGINE is supplied entirely on the worker side, and accepting a lazy supplier (a function returning a promise) rather than only a built engine is worth it, because building the engine is async and belongs inside the factory's own await.

**2. The file a consumer is told to copy is not in the tarball.** The README links the example at `packages/embedded-eth-node/test/helpers/revm-worker.ts`, and `package.json`'s `files` is `[dist, src]`, so it is absent from the published package and the link resolves only on GitHub. That matches the existing `docs/spikes/` links in the README, so it may be acceptable, but those are reference material a reader browses, whereas this one is a file the text tells them to COPY. Decide deliberately: ship it, or reword the README so it is clearly a GitHub reference rather than something in their `node_modules`.

## Acceptance criteria

- [ ] The package EXPORTS something that lets a consumer host a revm-backed node in a Worker without hand-copying the `SlimNode` proxy block. The proxy exists in exactly ONE place in the package.
- [ ] The existing example (`test/helpers/revm-worker.ts`) is rewritten to USE that export, so the duplication is gone rather than merely avoidable, and it stays the file the README points at.
- [ ] The main thread's options still flow through `createWorkerNode()` unchanged, and the engine is supplied purely on the worker side; an engine passed from the main thread is still refused as it is today.
- [ ] If the published surface changes, `worker-entry`'s existing import-time `expose()` behaviour still works unchanged for consumers who rely on it today.
- [ ] The core still does NOT name engines by string or import them, per ADR 0006; a JS-only consumer's bundle is unaffected.
- [ ] The README's pointer to the example is either backed by a file the published package actually contains, or reworded so it is unambiguously a repository reference.
- [ ] The revm-in-a-Worker spec still passes on Chromium and WebKit, with the engine identity and the `stateMode:'trie'` refusal still proving revm ran in the Worker.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] If the default entry point's bundle moves, the baseline in `packages/benchmarks/test/evm.spec.ts` is re-pinned in THIS change with the reason, never silently.
- [ ] A changeset if the published surface changes.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: the Worker proxy stops being a block every consumer copies by hand, and the example the README tells them to copy is actually reachable.
>
> FIRST, check this task against current reality: it was written on 2026-08-11 and may have DRIFTED. Confirm `worker-entry.ts` still calls `expose()` at module scope and that the example's proxy block is still a duplicate of it.
>
> Read `src/worker-client.ts`'s refusal comment and ADR 0006 before changing the shape. The reason `worker-entry` does not build engines for consumers is deliberate: it would mean the core naming engines by string and importing them, so a JS-only consumer would pay for revm. Any factory you add must preserve that.
>
> Note the history: this exact proxy block silently dropped `senderMode` once, and `worker-client`'s `as any` hid it from the compiler. Whatever you build, make that recurrence impossible rather than merely unlikely, and prefer a mechanism that covers a field added in future over one that enumerates today's fields.
>
> The maintainer has DECIDED to ship the export, so do not substitute the parity-assertion alternative. Making one shared proxy is what removes the recurrence, because there is then one copy rather than three under a watch.
>
> Backward compatibility is a hard requirement: a consumer who today does `import 'embedded-eth-node/worker-entry'` for its import-time `expose()` must keep working untouched, and `workerApi` must remain exported. This is additive.
>
> The engine must be supplied BY THE WORKER THREAD, never imported by the core. If your design has the package importing `./revm.js` from a core path, it is wrong: that is precisely what ADR 0006 refuses and it would put revm in a JS-only consumer's bundle.
