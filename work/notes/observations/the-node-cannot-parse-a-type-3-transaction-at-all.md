# The node cannot parse a type-3 transaction at all, so the "incomplete type-3 receipt" gap does not exist as described

2026-08-10. Found by the build agent while attempting `document-the-type-3-receipt-gap-where-it-would-be-met`, which STOPPED on it rather than building; verified independently against the bytes before this note was written.

`parseTx` in `packages/embedded-eth-node/src/node.ts` hands raw bytes to `createTxFromRLP(raw, {common})`. For a type-3 transaction `@ethereumjs/tx` routes to `createBlob4844TxFromBytesArray`, whose FIRST statement throws `A common object with customCrypto.kzg initialized required to instantiate a 4844 blob tx` unless `opts.common?.customCrypto?.kzg` is defined. The node's `Common` sets `customCrypto: {keccak256}` and nothing else, so the throw always fires. This happens ABOVE the engine seam, so it is identical on the default engine and on revm.

Two consequences worth keeping:

- **There is no type-3 cross-engine divergence.** Both engines fail the same way, for the same reason, before either is reached. A type-3 receipt, complete or incomplete, cannot be produced by this node at all, so nothing downstream can assert on one.
- **A live comment in `src/revm.ts` states the false version.** In the `transact` request mapping it says the type-3 receipt `is incomplete on BOTH engines` because `blobGasUsed` / `blobGasPrice` are absent from the seam's result, and points at the task above as where the limitation is documented. The absent receipt fields are real, but they are not what a consumer meets: what a consumer meets is a raw `EthereumJSError` with no RPC error code and no mention of the node. Whichever item finally answers the type-3 question owns correcting that comment.

The unresolved question this leaves is a design decision, not a defect to fix: making a blob transaction parseable means deciding whether `embedded-eth-node` carries a real KZG implementation as a runtime dependency (bundle cost for every consumer, and irreversible once published), installs a non-verifying shim (which would accept a wire form real nodes reject, since EIP-4844 `eth_sendRawTransaction` takes the network wrapper), or refuses type-3 explicitly in the node's own words per the repo's honest-edge convention. That is recorded in the task's needs-attention sidecar at `work/questions/task-document-the-type-3-receipt-gap-where-it-would-be-met.md`, awaiting the maintainer.

Incidental, and it survives whichever way that decision goes: the node's Cancun block header already defaults `excessBlobGas` to `0n`, so a blob gas price obtained today would be 1 wei. The node runs a constant fee market and tracks no excess blob gas across blocks.
