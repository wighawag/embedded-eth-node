---
title: revm-wasm's Outcome.gasUsed reports the EIP-7623 calldata floor even on pre-Prague specs
date: 2026-08-02
status: open
---

Noticed while measuring hardfork costing for `prague-intrinsic-gas-floor-or-refuse`: for a call with 100 non-zero calldata bytes, `revm-wasm@0.3.0` reports `totalGasSpent` 22600 and `gasUsed` 25000 on **every** spec from BERLIN to OSAKA — 25000 being the EIP-7623 floor, which does not exist before Prague (`docs/spikes/prague-intrinsic-gas-floor-or-refuse/measurements.md`, section 4). `embedded-eth-node/revm` reads `totalGasSpent`, so nothing is affected today, but a future change that reaches for `gasUsed` (it is the refund-net number a receipt wants) would pick up a post-Prague floor on a Cancun read. Not investigated further: it may be revm's own behaviour or the wasm layer's. Reported upstream as https://github.com/wighawag/revm-wasm/issues/4 (filed 2026-08-02), together with `./revm-wasm-intrinsic-gas-ignores-the-spec.md`, which is the same root cause one step worse: there the late spec is not merely REPORTED but CHARGED.
