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

## Implementation Decisions

> **PROMOTE TO ADR at tasking time.** The engine-injection shape below clears the ADR bar and should outlive this launch snapshot — proposed title: "the EVM engine is an injected object, not a named string". The why: naming an engine by string (`engine: 'revm'`) would force the core to reference every engine it can name, which defeats tree-shaking and makes the JS-only consumer pay for revm. Injecting an object keeps the core's dependency graph free of revm entirely. It is hard to reverse because it is the public API shape, and it is surprising because the string form is the more obvious design.
>
> Everything else here is ordinary implementation detail and can be trimmed into tasks as usual.

- The engine is an OBJECT satisfying a small interface, passed as `NodeOptions.engine`. The core must not `import` any revm module; only the optional subpath export does.
- Ship the revm binding as a separate subpath (`embedded-eth-node/revm`) so the default entry point's dependency graph is unchanged.
- Route only `eth_call` and `eth_estimateGas`. `eth_estimateGas` must keep its current semantics (execution gas plus intrinsic, verified equal to `runTx`'s `totalGasSpent`), which means the engine reports execution gas and the node adds intrinsic exactly as it does now.
- The revm engine reads state from the node's existing state, which stays authoritative on the JS side. Do not fork state ownership in this spec.
- Reads pass revm's flag word as 0 (no commit, no create), so `eth_call` cannot write.
- The `evm_*` cheat methods, `dumpState`/`loadState`, persistence and `stateMode` are unchanged by this spec because state ownership does not move.
- The outcome decoder must be resilient to blob-format changes: the format has already moved v1 to v2 to v3, and the only stable region is the head. Prefer a decoder that walks the structure over one that indexes at fixed offsets.

## Testing Decisions

- The highest existing seam is the cross-backend gate in `packages/benchmarks` (`evm.spec.ts`): it already asserts execution-gas equality and keccak-chain equality across every backend, and a `backend-revm.ts` already exists there. Extend rather than duplicate.
- The library's own conformance differential (`packages/embedded-eth-node/test/helpers/conformance.ts`) is the stronger bar for anything touching results: it diffs receipts field by field plus post-state against a trie-backed `@ethereumjs/vm` `runTx` reference. `eth_call` return data and `eth_estimateGas` values must match it with the engine installed.
- Test the DEFAULT path is unchanged: the whole existing suite must pass with no engine supplied.
- Test both delivery shapes (fetched URL and bundler asset) actually load in a real browser, since that is where the failure mode lives.
- Assert the bundle size of the JS-only entry point has not grown, so the tree-shaking claim in story 3 is enforced rather than asserted.

## Out of Scope

- Transaction execution, mining, receipts, logs and state commit on revm — `revm-engine-behind-runtx`.
- Publishing the wasm artifact — `revm-wasm-package`. Until that lands, this spec consumes the vendored artifacts via the existing `scripts/vendor-revm.mjs` path.
- Hot-swapping the engine mid-session. Choosing at `createNode()` time still permits progressive loading (paint, fetch, then create).
- Making revm the default engine.
- `stateMode: 'trie'` on revm: revm has no trie, and this spec does not move state ownership, so the question does not arise yet.

## Further Notes

- Measured baselines to beat, quiet machine, from `packages/benchmarks`: compute 24.8 ms (Chromium) / 36.0 ms (WebKit) on `@ethereumjs/evm` against 2.2 / 2.0 ms on revm; frame 12.4 / 15.0 ms against 3.8 / 5.0 ms.
- The per-call floor for revm is roughly 3-5 microseconds, of which the wasm boundary itself is only ~0.4. For many small reads the node's own dispatch overhead becomes the dominant term after the swap, which is plain JS work and a plausible follow-on.
- WebKit clamps `performance.now()` to 1 ms, so any sub-millisecond timing assertion is meaningless there.
