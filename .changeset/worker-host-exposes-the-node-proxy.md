---
'embedded-eth-node': minor
---

New subpath `embedded-eth-node/worker-host`: host a node in a Worker that builds its OWN engine, without hand-copying the `SlimNode` proxy. Additive: `embedded-eth-node/worker-entry` still exposes the node at import time, still exports `workerApi`, and nothing on the main thread changes.

```ts
// my-worker.ts: the whole module
import {exposeNode} from 'embedded-eth-node/worker-host';
import {createRevmEngine} from 'embedded-eth-node/revm';
import wasm from 'revm-wasm/revm.wasm';

exposeNode({createEngine: () => createRevmEngine({wasm})});
```

Why it exists: an engine cannot cross a thread boundary (`createWorkerNode({engine})` is refused, since the options are structured-cloned and an `Engine` is a function-bearing object holding thread-bound live state), and `worker-entry` deliberately builds no engine for you, because that would mean the core naming engines by string and importing them, which [ADR 0006](https://github.com/wighawag/embedded-eth-node/blob/main/docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md) refuses (a JS-only consumer would pay for revm). So a consumer had to write their own worker module, and `worker-entry` calls comlink's `expose()` at MODULE SCOPE, so it could not be imported to reuse the proxy: importing it would have exposed the wrong api on that thread. Everybody copied the proxy block instead. `worker-host` is `worker-entry` without the side effect, and `worker-entry` is now that module plus its one line.

`createEngine` is a FACTORY, called once per `createNode()`, because building an engine is async and because one engine instance serves one node (`connect()` binds it, so an engine value would work for the first node and throw for the second). Passing a built engine there is refused with a message naming both forms. The main thread's options (`chainId`, `miningConfig`, and the rest) still travel through `createWorkerNode()` unchanged; only the engine is the worker's.

The proxy now exists in exactly ONE place, and staying complete is the compiler's job rather than anyone's memory: it is a literal typed `SlimNode`, so a field added to `SlimNode` later fails the build there, and `worker-client`'s `as any` casts (which are what hid `senderMode` when it was silently dropped from that block for a month) are gone. The Worker test additionally compares a Worker-backed node against a main-thread one field by field, naming no field, so the same class of gap is caught at runtime for any future one too.

The README's revm-in-a-Worker recipe is now shown INLINE (it is four lines), and its pointer at this repository's executed example says plainly that those are repository files rather than something in your `node_modules`. The published `files` list is unchanged.

`src/index.ts` is untouched, so the default entry point's bundle is unmoved and the benchmark baseline is not re-pinned. Decisions taken while building this, including the naming and the two rejected alternatives: `docs/spikes/make-the-worker-node-proxy-reusable-instead-of-hand-copied/decisions.md`.
