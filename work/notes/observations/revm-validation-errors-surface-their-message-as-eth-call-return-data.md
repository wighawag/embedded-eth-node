---
title: A revm validation error reaches an eth_call caller as ASCII "return data"
date: 2026-08-02
---

Noticed while tightening the value-bearing conformance step (`value-bearing-conformance-steps-assert-the-failure-shape`): `revm-wasm` puts the TEXT of a validation error into `outcome.returnData` (measured: an unaffordable transfer returns `returnData` = the UTF-8 bytes of `Transaction(LackOfFundForMaxFee { fee: 1, balance: 0 })`), and `packages/embedded-eth-node/src/revm.ts` passes `outcome.returnData` through verbatim, so `node.ts`'s `eth_call` throws `RpcError(3, 'execution reverted', '0x5472616e...')`. The default `@ethereumjs/evm` engine returns `0x` for the same call, so the two engines diverge in the error's `data` field, and a viem client would try to decode an engine message as a contract's revert reason.

Not touched here (out of scope, and the fix hides a real choice: drop the bytes, or surface the engine's message as its own honest-edge error rather than as revert data). The tightened conformance step tolerates it explicitly: a rejection may carry no return data OR return data that names the shortfall, which is why `isCalleeAnswer()` in `packages/embedded-eth-node/test/helpers/affordability.ts` exists.
