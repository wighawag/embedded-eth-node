---
title: review-gate non-blocking nits for 'prove-the-revm-in-a-worker-recipe-the-readme-recommends' (Gate 2 approve)
date: 2026-08-11
status: open
reviewOf: prove-the-revm-in-a-worker-recipe-the-readme-recommends
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'prove-the-revm-in-a-worker-recipe-the-readme-recommends' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify Decision 3: the worker module imports embedded-eth-node / embedded-eth-node/revm by package name, so this spec resolves through the exports map into dist/ and now depends on a built package. A bare pnpm test in a never-built checkout fails to resolve rather than testing source. Verified that root prepare runs pnpm build and dorfl.json verify is format:check && build && test, so both real paths are covered, but this is the first test that requires dist/.
  (docs/spikes/prove-the-revm-in-a-worker-recipe-the-readme-recommends/measurements.md Decisions 3; packages/embedded-eth-node/test/helpers/revm-worker.ts imports; package.json exports; dorfl.json verify)
- Ratify Decision 2: the copyable example lives at packages/embedded-eth-node/test/helpers/revm-worker.ts and the README links there. package.json files is [dist, src], so the file a consumer is told to copy is NOT in the published tarball; the link only works on GitHub. Consistent with the existing docs/spikes links in the README, so probably fine, but worth a human nod.
  (README.md line 440; packages/embedded-eth-node/package.json files field)
- Un-recorded in-scope decision: the driver spawns a SECOND Worker to assert the stateMode:trie refusal, and the spec asserts its message text (toContain trie, match /revm/i) as the one reading only a revm-backed node can produce. This is scope beyond the task's acceptance list and it couples this spec to the refusal wording in src/revm.ts, which is now asserted in three places. It is a sound response to the task overstating the gas figures as fallback-proof (they are identical across backends), and the spike doc argues it honestly, but it is not in the Decisions block. Ratify or drop.
  (test/revm-worker.spec.ts:96-100; test/helpers/revm-worker-roundtrip.ts trieRefusal block; src/revm.ts:247-256; mirrors test/revm-engine.spec.ts:222)
- Decision 1 leaves three hand-copied SlimNode comlink proxies (worker-entry, this example, any consumer copy), the exact shape that silently dropped senderMode once. The observation note is filed but open with no follow-up task. The spec asserts stateMode / senderMode / engine on the example, so those three would be caught; a future plain field would not. Worth tasking the createWorkerApi factory or a parity assertion?
  (work/notes/observations/worker-entry-cannot-be-reused-by-a-consumers-own-worker-module.md; test/helpers/revm-worker.ts proxy block vs src/worker-entry.ts)
