# Host callbacks, cold accesses and the two gas fields — measured in THIS repo

Run: `node docs/spikes/revm-executes-the-first-transaction-with-commit/probe-host-callbacks.mjs`
Taken 2026-08-10, Node 24, `revm-wasm@0.3.1` as installed in `packages/embedded-eth-node`, spec `CANCUN`. The probe exits non-zero if any of its own checks fail, so a stale number here is a red run rather than a wrong document.

These figures back [`docs/adr/0010-revm-reads-and-writes-through-host-callbacks-the-node-keeps-owning-state.md`](../../adr/0010-revm-reads-and-writes-through-host-callbacks-the-node-keeps-owning-state.md). They exist because the affordability argument for keeping state on the JS side arrived as three numbers measured on the ENGINE side, with nothing in this repo able to reproduce them. They now reproduce here, exactly, and one clause of the original claim turns out to be looser than it read (§1).

## 1. One host callback per COLD state access

Runtime code that `SLOAD`s 2,000 times, either the same slot every time or a different slot each time, executed as a committing transaction against a store that counts every callback.

| loop | status | `gasUsed` | `getStorage` callbacks | `getAccount` | `getCode` |
| --- | --- | --- | --- | --- | --- |
| 2,000 × same slot | success | 283,003 | **1** | 3 | 2 |
| 2,000 × distinct slots | success | 4,283,003 | **2,000** | 3 | 2 |

The callback counts are the claim: revm's journal answers every WARM access inside wasm, so the boundary is crossed once per cold access and not once per opcode. Both gas figures match the ones the spec inherited from the engine side (283,003 and 4,283,003), so those numbers were right and are now this repo's own.

**The 4,000,000 difference is NOT purely the cold/warm delta, and the ADR's inherited wording said it was.** Written out:

- the same-slot loop pays cold ONCE too, so the SLOAD half of the difference is `(2000 - 1) × (2100 - 100)` = 3,998,000, not `2000 × 2000`;
- the remaining 2,000 gas is the LOOP: reading a varying slot needs `DUP1` (3 gas) where a fixed slot needs `PUSH0` (2), across 2,000 iterations.

The two sum to a round 4,000,000 at N = 2,000 by coincidence of this loop shape. The probe therefore asserts `(N-1) × (COLD − WARM) + N` rather than the round number, and the ADR states the callback COUNTS (1 versus 2,000) as the load-bearing measurement, with the gas as the independent witness that they track cold accesses.

## 2. EIP-2929 resets every transaction — the caveat that cuts the other way

The same distinct-slot contract, called by two transactions in a row against the same state:

| transaction | `gasUsed` | `getStorage` callbacks |
| --- | --- | --- |
| 1st | 4,283,003 | 2,000 |
| 2nd | 4,283,003 | 2,000 |

Warmth does not carry over. A game loop re-reading the same entities every tick re-pays every crossing every tick, where state living inside wasm would pay once. **Gas is identical either way** — the protocol charges cold access whatever the host does — so this is wall clock only.

## 3. The write side is proportional to what the transaction touched

A contract holding 1,000 storage slots, called by a transaction that writes exactly one (`SSTORE` slot 7):

| callback | count |
| --- | --- |
| `setStorage` | 1 (`00cc/0007`) |
| `setAccount` | 3 (sender: nonce + fee, coinbase: tip, callee: touched) |
| `clearStorage` | 0 |
| `removeAccount` | 0 |

No bulk sync, and nothing walks total storage. This is what the ADR means by writing back only the touched accounts and the changed slots.

## 4. The two gas fields, and which one a receipt takes

A transaction that clears a non-zero storage slot, i.e. one with a real refund:

| field | value |
| --- | --- |
| `totalGasSpent` | 26,004 |
| `gasRefunded` | 4,800 |
| `gasUsed` | 21,204 |
| `effectiveGasPrice` | 2,000,000,000 |

`gasUsed` = `totalGasSpent` − `gasRefunded`. A receipt reports the NET number, which is also what `@ethereumjs/vm`'s confusingly-named `totalGasSpent` already is (`runTx` subtracts the refund from it before returning). The READ path in `src/revm.ts` deliberately takes revm's `totalGasSpent` — a read has no refund and `eth_estimateGas` wants the gross figure — so copying that mapping onto the transaction path would put gas-before-refunds on every receipt. A value transfer has a zero refund and cannot detect it, which is why the case is measured here rather than left to the transfer.

Related, and NOT reproduced here: `work/notes/observations/revm-wasm-gasused-carries-the-eip-7623-floor.md` reported `gasUsed` carrying the post-Prague EIP-7623 calldata floor on pre-Prague specs in `revm-wasm@0.3.0`. On `0.3.1`, a 100-non-zero-byte transfer reports `gasUsed` == `totalGasSpent` == 22,600 on LONDON through CANCUN and only diverges on PRAGUE (25,000 versus 22,600), which is the floor doing its job at the fork that has it. So taking `gasUsed` on the transaction path is safe at every hardfork this engine admits. The observation was about the READ path's `call` and is left open for whoever re-measures that.

## 5. A plain transfer, for scale

| callback | count |
| --- | --- |
| `getAccount` | 3 |
| `getStorage` | 0 |
| `setAccount` | 3 |

Six crossings in total for the transaction this task's tracer bullet executes, at 21,000 gas.

## What the binding's commit order is, and why the store buffers code

Not a table, but measured with the same wrapper and load-bearing for `src/revm-state-store.ts`. A contract creation commits in this order:

```
clear_storage  <created address>
set_code       <code hash> <code>
set_account    <created address> (balance, nonce, the new code hash)
set_account    <sender>
```

`setCode` arrives BEFORE the `setAccount` that names the address the code belongs to, because revm keys code by HASH while this node keys it by ADDRESS. Nothing but the account change knows the address, so the store holds the code by hash for one callback and writes it in `setAccount`. `set_code` is also called for a contract that merely EXECUTED (its code hash unchanged), so the write is idempotent by content rather than gated on a "changed" flag.
