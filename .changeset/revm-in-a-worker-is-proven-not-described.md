---
'embedded-eth-node': patch
---

Documentation and a runnable example: the revm-in-a-Worker recipe the README recommends is now EXECUTED on every test run, on Chromium and WebKit. No library code changed, so `patch` is the honest level and nothing about the node's behaviour moved.

`createWorkerNode({engine})` is refused (the options are structured-cloned and an `Engine` is a function-bearing object holding thread-bound live state), so the README told consumers to build the engine inside their own worker module and comlink-expose the node. Nothing in this repo did that, so the one combination a consumer most likely wants (revm AND off the main thread) was the only one recommended without evidence.

There is now a copyable worker module, `packages/embedded-eth-node/test/helpers/revm-worker.ts`, which builds the revm engine INSIDE the Worker and imports `embedded-eth-node` / `embedded-eth-node/revm` by package name (so the published export map is exercised the way a consumer resolves it), and a spec that drives it through the ORDINARY `createWorkerNode()` client with unchanged main-thread code: the engine identity crossing the boundary reads `revm-wasm`, the reference execution gas measured THROUGH the Worker is exact (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 and its result hash), a deploy plus 20 committing transactions land and their post-state reads back through the node's own surface, the `stateMode:'trie'` refusal fires inside the Worker with its full text reaching the caller, and the main thread stays responsive throughout (a load-invariant ratio, never a millisecond bound).

The integration risk that made this worth proving, whether the revm `.wasm` configuration reaches the WORKER bundle and not only the page, resolved positively: the harness builds both entry points in one esbuild pass, so one `binary` loader covers both. The generalisation for a consumer is that their bundler's asset rule has to apply to the worker entry too, which the README bullet now says, along with what each delivery shape costs inside a worker chunk. Findings, measurements and the decisions taken while building this: `docs/spikes/prove-the-revm-in-a-worker-recipe-the-readme-recommends/measurements.md`.

`src/` is untouched, so the default entry point's bundle is unmoved and the benchmark baseline is not re-pinned.
