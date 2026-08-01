---
title: review-gate non-blocking nits for 'engine-seam-docs-and-honest-edges' (Gate 2 approve)
date: 2026-08-01
status: open
reviewOf: engine-seam-docs-and-honest-edges
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'engine-seam-docs-and-honest-edges' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- createNode({engine: null}) still silently comes up on the DEFAULT engine, which is the exact silent-fallback the task exists to remove; and the two paths disagree (worker-client guards with engine !== undefined, so null is REFUSED there, while node.ts uses options.engine ?? default, so null is treated as absent). The dead describe(null) branch in connectReadEngine suggests null was meant to reach the validator. Ratify as acceptable (null is arguably absent) or change node.ts to test for presence rather than nullishness.
  (packages/embedded-eth-node/src/node.ts:199 (options.engine ?? createEthereumjsReadEngine) vs src/worker-client.ts guard (nodeOptions.engine !== undefined) and src/engine.ts describe() handling null)
- Ratify decision 3: WorkerNodeOptions['engine'] is typed never, so passing an engine to createWorkerNode is now a COMPILE-TIME break as well as a runtime refusal. Recorded, but it narrows a public type and is the constraint the ready spec revm-engine-behind-runtx (or any future engine-aware worker-entry) must revisit under ADR 0006.
  (packages/embedded-eth-node/src/worker-client.ts (engine?: never) + work/notes/observations/decisions-engine-seam-docs-and-honest-edges-2026-08-01.md section 3)
- Ratify decision 5: the default-entry bundle baseline in another package's gate was re-pinned 412.4 -> 413.5 KB raw / 124.1 -> 124.6 gzip to absorb 1.1 KB of refusal-message TEXT paid by every consumer including the JS-only one. The comment justifies it and the metafile check (revm-wasm absent) is untouched, but it spends the pay-nothing-for-revm budget of a benchmarks-owned assertion.
  (packages/benchmarks/test/evm.spec.ts:93-106)
- Ratify decision 2: a value passed as engine that lacks a string id or a call() function is now a NEW user-visible refusal at construction. Sound (it catches an un-awaited createRevmEngine()), but it is a new error surface no criterion asked for, and it would reject an exotic engine that binds call lazily.
  (packages/embedded-eth-node/src/engine.ts connectReadEngine type guard; decisions note section 2)
- Coherence: CONTEXT.md defines honest edge as failing loudly with a real JSON-RPC error, and spec story 10 words it the same way, but these new edges are construction-time plain Errors (correctly, per decision 1, since no request is in flight). Consider pinning the widened meaning in the CONTEXT.md glossary so the next author does not re-fork the term or reach for RpcError.
  (CONTEXT.md:13 vs packages/embedded-eth-node/src/engine.ts + worker-client.ts)
- README feature bullets still say createNode() and createWorkerNode() are interchangeable one-liners, and the new engine bullet beside it does not mention the Worker exception; the refusal is only stated much further down in the caveats list. One clause on the engine bullet would remove the trap.
  (README.md:17-26 vs README.md:298)
- README states the opt-in wasm is 1.17 MB raw / 413 KB gzipped. Raw checks out (1,226,474 bytes = 1.17 MiB) but gzip of the shipped revm.wasm measures ~420.9 KB decimal / ~411 KiB here, so 413 is off by roughly half a percent under either convention. Trivial, but this section sells itself on measured numbers.
  (README.md:312-314; node_modules/.pnpm/revm-wasm@0.1.0/.../revm.wasm gzip = 420899 bytes)
