---
title: Decisions taken while building 'revm-engine-subpath'
date: 2026-08-01
status: open
decisionsFor: revm-engine-subpath
---

# Decisions taken while building `revm-engine-subpath`

The done record's `## Decisions` block, kept here because the task body is moved
byte-identical by the runner. Each entry: what was chosen, why, what was
rejected, and what it touches. Ratify or reverse.

## 1. A revm read runs with a ZERO base fee, so `BASEFEE` reads 0 there

**Chosen:** `packages/embedded-eth-node/src/revm.ts` passes `baseFeePerGas: 0n`
in the block environment of every read, while passing the node's real `number`,
`timestamp`, `gasLimit`, `coinbase` and `excessBlobGas` through.

**Why:** revm validates the transaction's gas price against the block's base fee
(`GasPriceLessThanBasefee`) and the caller's balance against
`gasLimit * gasPrice` (`LackOfFundForMaxFee`) even for `Revm#call`. The node's
blocks carry a 1 gwei base fee and `eth_call` defaults `from` to the ZERO
address, so with the real base fee every default `eth_call` would fail
validation. Real clients disable both checks for `eth_call`; `revm-wasm@0.1.0`
exposes no such flag (verified against its `ExecuteOptions`), and a zero base fee
with a zero gas price is the only way to get the same effect from outside.

**Rejected:** passing the real base fee plus a matching `gasPrice` (breaks
`eth_call` from any unfunded address, which is the common case); pre-funding the
caller (invents state a read must not invent).

**Touches:** a consumer contract that reads `block.basefee` inside `eth_call`
gets 0 on revm and 1 gwei on `@ethereumjs/evm` — a real, if narrow, divergence
between the two engines. It does not affect gas (fee-independent), so the
cross-backend gas gate cannot see it. `revm-engine-under-conformance-and-gate`
should keep it in mind if it ever diffs block-environment reads, and it is worth
an upstream request to `revm-wasm` for the `disable_base_fee` /
`disable_balance_check` cfg flags.

## 2. Known block-environment gaps in `revm-wasm@0.1.0`: PREVRANDAO

Its `BlockEnv` has no `prevrandao`/`difficulty` field, so `PREVRANDAO` inside a
revm read cannot be given the node's value (`NodeOptions.blockEnv.prevRandao`).
Same shape as (1): not fixable from this side, no gas effect, recorded rather
than hidden.

## 3. The gas-limit mapping is `request.gasLimit + intrinsic`, capped at the block limit

`@ethereumjs/evm`'s `runCall` charges no intrinsic gas, so the node's
`ReadCallRequest.gasLimit` is entirely available to EXECUTION; revm charges
intrinsic out of the TRANSACTION gas limit. Adding intrinsic back reproduces the
default engine's execution budget exactly. The cap exists because revm rejects a
transaction whose gas limit exceeds the block's (`CallerGasLimitMoreThanBlock`,
measured) and the node's default read budget IS the block gas limit. Divergence
window: a call needing within `intrinsic` gas of the entire block gas limit.
Full reasoning at the code site (`src/revm.ts`, `call`).

## 4. An unknown hardfork is REFUSED rather than silently run as Cancun

`connect` maps `common.hardfork()` to a revm spec through a small table and
throws for anything not in it. Unreachable today (the node hardcodes Cancun), but
the alternative is that a future hardfork change leaves reads on Cancun rules,
charging different gas from the transactions with nothing saying so. This is a
NEW refusal, hence recorded. **Touches:** anything that later moves the node's
hardfork must extend `SPEC_BY_HARDFORK` in `src/revm.ts`.

## 5. A CREATE-shaped read goes through `revm.create({commit: false})`

`eth_estimateGas` with no `to` is a deployment estimate; `Revm#call` would treat
the init code as calldata to the zero address and return a plausible, wrong
number. `create` with `commit: false, checkNonce: false` is the simulation
`eth_call` semantics ask for. It is the one path whose read-only-ness rests on an
option rather than on `call`'s structural guarantee — mitigated by the store's
five write methods throwing, so a commit that slipped through would be loud.

## 6. The negative code-index cache is scoped to ONE call

`getCode(codeHash)` rebuilds the `codeHash -> code` index on a miss (ADR 0005:
a stale index runs EMPTY code and returns `success` silently). Caching a MISS
across calls would resurrect exactly that bug for code deployed between two
calls, so `beginCall()` drops the negative set per execution: within one call
nothing can write to the node's state (JS is single-threaded and a read-only call
never writes), so a hash absent at the first opcode is absent at the last. Plus
`KECCAK_EMPTY` short-circuits to empty code. This is the Gate-2 nit (d) on the
spike artifact, answered without weakening the self-healing property.

## 7. Engine identity is `'revm-wasm'`; the worker test asserts identity, not injection

`node.readEngine.id` is the PACKAGE name, matching the default engine's
`'@ethereumjs/evm'`. The acceptance criterion "the engine identity survives the
comlink Worker boundary" is tested as `readEngine` round-tripping through the
worker proxy (`test/worker.spec.ts`), NOT as passing a revm engine to
`createWorkerNode`: an engine is a function-bearing object and comlink
structured-clones the options, which fails. That failure mode is explicitly owned
by `engine-seam-docs-and-honest-edges` (its `DataCloneError` criterion), so it is
not duplicated here.

## 8. `embedded-eth-node/revm` gets its OWN test cut

`test/helpers/cut-revm.ts` exists because the bundler-resolved wasm delivery
shape needs a `.wasm` asset loader and puts ~1.2 MB in the page; folding it into
the shared `cut.ts` made every other spec carry revm (and, with the harness's
default `copy` loader, fail to load at all). The split mirrors the property the
subpath exists for: a suite that does not opt in pays nothing.

## 9. The bundle baseline is pinned at 412.4 KB raw / 124.1 KB gzip

Measured on the default entry AFTER this change (it was 412.3 / 124.0 before)
and asserted in
`packages/benchmarks/test/evm.spec.ts`, together with a metafile check that
`revm-wasm` is absent from the default entry's module graph. Raw bytes are
asserted exactly (esbuild-deterministic); gzip carries 1% of slack because zlib
differs between Node builds.

The honest reading of the 0.1 KB: adding a second EVM engine to the package cost
the DEFAULT entry 0.1 KB, and that 0.1 KB is the node-side `getBlockHash`
accessor on `ReadEngineContext` (core code required by another criterion of this
same task), not revm. Pinning the pre-change number instead would have made the
gate red for a change the task itself mandates; the metafile check is what
actually states "no revm here". **Touches:** any later change that legitimately
grows the core must re-pin it in the same change.

## 10. `revm-wasm` is `^0.1.0`, matching the benchmarks package

The maintainer's decision (task, Resolved item 4) covers `dependencies` vs an
optional peer, not the RANGE. A caret range is what `packages/benchmarks` already
uses, and the lockfile pins 0.1.0, so this only follows existing precedent — the
open question raised in
`work/notes/observations/review-nits-retire-vendored-revm-in-benchmarks-2026-07-31.md`
applies to both and is still open.
