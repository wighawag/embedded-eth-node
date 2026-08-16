<!-- dorfl-sidecar: item=task:document-the-type-3-receipt-gap-where-it-would-be-met type=task slug=document-the-type-3-receipt-gap-where-it-would-be-met allAnswered=false -->

## Q1

**'task:document-the-type-3-receipt-gap-where-it-would-be-met' was bounced — how should we proceed?**

> The task's load-bearing premise is false, and has been false since before the 2026-08-10 re-scope. It is not a receipt-completeness gap and there is no cross-engine divergence: THIS NODE CANNOT PARSE A TYPE-3 TRANSACTION AT ALL, on either engine, so no type-3 receipt (complete or incomplete) can exist and revm's `transact` is never reached with blob fields to omit.
>
> WHERE. `parseTx` (packages/webevm/src/node.ts:579, calls `createTxFromRLP(raw, {common})` at :582 and :598) hands the raw bytes to `@ethereumjs/tx`, whose type-3 deserializer (`createBlob4844TxFromBytesArray`, node_modules/@ethereumjs/tx/dist/esm/4844/constructors.js) throws unless `common.customCrypto.kzg` is set. The node's `Common` (src/node.ts:149-153) sets `customCrypto: {keccak256}` and nothing else. Measured end-to-end against the built `dist` with a signed canonical type-3 transaction: `eth_sendRawTransaction` fails with the raw `EthereumJSError` "A common object with customCrypto.kzg initialized required to instantiate a 4844 blob tx", with no RPC error code and no mention of the node. This is before any engine, so it is identical on the default engine and on revm.
>
> CONSEQUENCES FOR THE TASK AS WRITTEN.
> - Acceptance criterion 2 ("a type-3 transaction on a revm-backed node EXECUTES as a type-3 one ... matching @ethereumjs/vm") cannot be satisfied by mapping `blobVersionedHashes`/`maxFeePerBlobGas` in src/revm.ts. That mapping is necessary but not sufficient; the transaction dies two layers above it.
> - Acceptance criterion 3 ("a type-3 receipt carries blobGasUsed and blobGasPrice ... on both engine paths") would be unreachable, untestable plumbing: no test in this repo can produce a type-3 receipt to assert on.
> - Criterion 5's honest-edge statement would be aimed at the wrong thing. The limitation a consumer actually meets is not "the node does not run a blob fee market", it is "your type-3 transaction is rejected by an internal ethereumjs error". Writing the fee-market caveat while that refusal stands would be a stated limitation that does not describe what happens.
> - The same false claim is written into the code at src/revm.ts:477-481 ("The type-3 receipt is incomplete on BOTH engines"), so the stale premise is currently load-bearing documentation as well as a stale task.
>
> THE HIDDEN DESIGN DECISION, which is why I am not resolving this myself. Making a blob transaction parseable requires deciding what this node does about KZG, and every option is user-visible and hard to reverse for a published package:
>  (a) add a real KZG implementation (e.g. `kzg-wasm`, present in the lockfile only as a transitive dep of tevm under packages/benchmarks) as a RUNTIME dependency of `webevm` — a trusted-setup-carrying wasm dependency in a package whose identity is "slim, in-browser", affecting every consumer's bundle whether or not they ever send a blob;
>  (b) install a non-verifying KZG shim on the node's `Common` purely to satisfy the constructor guard — defensible in that the canonical on-chain form carries no blobs to verify, but it silently makes the node accept a wire form real nodes reject (EIP-4844 `eth_sendRawTransaction` takes the network wrapper, with blobs/commitments/proofs, which this node would then fail to decode differently again), and it decides "this node does not verify blob commitments" in a place nobody reads;
>  (c) refuse type-3 explicitly at submit with a real `-32000` in the node's own words (the repo's honest-edge convention, cf. `refuseIfOverBlockGasLimit`), and keep story 15 as a documented refusal rather than a completed receipt.
> That is a choice about what the node accepts, what it depends on, and which wire form it promises — a design decision at the node level, not a small factual gap inside this task, and (a) in particular is not reversible once published.
>
> SUGGESTED RE-SCOPE. Split into two, and decide (c) vs (a)/(b) first:
>  1. A DECISION item (task or ADR under docs/adr/): "does webevm accept type-3 transactions, and in which wire form". If the answer is (c) refuse, story 15 narrows to an honest-edge refusal naming EIP-4844 and the reason, and the receipt half is dropped as unreachable rather than built.
>  2. Only if the answer is (a) or (b), a build item keeping this task's current criteria 1, 2, 3, 4, 6, 7 — the additive `revm-wasm@^0.4.0` bump in both packages, `blobVersionedHashes`/`maxFeePerBlobGas` in src/revm.ts's `transact`, `blobGasUsed`/`blobGasPrice` on `TransactionResult` (src/types.ts) taken from `outcome.*` on revm and from `runTx`'s own receipt (`@ethereumjs/vm` already computes both; `runTx.js` sets `results.blobGasUsed` and puts `blobGasUsed`/`blobGasPrice` on the type-3 receipt) on the default engine, plus `SerializedReceipt` (src/types.ts:532) and `receiptToRpc` (src/node.ts:725).
>  Worth carrying into whichever item wins: the node's Cancun block header already defaults `excessBlobGas` to 0n, so both engines would report a 1 wei `blobGasPrice` today. That confirms the fee-market caveat this task asks for, but it does not unblock anything, and it should be stated wherever the type-3 answer lands rather than in a receipt nobody can obtain.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
