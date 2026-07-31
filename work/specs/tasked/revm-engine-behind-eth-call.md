---
title: Injectable EVM engine, with revm-wasm behind eth_call
slug: revm-engine-behind-eth-call
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

`@ethereumjs/evm` runs at roughly 20 MGas/s, and that is the ceiling for the consuming use case: an in-browser on-chain game whose hot path is compute-heavy `eth_call`. A hundred small view reads currently cost 12.4 ms on Chromium and 15.0 ms on WebKit against a 16.6 ms 60fps budget — it fits on a quiet machine with almost no headroom, and falls out of budget under load. Heavy `eth_call` work (tight arithmetic, keccak loops) is worse still.

revm compiled to WebAssembly measures 11x faster on compute and 19x on keccak in Chromium, 18x and 21x in WebKit, and charges byte-identical gas (`docs/adr/0003-revm-wasm-is-the-engine-direction.md`). The node cannot benefit from it today because the EVM is not swappable: `@ethereumjs/vm` and `@ethereumjs/evm` are imported directly by `node.ts`.

## Solution

Introduce an **engine seam** and route the READ path through it. A consumer keeps the current behaviour by default and opts into revm by passing an engine object:

```ts
const node = await createNode({});                                    // unchanged, JS-only
const node = await createNode({engine: await createRevmEngine()});    // revm behind eth_call
```

The engine is INJECTED as an object rather than named by a string, so the core never imports revm and the JS-only path keeps its current bundle size under tree-shaking. This spec covers the read path only — `eth_call` and `eth_estimateGas`. Transactions, mining, receipts and state ownership stay on `@ethereumjs/vm` (see `revm-engine-behind-runtx`).

Both delivery shapes are supported by the same seam: a bundler-resolved asset for consumers who want revm in their build, and a runtime-fetched URL for consumers who want to paint UI first and upgrade afterwards.

## User Stories

1. As a consumer, I want `createNode()` with no engine option to behave EXACTLY as it does today, so that adopting this version is a no-op for existing users.
2. As a consumer, I want to pass an engine object to `createNode()`, so that the node uses revm for reads without the core package depending on revm.
3. As a consumer of the JS-only path, I want the published bundle to stay at its current size, so that I pay nothing for a feature I do not use.
4. As a game developer, I want `eth_call` and `eth_estimateGas` to execute on revm when an engine is supplied, so that my per-frame read budget drops by roughly an order of magnitude.
5. As a game developer, I want to supply the wasm as a URL fetched at runtime, so that I can render UI before the engine is ready.
6. As a game developer, I want to supply the wasm as a bundler asset, so that I can ship it in my build with no network fetch.
7. As a maintainer, I want the revm engine to be exercised by the SAME cross-backend gas gate the other backends face, so that a gas divergence fails the build rather than reaching a user.
8. As a maintainer, I want `eth_call` on revm to be structurally incapable of mutating state, so that a read can never commit.
9. As a maintainer, I want the node to report which engine it is running, so that a bug report can say unambiguously which EVM produced a result.
10. As a maintainer, I want an unsupported combination (e.g. an engine that cannot serve a requested mode) to fail loudly with a real JSON-RPC error, so that the honest-edge convention holds for the new surface.
11. As a consumer, I want the engine's state to stay consistent with the node's state manager, so that a read after a transaction observes that transaction.
12. As a maintainer, I want the engine seam documented in the README alongside the existing mode options, so that it is discoverable without reading source.

> **Tasked.** The technical detail that was here (implementation and testing decisions) moved into `work/tasks/` at tasking time; the durable rationale moved to `docs/adr/`. This spec is now its framing only.

## Out of Scope

- Transaction execution, mining, receipts, logs and state commit on revm — `revm-engine-behind-runtx`.
- Publishing the wasm artifact. This landed while the spec was in `ready/`: **`revm-wasm@0.1.0`** is on npm, zero runtime dependencies, MIT, with the prebuilt `.wasm` in the tarball and no Rust toolchain needed. This spec consumes it as an ordinary dependency; the `scripts/vendor-revm.mjs` + gitignored `vendor/` path in `packages/benchmarks` is now legacy and is retired as part of this work.
- Hot-swapping the engine mid-session. Choosing at `createNode()` time still permits progressive loading (paint, fetch, then create).
- Making revm the default engine.
- `stateMode: 'trie'` on revm: revm has no trie, and this spec does not move state ownership, so the question does not arise yet.

## Further Notes

- Measured baselines to beat, quiet machine, from `packages/benchmarks`: compute 24.8 ms (Chromium) / 36.0 ms (WebKit) on `@ethereumjs/evm` against 2.2 / 2.0 ms on revm; frame 12.4 / 15.0 ms against 3.8 / 5.0 ms.
- The per-call floor for revm is roughly 3-5 microseconds, of which the wasm boundary itself is only ~0.4. For many small reads the node's own dispatch overhead becomes the dominant term after the swap, which is plain JS work and a plausible follow-on.
- WebKit clamps `performance.now()` to 1 ms, so any sub-millisecond timing assertion is meaningless there.
