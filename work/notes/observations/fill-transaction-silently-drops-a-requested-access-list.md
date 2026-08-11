# `eth_fillTransaction` silently drops a requested access list

2026-08-11, noticed while making `eth_estimateGas` charge a request's access list (`eip-2930-access-lists-are-charged-and-warmed`).

`eth_fillTransaction` in `packages/embedded-eth-node/src/node.ts` builds a type-0 or type-2 envelope only (`const type = isLegacy ? 0 : 2`) and never copies the request's `accessList` into `txData`, so a caller who asks it to fill a type-1 request gets back a transaction with no access list and no sign that one was dropped. Its gas estimate is correspondingly NOT charged the list, which is consistent with the transaction it returns (and is why that method was deliberately left alone), but the drop itself is silent rather than an honest edge.

Unverified as a user-facing problem: viem's `prepareTransactionRequest` is the known caller and it re-signs from the fields it reads back, so an access list it sent would vanish from the transaction it then signs.
