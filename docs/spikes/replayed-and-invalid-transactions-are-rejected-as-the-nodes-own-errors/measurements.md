# What the node did with an invalid transaction, and what it does now

Taken 2026-08-10 against `revm-wasm@0.3.1` and `@ethereumjs/vm@10.1.2`, node 24, with the two probes next to this file:

```
packages/embedded-eth-node/node_modules/.bin/tsx docs/spikes/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors/probe-invalid-transactions.mjs
packages/embedded-eth-node/node_modules/.bin/tsx docs/spikes/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors/probe-intrinsic-floor.mjs
```

Both probes drive the real node (`createNode`) through `eth_sendRawTransactionSync`, once per engine, on `stateMode:'none'` at base fee 7 with `maxFeePerGas` 10 and `maxPriorityFeePerGas` 1.

## 1. The baseline: four invalid transactions, before this change

| case | `@ethereumjs/evm` | revm | state moved |
| --- | --- | --- | --- |
| replayed nonce (0 again) | `the tx doesn't have the correct nonce. account has nonce of: 1 tx has nonce of: 0 (vm hf=cancun -> block number=2 hash=0x93… -> tx type=2 hash=0xee… )` | `Transaction(NonceTooLow { tx: 0, state: 1 })` | NOTHING |
| far-future nonce (99) | `the tx doesn't have the correct nonce. account has nonce of: 0 tx has nonce of: 99 (vm hf=… )` | `Transaction(NonceTooHigh { tx: 99, state: 0 })` | NOTHING |
| unaffordable | `sender doesn't have enough funds to send tx. The upfront cost is: 1000000000000168000 and the sender's account (0xf39f…) only has: 1000000000000000000 (vm hf=… )` | `Transaction(LackOfFundForMaxFee { fee: 1000000000000210000, balance: 1000000000000000000 })` | NOTHING |
| gas limit 20999 | `INTRINSIC_GAS_TOO_LOW: tx gas limit 20999 is lower than the minimum gas limit of 21000 (vm hf=… )` | `Transaction(CallGasCostMoreThanGasLimit { initial_gas: 21000, gas_limit: 20999 })` | NOTHING |

What this settles:

1. **Both engines already REFUSE all four, and neither half-commits.** Every balance, nonce, storage slot and block number was unchanged afterwards, on both. So the work here is not to make the node refuse; it is to make the refusal SAYABLE.
2. **Nothing reached the caller as a JSON-RPC error.** Both arrived as a plain `Error` with `code` `undefined`, i.e. neither an `RpcError` nor anything a client can branch on.
3. **The two engines share no vocabulary at all**, and one of them is wasm-shaped: `Transaction(NonceTooLow { tx: 0, state: 1 })` is Rust's `Debug` rendering of an enum variant, arriving where a client expects prose. That is the transaction-path twin of the divergence `stop-forwarding-revms-validation-error-text-as-eth-call-return-data` removed from the read path (revm's validation text arriving as `eth_call` return data).
4. **`@ethereumjs/vm` appends a dump of the whole block and transaction to every one of its messages** (`(vm hf=cancun -> block number=… hash=… -> tx type=… )`), which is debugging output, not a refusal.

## 2. The affordability line is `value + gasLimit * maxFeePerGas`, on BOTH engines

| value | `@ethereumjs/evm` | revm |
| --- | --- | --- |
| `balance - gasLimit*maxFee` (the last affordable wei) | mined | mined |
| `balance - gasLimit*maxFee + 1` | refused, `max cost is: 1000000000000000001` | refused, `LackOfFundForMaxFee { fee: 1000000000000000001 }` |
| `balance - gasLimit*effectiveGasPrice` | refused | refused |

So the engines agree to the WEI, and they agree on the MAX fee rather than the effective one — EIP-1559's own `assert balance >= gas_limit * max_fee_per_gas`. The third row is the trap: a node checking what the transaction will actually be CHARGED (`gasLimit * effectiveGasPrice`) would admit a window `gasLimit * (maxFee - effective)` wide that both engines then refuse. `upfrontCost()` in `src/node.ts` therefore uses the max fee, and `test/helpers/invalid-transactions.ts` pins both sides of the boundary (`unaffordableByOneWei` and its `affordableToTheWei` control).

Note also that the two engines reach the same verdict by different routes: `@ethereumjs/vm` checks `getUpfrontCost(baseFee)` (the EFFECTIVE price) first and the EIP-1559 max cost second, so its baseline message named `168000` where revm named `210000` for the same transaction. Both refuse; only the number in the sentence differed. One node-side check removes that too.

## 3. The intrinsic-gas floor is the TRANSACTION's own figure, not the read path's

Each row: the two candidate figures the node has in reach, then each engine's ACTUAL floor, found by submitting the same transaction at `floor - 1` and at `floor`.

| transaction | `src/intrinsic-gas.ts` | `tx.getIntrinsicGas()` | at `floor-1` | at `floor` |
| --- | --- | --- | --- | --- |
| plain transfer | 21000 | 21000 | refused on both | mined on both |
| calldata (5 non-zero, 3 zero) | 21092 | 21092 | refused on both | mined on both |
| create (8 bytes of initcode) | 53106 | 53106 | refused on both | mined on both |
| EIP-2930, 1 address + 2 keys | **21000** | **27200** | refused on both | mined on both |

The last row is the whole decision. The shared `intrinsicGas()` of `src/intrinsic-gas.ts` carries no ACCESS-LIST term (an `eth_call` has no access list), so it is 6,200 gas short of the floor both engines enforce for a type-1 transaction. A node-side check built on it would wave that transaction through and let whichever engine is installed refuse it in its own vocabulary — the exact divergence the refusal exists to remove. `refuseIfBelowIntrinsicGas` therefore uses the parsed transaction's own `getIntrinsicGas()` (`@ethereumjs/tx`), which is also the figure `runTx` validates against, so the node's refusal and the default engine's backstop agree by construction.

## 4. Decisions taken here

Recorded because a reviewer or a later task would otherwise have to re-derive them, and because two of them are visible to consumers. Each is also written at its code site.

1. **The node refuses these four itself, BEFORE the engine, rather than translating what an engine threw.** The alternative was to classify the engine's error above the seam (or to widen the seam with a rejection reason each engine fills in). Both alternatives mean parsing prose — `Transaction(NonceTooLow { … })` on one engine, `the tx doesn't have the correct nonce. account has nonce of: 1 …` on the other — in a per-engine table that every future engine must also supply. Refusing in the node needs no table, is identical on every engine by construction, and follows the precedent this repo already set and argued for at `refuseIfOverBlockGasLimit` in `src/node.ts` (the block gas limit is refused by the node, with the engines' own checks left as the backstop underneath). It also fixes the ORDER of the rules, which no two engines agree about. TOUCHES: `src/engine.ts` and `src/revm.ts` keep their own rejections as backstops and are unchanged; the revm engine's `validation-error` conversion is now reachable only for causes the node does not pre-check (EIP-3607, blob fees, anything a future revm adds).
2. **The vocabulary is geth's leading clause** (`nonce too low` / `nonce too high` / `insufficient funds for gas * price + value` / `intrinsic gas too low`), followed by this node's own honest-edge half (what happened, what to do, and the numbers). Alternative considered: a private phrasing of our own. Rejected because viem maps exactly those phrases onto typed errors, so a private dialect would cost every consumer a translation and buy nothing. TOUCHES: any consumer branching on error text; the phrases are asserted in `test/revm-invalid-transactions.spec.ts`.
3. **The code is `-32000`, with no `data`.** Same code as the node's existing over-the-block-gas-limit refusal, which is the range geth uses for a transaction its pool refuses. NOT `3 execution reverted`: nothing executed, so there is no return data, and `data` on that error means the callee's revert payload to a client — the mistake recorded in the `rejectionMessage` JSDoc of `src/revm.ts`. No new error code was invented.
4. **The state-dependent rules are checked at MINE time, the transaction-only rules at SUBMIT time.** The nonce and the money change while a transaction waits in `pending` (in `manual`/`interval` mining a consumer submits nonce 0 and nonce 1 back to back), so they are read immediately before the engine would execute it. The intrinsic-gas floor and the block gas limit cannot change with time, so they are refused eagerly, by the `eth_sendRawTransaction*` call that submitted them. TOUCHES: nothing else; both sites already existed as concepts.

## 5. Can the battery go red? Measured by mutation

Chromium, `test/revm-invalid-transactions.spec.ts`, every mutation reverted afterwards.

| mutation | result |
| --- | --- |
| `refuseIfBelowIntrinsicGas` uses the shared `intrinsicGas()` instead of `tx.getIntrinsicGas()` | RED on `belowIntrinsicGasWithAccessList` alone: `engine text leaked (vm hf= | INTRINSIC_GAS_TOO_LOW)` on the reference and `(Transaction( | revm))` under test, plus the cross-engine message mismatch. The other five cases stay green, which is what says the access-list term is what that case is measuring. |
| `upfrontCost()` computes the priority fee instead of `maxFeePerGas` | RED on `unaffordableByOneWei`: the node admits the transaction and both engines refuse it in their own words (`The max cost is: 1000000000000000001` / `LackOfFundForMaxFee`). |
| `refuseIfSenderCannotSend` called AFTER `engine.transact` instead of before | RED on all four state-dependent cases, via the message: the engines answer first, so the refusal is engine-shaped again. `moved` stays `NOTHING` — the engines do not half-commit either — which is why the mutation below is the one that exercises that field. |
| `refuseIfSenderCannotSend` advances the sender's nonce before throwing (a half-committed rejection, injected) | RED on `replayedNonce`: `moved: senderNonce`, `recovered: refused`, `blocksMined: 0`, `cumulativeGasUsed: no receipt`. This is the failure the battery exists for and the one no "did it throw" test can see. |
