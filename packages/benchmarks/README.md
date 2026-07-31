# embedded-eth-node-benchmarks

**Private, never-published** benchmark package. It compares
[`embedded-eth-node`](../embedded-eth-node) against raw `@ethereumjs/*` backends
and [`tevm`](https://github.com/evmts/tevm) on the SAME scenario (deploy a Counter,
N `increment()` state txs, a `number()` read, and ADD-loop / keccak256-loop
compute), in real Chromium via
[`playwright-browser-harness`](https://www.npmjs.com/package/playwright-browser-harness).

It exists as a separate package so that `tevm` (and the `viem` exact-pin it forces,
plus the rest of the benchmark toolchain) stay **out of the library's dependency
tree**. The library package only depends on `@ethereumjs/*` + `@noble/hashes`.

## Run

```sh
pnpm install          # at the monorepo root
pnpm --filter embedded-eth-node-benchmarks test
```

## The optional `revm` row

`revm` (Rust, compiled to WebAssembly) is included as a **7th backend**, but its
artifacts are **not committed** — `evm_bg.wasm` is ~1.1 MB and comes from a
separate feasibility spike in a revm clone. Vendor them in first:

```sh
pnpm --filter embedded-eth-node-benchmarks vendor:revm \
  ../../../revm/spike/dist-speed/c-all-precompiles
```

Without them the imports resolve to a stub and the row is **skipped**, so the
suite still passes on a machine that has never seen the spike.

Use the `c-all-precompiles` build at `opt-level=3`. Both halves of that are load
bearing: the spike measured that omitting precompiles **changes gas** (an omitted
address stops being pre-warmed, costing +2500 per cold access), and that
`opt-level="z"` costs **~5x on keccak**.

The row is a **hybrid** and only half of it is meaningful — see the header comment
in `test/helpers/backend-revm.ts`:

| rows | engine | meaningful? |
|---|---|---|
| `read`, `compute`, `keccak`, `frame`, `floor`, gas | revm-wasm | **yes** |
| `coldStart`, `deploy`, `callAvg` | `@ethereumjs/vm` + a full host-state resync | **no** |

The revm spike is read-only (it returns state changes but never commits them, and
reports a code *hash* rather than code), so writes stay on `@ethereumjs/vm`. That
is also the integration actually proposed: keep `runTx` on ethereumjs, where
ecrecover dominates and the interpreter is ~6% of a transaction, and put revm
behind `eth_call`, where the interpreter is ~100% of the time.

## What it measures

- **Per-phase timings** (median of repeats): cold start, deploy, state-changing
  call, read (`eth_call`), ADD-loop compute, keccak256-loop compute.
- **Bundle size** (raw + gzip) of each backend's entry, built with esbuild.
- **Cross-backend keccak-chain equality** — all backends must produce the IDENTICAL
  `keccakLoop(2000)` result (catches keccak / `abi.encodePacked` drift).
- **Cross-backend GAS equality** — every backend implements the same spec, so the
  same call must cost the same **execution gas**. This is the gate for replacing
  the interpreter: engines that disagree on gas disagree on where execution runs
  OUT of gas, so a client replaying the chain would fork. Matching return values
  is **not** sufficient. It has already earned its keep twice, catching an
  EIP-2929 warmth leak in the raw-`runCall` backends here, and confirming that
  revm-wasm is gas-identical to `@ethereumjs/evm`.
- **MGas/s** — the only backend-independent speed unit, and directly comparable to
  published evmone/revm/geth figures unlike wall-clock ms.
- **Frame budget** — 100 small view reads back to back (the on-chain-game shape),
  against a 16.6 ms 60fps budget, plus the fixed per-call floor.

The library's own correctness/conformance/honesty tests (differential conformance,
GeneralStateTests, viem-surface, persistence-reload, the `evm_set*` cheats, the
state-root modes) live in the `embedded-eth-node` package, not here.

## Note on `viem`

`viem` is pinned to exactly `2.45.0` here because `@tevm/common` imports chain
names that were dropped from viem ≥ 2.51. This pin is benchmark-only; the library
package itself uses a normal `^2.45.0` range.
