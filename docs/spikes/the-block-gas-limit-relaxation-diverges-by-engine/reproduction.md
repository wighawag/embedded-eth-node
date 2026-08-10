# The block-gas-limit divergence, reproduced before it was removed

Date: 2026-08-10. Chromium, `packages/embedded-eth-node`, `revm-wasm@0.3.1`.

This records the divergence AS MEASURED, on both engines, before the fix, so the change is judged against evidence rather than against the task's description of it. The instrument is a step added to the shared, engine-parameterised conformance battery (`test/helpers/conformance.ts`, step 15), which runs on the default `@ethereumjs/evm` engine via `conformance.spec.ts` (both state modes) and on revm via `revm-conformance.spec.ts`.

## What was asked

One node option away from identical: a signed EIP-1559 transfer with `gas: 40_000_000` (above the default `blockGasLimit` of `30_000_000`), submitted through `eth_sendRawTransactionSync`, then the same transaction on a node created with `blockGasLimit: 60_000_000n`, then one with `gas: 60_000_001` on that same node.

## Before: two answers, by engine

Run: `npx playwright test conformance.spec.ts --project=chromium` (the filter matches `revm-conformance.spec.ts` too).

Default engine, `stateMode:'none'` AND `stateMode:'trie'` (identical, 9 mismatches each):

```
XX block gas limit refuses an over-limit tx; blockGasLimit lifts it:
  over-limit tx at the default limit: node="mined 0x1" ref="refused"
  refusal names the tx's gas limit: node=false ref=true
  refusal names the block gas limit exceeded: node=false ref=true
  refusal names `blockGasLimit` as the knob: node=false ref=true
  no block was mined for the refused tx: node="1" ref="0"
  sender nonce after the refusal: node="1" ref="0"
  within-limit tx at the default limit: node="refused" ref="mined 0x1"
  tx above the RAISED limit: node="mined 0x1" ref="refused"
  refusal names the CONFIGURED block gas limit: node=false ref=true
```

So on the default engine the over-limit transaction was MINED with status `0x1`, a block was produced for it and the sender's nonce advanced. (`within-limit tx ... node="refused"` is the knock-on: the nonce had already been consumed by the transaction that should not have been mined.) A transaction one gas above even the RAISED 60,000,000 limit was mined too, so the limit was not being enforced at any configured value.

revm, `stateMode:'none'` (4 mismatches):

```
XX block gas limit refuses an over-limit tx; blockGasLimit lifts it:
  refusal names the tx's gas limit: node="NOT named, refusal was:
    embedded-eth-node/revm: the transaction is invalid and was NOT executed:
    Transaction(CallerGasLimitMoreThanBlock)" ref="named"
  ... (the same message, for the other three naming checks)
```

So revm REFUSED the same transaction, mined it on the node configured with `blockGasLimit: 60_000_000n`, reported the configured `GASLIMIT` through a contract, and refused the one above the raised limit. Everything except the WORDS was already right on revm; nothing was right on the default engine.

Mechanism confirmed, exactly as the task stated it:

- default engine: `src/engine.ts` passed `skipBlockGasLimitValidation: true` to `runTx`, which otherwise refuses `block.header.gasLimit < tx.gasLimit`.
- revm: `src/revm.ts`'s `transact` passes no simulation switches (it cannot: `revm-wasm` refuses to combine any of them with committing), so `CallerGasLimitMoreThanBlock` is raised before the first opcode.
- the conformance battery's own reference `runTx` passes `skipBlockGasLimitValidation` too (`Reference.mineBlock`), so a node-against-reference diff is structurally blind to this: the step asserts the NODE's absolute answer per engine instead.

## After: one answer

Same command, after dropping the flag from the default engine and adding the node's own refusal at submit (`refuseIfOverBlockGasLimit`, `src/node.ts`):

```
[conformance:none] 23 steps, 0 mismatches
  OK block gas limit refuses an over-limit tx; blockGasLimit lifts it
[conformance:trie] 23 steps, 0 mismatches
  OK block gas limit refuses an over-limit tx; blockGasLimit lifts it
[revm-conformance:none on revm-wasm] 23 steps, 0 mismatches
  OK block gas limit refuses an over-limit tx; blockGasLimit lifts it
```

The refusal, identical on every engine (captured from `engine-seam.spec.ts`, where the engine is a stub that would have executed the transaction happily):

```
transaction gas limit 40000000 exceeds the block gas limit 30000000, so no block
this node builds could contain it. It is REFUSED rather than mined against a limit
the block does not have (a real node refuses it too, and this node's other EVM
engine always did). To allow it, raise the limit:
createNode({blockGasLimit: 40000000n}). The default is 30000000n, or
blockEnv.gasLimit if you set the block environment explicitly. The block then
really is that large: GASLIMIT reports the configured value to a contract, and
eth_getBlockByNumber reports it too.
```

RPC error code `-32000`, and the engine's `transact` is never called (asserted: the stub's transact count is unchanged across the refusal).

## Can the step go red?

It DID, above, before the production change: red on the default engine for the behaviour (mined instead of refused) and red on revm for the wording. Both halves of the bar were demonstrated by the pre-fix run rather than asserted.

## One premise of the task that did NOT hold

The task warned that "the read budget follows the block gas limit, so a consumer who sets it enormous also enlarges the default `eth_call` budget". It does not: `evmCall` in `src/node.ts` used a literal `30_000_000n`, never `blockGasLimit`, so the two were already independent by accident. The link is now decided ON PURPOSE and named (`DEFAULT_READ_BUDGET`), with the reasoning at the use site: a raised block gas limit must not silently buy every unbudgeted `eth_call` a proportionally longer runaway, and the revm engine's Osaka refusal (`REVM_REFUSED_HARDFORKS`) quotes the read budget as a fixed 30000000, which a per-node value would make wrong for some nodes and right for others.
