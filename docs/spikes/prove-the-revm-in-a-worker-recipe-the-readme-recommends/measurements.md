# revm in a Worker: does the README's recipe actually work?

The recipe the README has recommended since the revm subpath shipped (build the engine INSIDE your own worker module, `createNode({engine: await createRevmEngine({wasm})})` there, comlink-expose the node) had never been executed anywhere in this repo. This folder records what happened when it was, since the answer is the deliverable whichever way it went.

What the change itself is: `packages/embedded-eth-node/test/helpers/revm-worker.ts` (the consumer-shaped worker module the README now points at), `packages/embedded-eth-node/test/helpers/revm-worker-roundtrip.ts` (the main-thread driver), the `'revm-worker'` mode of `test/helpers/cut-revm.ts`, and `packages/embedded-eth-node/test/revm-worker.spec.ts`, which runs on Chromium and WebKit on every `pnpm test`.

## The answer: it works, unchanged, and the wasm configuration DOES reach the Worker bundle

That last clause was the unknown the task was written around. It resolves positively, and for a structural reason worth writing down rather than re-discovering: `playwright-browser-harness` builds the page and the Worker as **two entry points of ONE `esbuild.build()` call** (`dist/build.mjs`), so a single `loader: {'.wasm': 'binary'}` map, the composed `nodePolyfills` inject/define/alias, and every other pass-through option apply to both. Nothing had to be threaded through separately, and no harness change was needed.

The generalisation for a consumer is NOT "it just works": it is that your bundler's asset rule has to apply to the **worker entry point** too. Under a bundler that treats a worker as a separate build with its own config (or that only rewrites `new Worker(new URL(...))` in the main graph), the same `import wasm from 'revm-wasm/revm.wasm'` would need that rule repeated. The README bullet now says so.

Everything else in the recipe crossed the boundary without adaptation:

- the engine is CONSTRUCTED on the worker thread, so nothing engine-shaped is ever cloned (which is what `createWorkerNode({engine})`'s refusal is about);
- because the consumer's module exposes the same `{createNode(options)}` API `src/worker-entry.ts` does, the main thread drives it with the ORDINARY `createWorkerNode()` client. The client code is byte-for-byte what the default-engine Worker test uses, and the only thing that says "revm" up there is which module the Worker was pointed at;
- the `stateMode:'trie'` refusal fires INSIDE the Worker and its full text (naming the engine, the reason and ADR 0005) reaches the caller of `createWorkerNode()` intact through comlink's error channel, rather than arriving as an opaque worker failure.

## What was measured, through the boundary

Reference execution gas, measured on the node's own surface (`eth_estimateGas` minus the intrinsic cost of the call) from the MAIN thread while revm executes in the Worker. Identical to the figures `test/revm-engine.spec.ts` pins on the main thread, and to the cross-backend gate's:

| call | execution gas | result |
| --- | --- | --- |
| `number()` | 2446 | `0x0` |
| `sumTo(2000)` | 498689 | `0x1e8098` |
| `keccakLoop(2000)` | 1107052 | `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a` |

Committing transactions: one deploy plus 20 `increment()` transactions, signed on the main thread and executed and committed by revm in the Worker. Post-state read back through the node's own surface afterwards: `number()` = 20, storage slot 0 = `0x14`, sender nonce = `0x15`, sender balance down 1144120000000000 wei. Comlink round trip for a signed `eth_sendRawTransactionSync`: ~1.8 ms (Chromium) / ~3.9 ms (WebKit) per transaction, reported and not asserted.

Main-thread responsiveness during 15 back-to-back `sumTo(50000)` reads in the Worker (one machine, one run; these are REPORTED, and only the ratio and the sample count are asserted):

| browser | worker compute (ms) | main-thread max gap (ms) | sampler ticks during the window |
| --- | --- | --- | --- |
| Chromium | 593.3 | 4.9 | 150 |
| WebKit | 304.0 | 8.0 | 49 |

## What each bar does and does not prove

Verified by mutation: deleting the `engine:` line from the worker module (so the Worker builds a DEFAULT-engine node) leaves the spec red on `engineId`, and green on all three reference gas figures, because those numbers are identical on `@ethereumjs/evm` by design; that is the property the cross-backend gate exists to have.

So the honest reading of the evidence is:

- **the engine id** says which EVM the node was BUILT with. It is necessary and it is the bar that catches a worker module that forgot the engine, but on its own it is a claim about construction;
- **the reference gas** says an EVM really executed the calls in there and got the right answers: no mock, no stub, no swallowed error. It cannot by itself distinguish the two engines;
- **together with the fact that the node has NO fallback path** (`createNode()` throws, naming the engine and the cause, if an engine fails to initialise or refuses the configuration; asserted in `test/slim-node-checks.spec.ts`), they compose: the node either ran the engine it was handed or it never came into existence, and it reported `revm-wasm` and produced correct gas;
- **the `stateMode:'trie'` refusal** is the one reading here only a revm-backed node can produce, and it is why it is asserted rather than left to the main-thread specs.

## Bundle cost of the two wasm delivery shapes, in a WORKER

Built with the harness's own `buildBundle` (esbuild, `format: 'esm'`, sourcemaps on, the same `nodePolyfills`), measuring `worker.js` only:

| worker module | raw | gzip |
| --- | --- | --- |
| bundler-resolved wasm (`import wasm from 'revm-wasm/revm.wasm'`, `binary` loader) | 2718.0 KB | 808.3 KB |
| runtime-fetched URL (`{wasm: new URL(...)}`, wasm served as a file) | 1112.1 KB | 243.4 KB |

The 1.17 MB `.wasm` costs ~1.6 MB inside the bundle rather than 1.17 MB, and ~565 KB gzipped rather than the ~413 KB the file itself gzips to, because the `binary` loader embeds it as base64 and base64 compresses worse than the bytes do. A consumer who cares about the worker chunk should serve the `.wasm` and pass a URL (it is then also separately cacheable); a consumer who wants zero fetches at startup pays the above. The shipped example deliberately uses the BUNDLED shape, because that is the one that has to survive being bundled a second time as a worker entry, which is the thing nobody had tried.

## Decisions

Non-obvious in-scope choices, recorded because a reviewer or a later task would be surprised they were settled here. Each: what was chosen, why, what was rejected, what it touches.

### 1. The consumer's worker module exposes the SAME `{createNode(options)}` API as `worker-entry`

**Chosen:** `revm-worker.ts` exposes a `createNode(options)` factory that merges in the engine and comlink-proxies the node, i.e. exactly `src/worker-entry.ts`'s shape with one line added.

**Why:** the main thread then keeps using `createWorkerNode()` unchanged, which is precisely what `src/worker-client.ts`'s refusal message promises ("then drive it with the same client code"). It also makes the recipe checkable: `createWorkerNode()` reads `engine`, `stateMode` and `senderMode` off the remote, so the engine identity crosses the boundary for free.

**Rejected:** exposing a bespoke API and hand-rolling a matching client (proves the engine works in a Worker, but stops proving the README's actual claim that the client is unchanged); importing `embedded-eth-node/worker-entry` from the consumer module to reuse its proxy (it calls `expose()` at import time, so importing it would expose the WRONG api; captured at the time as an observation note, since discharged by deletion in commit `1f9454d`, its signal having been carried into `make-the-worker-node-proxy-reusable-instead-of-hand-copied` and thence into the `WHY IT IS A SEPARATE MODULE` block at the top of `packages/embedded-eth-node/src/worker-host.ts` and decision 1 of `docs/spikes/make-the-worker-node-proxy-reusable-instead-of-hand-copied/decisions.md`; do not resurrect the note).

**Touches:** anyone adding a plain field to `SlimNode` now has THREE proxies to update: `src/worker-entry.ts`, this example, and any consumer's copy. That is inherent to the recipe (the consumer owns their worker module) and is the reason the example forwards every plain field with the same comment `worker-entry` carries.

> *Superseded 2026-08-11:* that consequence is gone. `embedded-eth-node/worker-host` holds the ONE proxy and `exposeNode({createEngine})` is the whole of a consumer's worker module, so this example forwards nothing and there is nothing to keep in sync. The snapshot above is left as written; the current shape is in `packages/embedded-eth-node/src/worker-host.ts`.

### 2. The example is a TEST HELPER, not a new `examples/` tree

**Chosen:** `packages/embedded-eth-node/test/helpers/revm-worker.ts`, linked from the README.

**Why:** the goal is a recipe that is EXECUTED on every run, not one that is described; a file the harness bundles as the worker entry is executed by construction. A separate `examples/` directory would either be unexecuted (the failure mode this task exists to remove) or would need its own build wiring to be executed.

**Rejected:** `examples/revm-worker/` (unexecuted, or a second toolchain); putting it in `packages/benchmarks` (it is a correctness statement, not a measurement, and the benchmark package's job is cross-backend perf).

**Touches:** the README now links into the test tree. If the file moves, the README bullet moves with it.

### 3. The worker module imports by PACKAGE NAME; the main-thread driver keeps the relative `src/` import

**Chosen:** `revm-worker.ts` imports `embedded-eth-node` and `embedded-eth-node/revm`; `revm-worker-roundtrip.ts` imports `createWorkerNode` from `../../src/worker-client.js` like every other helper in that folder.

**Why:** the worker module is the file a consumer copies, so it must resolve the way a consumer resolves (and thereby exercise the published export map, as `packages/benchmarks` already does). esbuild honours Node's package **self-reference** rule, so `embedded-eth-node` resolves from inside its own package through the `exports` map to `dist/` with no self-dependency added to `package.json`. That also means the example is exercising the BUILT output, and `pnpm test` on a package whose `dist/` is stale would notice. The driver, by contrast, is test-suite code; keeping it on the relative import keeps one copy of the node's module graph in the page bundle and matches `worker-roundtrip.ts`.

**Rejected:** an esbuild `alias` from the package name to `src/` (would bypass the export map, i.e. bypass the thing being proven); adding `embedded-eth-node` to its own devDependencies (unnecessary, since self-reference already works, and it would make the resolution look like a consumer's when it is not).

**Touches:** the spec now depends on `dist/` existing. `verify` runs `pnpm build` before `pnpm test`, and `pnpm install` runs `prepare` -> `build`, so both paths are covered; a bare `pnpm test` in a never-built checkout would fail to resolve rather than silently test source.

### 4. The responsiveness window is 15 heavy reads, not the 5 `worker.spec.ts` uses

**Chosen:** `HEAVY_CALLS = 15` at the same `sumTo(50000)`.

**Why:** revm executes that read several times faster than `@ethereumjs/evm`, so the 5-iteration window closed in ~99 ms on WebKit, whose nested `setTimeout` is clamped to ~4 ms: 23 sampler ticks, uncomfortably close to the `> 10` bar for a property that should be measured with room to spare. More iterations rather than a bigger `sumTo`: the default read budget is 30M gas and `sumTo(50000)` already spends ~12.5M of it, so scaling that argument would hit the budget refusal instead.

**Rejected:** lowering the sample bar (it is the load-invariant half of the proof); asserting a millisecond bound (WebKit's 1 ms `performance.now()` clamp already reddened this gate once; see the comment in `worker.spec.ts`).

**Touches:** nothing outside this spec; the spec costs ~1.3 s per browser.

### 5. No changes to `src/`, `worker-entry` or the README's refusal

The task's prompt is explicit that `worker-entry` must NOT learn about revm (it would mean the core naming engines by string and importing them, which ADR 0006 refuses, and a JS-only consumer would then pay for revm), and nothing here needed it. The default entry point's bundle is therefore untouched by this change and `packages/benchmarks/test/evm.spec.ts`'s baseline is not re-pinned. No new named concept was introduced either: this change adds no flag, option, status or vocabulary, and it uses `engine`, `slim node`, `state mode` and `honest edge` as `CONTEXT.md` already defines them.
