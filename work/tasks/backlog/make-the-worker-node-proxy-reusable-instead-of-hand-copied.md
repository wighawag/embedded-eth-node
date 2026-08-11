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

`workerApi` is already exported, so the smallest honest fix keeps the side effect where it is and lets a consumer COMPOSE the rest: export a factory (a `createWorkerApi({engine})`-shaped thing), or move the `expose()` call into a thin `worker-entry` wrapper around an exposable module. Weigh a parity assertion as the cheaper alternative: a test that fails when a plain `SlimNode` field is missing from the proxy would catch the recurrence without changing the published surface. Prefer removing the duplication if it can be done without making the core name engines by string, which ADR 0006 refuses.

**2. The file a consumer is told to copy is not in the tarball.** The README links the example at `packages/embedded-eth-node/test/helpers/revm-worker.ts`, and `package.json`'s `files` is `[dist, src]`, so it is absent from the published package and the link resolves only on GitHub. That matches the existing `docs/spikes/` links in the README, so it may be acceptable, but those are reference material a reader browses, whereas this one is a file the text tells them to COPY. Decide deliberately: ship it, or reword the README so it is clearly a GitHub reference rather than something in their `node_modules`.

## Acceptance criteria

- [ ] A consumer can write the README's revm worker module without hand-copying the `SlimNode` proxy block, OR a test fails when a plain `SlimNode` field is missing from a proxy, so the `senderMode` class of omission cannot silently recur.
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
> A parity assertion is a legitimate answer and may be the better one; it changes no published surface. Weigh it honestly against the factory rather than assuming the bigger change is the right one.
