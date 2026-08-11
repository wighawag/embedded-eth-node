---
title: worker-entry's import-time expose() means a consumer's own worker module must duplicate its proxy
date: 2026-08-11
status: open
---

Noticed while building `prove-the-revm-in-a-worker-recipe-the-readme-recommends`, which writes the worker module the README's revm recipe tells a consumer to write (`packages/embedded-eth-node/test/helpers/revm-worker.ts`).

`src/worker-entry.ts` calls `expose(workerApi)` at module scope, so a consumer's own worker module cannot import it to reuse the `SlimNode` proxy: importing it would expose the wrong API on that thread. The consumer therefore hand-copies the whole `proxy({request, mine, dumpState, loadState, getStateRoot, stateMode, senderMode, engine, onNewHead, dispose})` block, which is exactly the block that silently dropped `senderMode` once and now has three copies (the package's, the example's, and every consumer's).

`workerApi` is already exported, so the smallest fix would be to keep the side effect where it is but let a consumer compose it (e.g. export a `createWorkerApi({engine})`-shaped factory, or move the `expose()` call into a thin `worker-entry` wrapper around an exposable module). Not touched here: it is a published-surface change, out of this task's scope.
