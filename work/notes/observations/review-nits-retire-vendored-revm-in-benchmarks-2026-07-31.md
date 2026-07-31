---
title: review-gate non-blocking nits for 'retire-vendored-revm-in-benchmarks' (Gate 2 approve)
date: 2026-07-31
status: open
reviewOf: retire-vendored-revm-in-benchmarks
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'retire-vendored-revm-in-benchmarks' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- No Decisions block was recorded anywhere: the task file was moved ready/ -> done/ byte-identical (git shows R100) and the only new work/ file is an unrelated flake observation, yet the prompt asked to record non-obvious in-scope decisions durably and link them from the done record. The decisions listed in the other findings live only in code comments and README prose. Please ratify them here or ask for a done-record note.
  (git show HEAD --name-status: R100 work/tasks/ready/... -> work/tasks/done/...; only added note is work/notes/observations/genesis-cheats-perf-slowdown-ratio-flake.md)
- Ratify the dependency range: revm-wasm is added as ^0.1.0 rather than an exact pin. README argues the gate turns red on a behaviour change so pinning would only hide it; CI installs with --frozen-lockfile and the lockfile pins 0.1.0, so the real exposure is only a lockfile refresh picking up 0.1.x. Is the floating range the intended policy for a measurement suite?
  (packages/benchmarks/package.json:26 revm-wasm ^0.1.0; pnpm-lock pins 0.1.0; .github/workflows/ci.yml uses pnpm install --frozen-lockfile)
- Ratify the instantiation change: the old backend instantiated the wasm ONCE per page (module-level initialised flag), the new one compiles once but creates a fresh Revm instance in every setup(). setup() is what scenario.ts times as coldStartMs, so revm coldStart numbers are no longer comparable with previously published rows. The same file explicitly kept read() on the slower full-state path precisely to protect row comparability, so the two choices pull opposite ways. No gate impact (timings are not asserted), but the per-run isolation gain should be a deliberate call.
  (backend-revm.ts compiledModule() + setup() creating a new MemoryStore/createRevm per run; scenario.ts:178 t0 -> backend.setup() -> coldStartMs)
- The new test every backend contributed to the gate reads module-level collected state populated by the preceding loop, so it only holds under the current config (workers:1, fullyParallel:false, declaration order). It fails spuriously for anyone running a filtered subset (--grep, --shard) and would fail on a retry that re-runs one backend test, since collected would then hold a duplicate entry. Worth making order-independent or guarding on a full run.
  (packages/benchmarks/test/evm.spec.ts:168 expect(collected.map(c => c.backend)).toEqual([...BACKENDS]); playwright.config.ts fullyParallel:false, workers:1, no retries)
- Coherence nit in CONTEXT.md: the rewritten standing rule ends with a phrase about another wasm ENGINE being added, but the glossary a few lines above pins engine to the injected ReadEngine on the node read path and explicitly warns against re-widening the term. The sentence is about a benchmark backend artifact, not a ReadEngine. A one-word change (wasm EVM, or wasm backend) keeps the pinned term clean.
  (CONTEXT.md:30 vs CONTEXT.md:19 glossary entry for engine)
