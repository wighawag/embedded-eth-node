# revm compiled to WebAssembly is the engine direction, not tevm, guillotine or yevm

`@ethereumjs/evm` runs at ~20 MGas/s, which is the ceiling for the consuming use case (an in-browser on-chain game whose hot path is compute-heavy `eth_call`). revm compiled to `wasm32-unknown-unknown` measures 11x faster on compute and 19x on keccak in Chromium, 18x and 21x in WebKit, at 428 KB gzipped — and, critically, charges gas IDENTICAL to `@ethereumjs/evm` on every probe, which is the property that makes an interpreter swap safe at all.

## Considered Options

- **tevm.** Rejected on evidence: its current release (`1.0.0-rc.151`) is marketed as ZEVM/Zig-backed, but `@evmts/zevm/evm` is literally `export * from "@ethereumjs/evm"` at the SAME version we already use. It is 3.5x our bundle and 20-70x our latency, and `@tevm/node` has a top-level `import ... from 'fs'` so it does not bundle for the browser at all.
- **guillotine / guillotine-mini** (Zig, MIT). Deferred: the full repo is self-described early alpha at ~52% spec pass with a do-not-use notice; guillotine-mini is stronger but targets `wasm32-wasi` (needing a shim) and publishes no artifact.
- **yevm** (Rust). Rejected outright on LICENSING despite being the best architectural fit (async-first `Chain` trait, `wasm32-unknown-unknown`, 99.6% GeneralStateTests): it is **PolyForm Noncommercial 1.0.0**, which cannot ship inside an MIT package and is incompatible with AGPL too.
- **Nomic Foundation's EDR.** Rejected: MIT and mature, but it is itself built on revm and ships only as native N-API addons; its WASM investigation (NomicFoundation/edr#803) has been open and untouched since Feb 2025, blocked on `tokio` and threads.

## Consequences

- revm is an ENGINE, not a node: roughly `@ethereumjs/evm` + `@ethereumjs/statemanager` + a faster ecrecover. Transaction RLP parsing, block construction, receipts, `cumulativeGasUsed` and the MPT trie all stay ours.
- Its `ecrecover` precompile is ~4.2x `@noble/curves` at zero additional bytes, so adopting revm is a crypto swap as well as an interpreter swap.
- revm's `transact()` takes `caller` DIRECTLY and never recovers a sender, so it does not remove ecrecover from the write path by itself; that remains the caller's job.
- **The cross-backend gas gate, not the benchmark, is what licenses the swap.** Engines that agree on every return value can still disagree on gas, and would then disagree on where execution runs OUT of gas — a state fork for anyone replaying the chain. That gate has already caught one real non-conformance (an EIP-2929 warmth leak) and proved revm gas-identical on both engines.
- No candidate ships a browser-ready wasm on npm, so the artifact must be built and published from a repo we control.
