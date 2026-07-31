---
'embedded-eth-node': minor
---

Add `senderMode: 'recover' | 'trusted'` to skip ecrecover on a local chain.

`ecrecover` is a fixed ~2ms per transaction and dominates small ones (~80% of a
21k-gas transfer; EVM execution only overtakes it at ~33k gas of execution). A
client that signed a tx already knows the sender, so re-deriving it on a local
chain is pure waste.

`senderMode: 'trusted'` (opt-in; default stays `'recover'`) enables
`evm_sendRawTransactionAs` / `evm_sendRawTransactionSyncAs`, which take
`[raw, from]` and pin the sender instead of recovering it. Measured ~13x on
`runTx` in isolation, ~2.3x end-to-end through a viem-style client, and ~3.9x
when the caller also skips signing (fabricated signature). Gas, status, logs,
receipts and post-state are byte-identical to `'recover'`, asserted field by
field in a new differential test.

The primitive is just "execute as this sender, do not recover". It serves both an
ordinary signed tx bypassing a redundant recovery and a higher layer implementing
anvil-style impersonation on top with a fabricated signature. Impersonation
itself is account policy and remains out of scope for this package.

**`'trusted'` removes the only thing binding a tx to its sender**, so any caller
can claim any address. It is gated behind an explicit option, the cheat methods
throw `-32601` in the default mode, and it must never be exposed to untrusted
callers. See the README section "Sender mode" for the full caller contract.
