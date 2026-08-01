# Frame budget, measured on the node WITH the revm read engine

Date: 2026-08-01. Produced by `revm-engine-under-conformance-and-gate`, which
added the `embedded-eth-node-revm-engine` backend row to `packages/benchmarks`.

This file exists so the figure the README publishes has a dated, reproducible
source with its conditions attached. `engine-seam-docs-and-honest-edges` is the
task that publishes it.

## What was unmeasured, and why it mattered

The numbers this feature was justified by (frame 12.4 ms Chromium / 15.0 ms
WebKit on `@ethereumjs/evm`, against 3.8 / 5.0 on revm) were measured on RAW
backends: raw `@ethereumjs/*` against raw `revm-wasm`, each owning its own state
with no node in the path. The configuration a consumer actually ships is
`createNode({engine: await createRevmEngine({wasm})})`, where the node's own
dispatch, state adapter and RPC layer sit on top of the interpreter and become
the dominant term once the interpreter stops being it. Nobody had measured that,
so the README had no truthful number to publish for the configuration it
recommends.

## How to reproduce

```sh
pnpm --filter embedded-eth-node-benchmarks test --project=chromium
pnpm --filter embedded-eth-node-benchmarks test --project=webkit
```

The `frame` row is 100 small `number()` view reads back to back, against a
16.6 ms 60fps budget. The suite prints a `=== frame budget: the number to cite
(REPORTED, not asserted) ===` block naming the three rows below. Each row is the
MEDIAN of 7 repeats.

## Measured

Two samples per engine, same machine, an ordinary developer laptop that was NOT
specially quieted. Absolute values are load-sensitive; the RATIOS are the durable
part.

| row                             | Chromium    | WebKit    |
| ------------------------------- | ----------- | --------- |
| `embedded-eth-node`             | 10.4, 10.2  | 13.0, 13.0 |
| `embedded-eth-node-revm-engine` | 3.7, 3.9    | 4.0, 4.0  |
| `revm` (raw, owns its state)    | 3.4, 2.9    | 4.0, 4.0  |

As a share of the 16.6 ms frame budget: the JS node ~63% Chromium / ~78% WebKit;
the node on revm ~22% / ~24%; raw revm ~20% / ~24%.

## How to read it

- **The node on revm keeps essentially all of raw revm's win here.** The gap
  between the node-on-revm row and the raw-revm row is the node's own per-call
  dispatch, and at this call shape it is small (~0.3 ms per 100 reads on
  Chromium, and below WebKit's measurement floor). The predicted "node dispatch
  becomes the dominant term" is real in the sense that it is now the larger share
  of what remains, but what remains is small.
- **Do not quote a sub-millisecond figure from WebKit.** WebKit clamps
  `performance.now()` to 1 ms, so the WebKit rows are quantised: a 4.0 ms frame
  row carries roughly ±1 ms of quantisation on its own, and the per-call and
  `floor` rows there are meaningless.
- **These are not the same machine as the 12.4 / 15.0 baselines**, which were
  taken on a quiet machine. The JS-node rows here (10.4 / 13.0) are that same
  configuration measured again, so use them as the like-for-like comparison
  rather than mixing a new revm number with an old JS number.
- **Timings are not asserted anywhere.** The gate asserts execution-gas equality,
  keccak-chain equality and the scenario results; timing rows are printed only.
  See `packages/benchmarks/test/evm.spec.ts`.

## Gas, on the same rows

Identical across every backend, which is what makes the timing comparison
meaningful at all (an engine that charged different gas would be running a
different program):

- `number()` — 2446 execution gas
- `sumTo(2000)` — 498689
- `keccakLoop(2000)` — 1107052, returning
  `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`
