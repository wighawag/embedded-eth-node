---
title: The other hand-written test fixtures still require Shanghai via PUSH0
date: 2026-08-10
status: open
---

Noticed while making the affordability negative control fork-portable (`close-the-residual-holes-in-the-affordability-classification`, item 4): the same latent `PUSH0` dependency remains in `BLOCKHASH_PROBE_CODE` (`0x60014303405f5260205ff3`) in `packages/embedded-eth-node/test/helpers/revm-engine.ts`, and the generated `blockEnvProbeRuntimeBytecode` in `test/helpers/block-env-probe.ts` is compiled `--evm-version cancun`. Nothing is wrong today (both only ever run on the node's pinned fork), but the day anything runs those probes per fork they become invalid opcodes at `berlin`/`london`/`paris` and misreport as a failure of the thing under test. Not touched: that task's scope was the affordability control only.
