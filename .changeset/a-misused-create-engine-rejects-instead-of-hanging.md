---
'embedded-eth-node': patch
---

A misused `exposeNode({createEngine})` now REJECTS the main thread's `createWorkerNode()` instead of hanging it forever.

The refusal added with `embedded-eth-node/worker-host` (passing an engine, or the promise of one, where the factory belongs) threw while the worker module was still EVALUATING. That is before comlink's `expose()` runs, so the worker registered no message listener, answered nothing, and an awaited `createWorkerNode()` on the main thread never settled: the consumer saw a hang and the explanation reached only the worker's console, which in a bundled app is easy to miss entirely. An infinite pending promise is a worse failure than the `DataCloneError` the sibling refusal exists to prevent, because it produces no error at all.

The refusal is now a recorded VALUE rather than control flow. `exposeNode()` always calls `expose()`, so the worker can always answer; the message is still logged on the worker thread at the moment the mistake is made (the early signal a developer with the console open sees), and `createNode()` rejects with the same text, so it crosses the boundary to the caller. Neither thread is left guessing.

The message also names the PROMISE case as itself: `createEngine: createRevmEngine({wasm})` (no arrow) is told that the factory was called rather than passed, and shown both forms, instead of being told that a value one arrow from correct "is not a function".

Two documented hazards go with it, on the `exposeNode` doc comment and in the README's Worker section: do not `await` at the top level of a worker module before `exposeNode()` (the main thread's first message can be lost while your module is still evaluating, which hangs `createWorkerNode()` for a reason this package cannot fix), and `createEngine` is a function precisely so the await belongs to `createNode()`.

Behaviour change for anyone already misusing the option: `createNodeWorkerApi()` / `exposeNode()` no longer throw synchronously, they return normally and the failure surfaces at `createNode()`. Asserted from the main thread in a browser on both engines (`test/worker.spec.ts`, `test/revm-worker.spec.ts`) so a regression back to the hang is caught as a `NEVER_SETTLED` outcome rather than an undiagnosed timeout. Reference gas is unchanged. Decisions: `docs/spikes/a-bad-createengine-hangs-the-main-thread-instead-of-rejecting/decisions.md`.
