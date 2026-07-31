---
title: The worker main-thread-gap assertion is a coin-flip on WebKit (received exactly 15 against < 15)
slug: webkit-worker-gap-timing-assertion-flake
---

Spotted 2026-07-31 while driving `revm-state-adapter-spike` through `dorfl do`. Unverified beyond the single observation below; recorded so the next red gate is recognised rather than re-diagnosed.

## What was seen

The acceptance gate (`pnpm format:check && pnpm build && pnpm test`) failed on the rebased tip with exactly one failing test out of sixteen:

```
[webkit] › test/worker.spec.ts:24:1 › slim-node over a comlink Worker: same API + main-thread non-blocking
  expect(t.mainThreadMaxGap).toBeLessThan(15)
  Expected: < 15
  Received:   15
```

The task under build changes NO executable code: its acceptance criteria explicitly forbid touching `packages/embedded-eth-node/src/**`, any `package.json` and `pnpm-lock.yaml`, and its deliverable is an ADR plus artifacts under `docs/spikes/`. So the failure cannot have been caused by the work being gated.

## Why this looks structural rather than incidental

`packages/embedded-eth-node/test/worker.spec.ts:55` asserts a WALL-CLOCK bound: the maximum main-thread gap observed while a Worker computes must be under 15 ms. Two things make that a coin-flip on WebKit specifically:

- **WebKit clamps `performance.now()` to 1 ms.** This is already recorded in `work/specs/tasked/revm-engine-behind-eth-call.md` ("WebKit clamps `performance.now()` to 1 ms, so any sub-millisecond timing assertion is meaningless there"). A clamped clock quantises the measurement to integers, so the observed value lands ON the bound rather than near it — which is exactly what happened: received `15`, bound `< 15`.
- **The repo's own stance elsewhere is that timing is not assertable.** `.github/workflows/ci.yml` and the benchmark config both say CI timing numbers are too noisy to assert on, and that only gas equality, keccak equality and scenario results are assertions. `worker.spec.ts` is the one place that asserts a raw millisecond bound anyway.

The assertion is not worthless — it is guarding a real property (the Worker keeps the main thread responsive) — but the threshold is one quantum away from the value it measures, on the engine with the coarsest clock.

## Why it matters

It reds the acceptance gate for work that has nothing to do with it. Every task in this repo pays the gate, so a coin-flip in it costs an entire `do` run (build agent + gate + review, tens of minutes) and routes an innocent task to needs-attention. It cost exactly that here.

## Shapes a fix could take (not chosen, not tasked)

- Raise the bound to something the clamp cannot reach (e.g. `< 25`), keeping the property while stepping off the quantum boundary.
- Assert the property without the clock (e.g. that the main thread serviced N ticks during the Worker's compute), which is what the test actually cares about.
- Follow the repo's own convention and report the number rather than asserting it, leaving `worker.spec.ts` asserting only the API-equivalence half.
