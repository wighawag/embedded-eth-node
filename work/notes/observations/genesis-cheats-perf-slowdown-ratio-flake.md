---
title: genesis-cheats-perf asserts a trie-vs-none SPEED RATIO, which flips under load
slug: genesis-cheats-perf-slowdown-ratio-flake
---

Spotted 2026-07-31 while driving `retire-vendored-revm-in-benchmarks`. Unverified beyond two observations; recorded so the next red gate is recognised rather than re-diagnosed.

`packages/embedded-eth-node/test/genesis-cheats-perf.spec.ts:55` asserts `expect(s.perf.callSlowdownX).toBeGreaterThanOrEqual(1)`, i.e. that `stateMode:'trie'` is never measured as FASTER per call than `'none'`. That is a wall-clock ratio of two short measurements, so on a loaded machine it can come out below 1 and red the whole acceptance gate. It failed once on Chromium during a full `pnpm test` while other browsers were running, and passed every time the file was run on its own (measured 1.62x).

Same family as `webkit-worker-gap-timing-assertion-flake.md`: the repo's own stance elsewhere (CI workflow, benchmark config) is that timing numbers are too noisy to assert on, and these two specs are where a raw timing bound is asserted anyway.
