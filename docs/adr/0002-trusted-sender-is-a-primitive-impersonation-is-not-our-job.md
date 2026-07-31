# `senderMode: 'trusted'` is a bare primitive; impersonation is NOT this package's job

`ecrecover` is a fixed ~2ms per transaction and dominates small ones (~80% of a 21k-gas transfer; EVM execution only overtakes it at ~33k gas of execution). A client that signed a transaction already knows the sender, so on a local chain re-deriving it is pure waste. `senderMode: 'trusted'` therefore exposes exactly one thing — *execute this transaction as this sender, do not recover* — via `evm_sendRawTransactionAs` / `evm_sendRawTransactionSyncAs`, measured at ~13x on `runTx` in isolation and ~2.3x end-to-end through a viem-style client, with byte-identical gas and status.

## Considered Options

- **Implement anvil/hardhat-style impersonation** (`evm_impersonateAccount` + unsigned `eth_sendTransaction`). Rejected: impersonation needs a mutable registry of impersonated addresses, which is account POLICY, and this package deliberately has no accounts. It is also strictly less general — a higher layer can build impersonation ON the primitive by fabricating a signature and passing the claimed sender, and it needs no private key to do so.
- **Extend `eth_sendRawTransaction` with an optional second `from` parameter.** Rejected: it silently overloads a standard method with security-relevant semantics, where a distinct `evm_*` name is greppable and cannot be adopted by accident.

## Consequences

- Two different callers want the one primitive: an ordinary signed transaction skipping a redundant recovery, and a higher layer implementing impersonation with a fabricated signature. Neither needs the node to know which it is.
- **`'trusted'` removes the only thing binding a transaction to its sender**, so any caller can claim any address. It is gated behind an explicit option and the cheats throw `-32601` in the default mode, rather than being silently available.
- A caller-supplied sender for a transaction it did not really sign must make the tx BYTES unique per sender (e.g. derive the dummy `r` from the address), because `from` is not part of a transaction and the hash comes from the bytes alone. anvil hit exactly this and fixed it by folding the sender into hash computation (foundry #4210).
- Transactions sent with a fabricated signature are not portable to a `'recover'` node, so a state dump containing them is not replayable chain history.
