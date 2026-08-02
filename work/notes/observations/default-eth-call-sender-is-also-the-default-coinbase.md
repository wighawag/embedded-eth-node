---
title: The node's default eth_call sender is also its default coinbase, so it silently accrues ether
date: 2026-08-02
status: open
---

Noticed while adding the value-bearing-read conformance step (`revm-wasm-upgrade-honest-block-environment`): `evmCall` in `packages/embedded-eth-node/src/node.ts` defaults `from` to the zero address, and the node's default block coinbase is the zero address too, so on any node that has mined priority-fee-paying transactions the default `eth_call` sender holds a growing balance. A test that uses the default sender as its "unfunded address" therefore passes for the wrong reason after the first mined transaction. Not touched here: the new conformance step asserts `eth_getBalance(0x0) == 0` before relying on it, and the engine-vs-engine test names its senders explicitly instead.
