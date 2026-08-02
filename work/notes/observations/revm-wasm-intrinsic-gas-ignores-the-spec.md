---
title: revm-wasm computes intrinsic gas at a fixed late spec, so it CHARGES EIP-3860 on pre-Shanghai forks
date: 2026-08-02
status: open
---

Measured while resolving `intrinsic-gas-charges-eip-3860-on-forks-that-predate-it`: `revm-wasm@0.3.0` charges EIP-3860's initcode word cost (2 gas per 32-byte word) on `BERLIN`, `LONDON` and `MERGE`, all of which predate EIP-3860 — confirmed two ways, by delta across an initcode word boundary (6 gas per extra word-plus-zero-byte instead of 4) and by decomposing a CREATE's `totalGasSpent` (53296 where the protocol charges 53292). This is the same root cause as `./revm-wasm-gasused-carries-the-eip-7623-floor.md`, one step worse: the pre-execution intrinsic-gas computation is not merely REPORTED at a late spec, it is CHARGED at one. Opcode gating is unaffected and exactly right (`BASEFEE` halts on Berlin, `PUSH0` before Shanghai, `TLOAD` before Cancun), so this looks confined to the intrinsic-gas path rather than to the spec plumbing generally. Probe and numbers: `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`. Not reported upstream yet; `embedded-eth-node/revm` now refuses those three forks (ADR 0008, amended).
