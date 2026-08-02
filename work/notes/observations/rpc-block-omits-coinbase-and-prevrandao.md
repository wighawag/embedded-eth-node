---
title: eth_getBlockByNumber reports a constant zero miner and no mixHash, even when blockEnv sets them
date: 2026-08-02
status: open
---

Noticed while adding the block-environment conformance step (`revm-wasm-upgrade-honest-block-environment`): `blockToRpc` in `packages/embedded-eth-node/src/node.ts` hardcodes `miner: '0x0000...0000'` and emits no `mixHash`, so a node created with `blockEnv: {coinbase, prevRandao}` mines blocks whose `COINBASE` / `PREVRANDAO` opcodes return the configured values while `eth_getBlockByNumber` still reports a zero miner and nothing at all for prevRandao. The RPC block and the EVM disagree about the same block. (Related, smaller: the genesis block ignores `blockEnv` entirely, so block 0 carries neither.) Not touched here — the conformance step diffs those two fields against the configuration instead.
