---
title: A top-level await before exposeNode() loses the main thread's first message, and hangs it
date: 2026-08-11
status: open
---

Found while building `a-bad-createengine-hangs-the-main-thread-instead-of-rejecting`, and NOT fixed by it: a worker module whose top level `await`s anything slower than a microtask before calling `exposeNode()` never answers the main thread's first message, so `createWorkerNode()` stays pending forever. Measured on Chromium AND WebKit with a worker module of `import {exposeNode} from '../../src/worker-host.js'; await new Promise(r => setTimeout(r, 50)); exposeNode();` driven by `test/helpers/engine-misuse.ts`: outcome `NEVER_SETTLED` on both. It is a RACE, not a rule: the same module with `await 0` resolves in ~84 ms, because the page's `postMessage` lands after evaluation rather than during it. Comlink's handshake is posted while the module is still evaluating and is not delivered to the listener `expose()` adds afterwards.

Nothing in `src/worker-host.ts` can fix this (there is no listener to register before the consumer's module gets that far), but two things point at it: the shape the README recommends is safe only by accident (`{createEngine: () => createRevmEngine({wasm})}` is synchronous precisely because the factory defers the await into `createNode()`), and the `await createRevmEngine({wasm})` MISTAKE the `createEngine` refusal names in its own message hangs for this reason no matter what the refusal does. That is why `test/helpers/revm-misused-engine-worker.ts` exercises the promise form (`createEngine: createRevmEngine({wasm})`) rather than the await form.

The consumer-facing hazard is wider than the engine: any `await` at a worker module's top level (fetching wasm, opening a database) does it. Worth a task if it is worth documenting on the `exposeNode` doc comment and the README's Worker section, which is where a consumer would look.

RECOVERED 2026-08-11 by the conductor. The run that measured this completed its work but its commit died on ENOSPC, so the note is landed here on its own rather than lost with the branch. The measurement is the build agent's, unedited; only this paragraph was added.
