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

## What it measures

- **Per-phase timings** (median of repeats): cold start, deploy, state-changing
  call, read (`eth_call`), ADD-loop compute, keccak256-loop compute.
- **Bundle size** (raw + gzip) of each backend's entry, built with esbuild.
- **Cross-backend keccak-chain equality** — all backends must produce the IDENTICAL
  `keccakLoop(2000)` result (catches keccak / `abi.encodePacked` drift).

The library's own correctness/conformance/honesty tests (differential conformance,
GeneralStateTests, viem-surface, persistence-reload, the `evm_set*` cheats, the
state-root modes) live in the `embedded-eth-node` package, not here.

## Note on `viem`

`viem` is pinned to exactly `2.45.0` here because `@tevm/common` imports chain
names that were dropped from viem ≥ 2.51. This pin is benchmark-only; the library
package itself uses a normal `^2.45.0` range.
