# What a `SELFDESTRUCT` leaves behind, measured in THIS repo

Run: `node docs/spikes/revm-write-callbacks-reproduce-the-post-state/probe-post-state.mjs` (after `pnpm build`, which `pnpm install` already does).
Taken 2026-08-10, Node 24, `revm-wasm@0.3.1` and `@ethereumjs/*@10.1.2` as installed in `packages/embedded-eth-node`, hardfork Cancun. The probe exits non-zero if any of its own checks fail, so a stale number here is a red run rather than a wrong document.

These figures back the 2026-08-10 amendment to [`docs/adr/0007-we-override-simplestatemanagers-no-op-clearstorage.md`](../../adr/0007-we-override-simplestatemanagers-no-op-clearstorage.md).

## The transaction

One transaction, sent to three differently-configured nodes. It is a CREATION whose init code writes a storage slot and then destroys the contract:

```
PUSH1 2a, PUSH1 00, SSTORE          slot 0 = 42
PUSH20 <0x…4444>, SELFDESTRUCT
```

It carries 1000 wei and deploys no code, so the only thing left to look at is the account, its balance, and the slot it wrote. It destroys itself in the transaction that CREATED it because EIP-6780 (Cancun) removes nothing otherwise — a `SELFDESTRUCT` on any older contract only moves its balance.

Everything below is read through the node's public surface (`eth_getCode`, `eth_getBalance`, `eth_getStorageAt`, `dumpState`), never through the state manager.

## 1. The divergence, before the fix

| configuration | code | balance | beneficiary | **slot 0** | storage in `dumpState` |
| --- | --- | --- | --- | --- | --- |
| `'trie'` / `@ethereumjs/vm` | `0x` | 0 | 1000 | **`0x…00`** | n/a (trie mode dumps no storage) |
| `'none'` / `@ethereumjs/vm` | `0x` | 0 | 1000 | **`0x…2a`** | **yes** |
| `'none'` / `revm-wasm` | `0x` | 0 | 1000 | **`0x…00`** | no |

All three agree that the account is gone (no code, no balance, absent from `dumpState`'s accounts) and that the beneficiary was paid. They disagree about its STORAGE, and the odd one out is the DEFAULT engine in `'none'` mode: a slot belonging to a contract that no longer exists still reads `42`, and `dumpState` still serialises it.

**Why.** `SimpleStateManager.deleteAccount` sets the account key to `undefined` and never touches storage — it keys storage in one flat `${address}_${slot}` map with no per-account index, so there is nothing cheap for it to clear. `@ethereumjs/evm`'s journal calls exactly that for both a `SELFDESTRUCT` and an EIP-161 empty-account clearing (`journal.js`), and `runTx` calls the journal (`runTx.js`, the `sortedSelfdestructs` loop). Nothing in the chain clears storage.

`MerkleStateManager` needs no equivalent line: deleting the account removes it from the trie and its storage trie goes with it, which is why the `'trie'` row is right for free. `revm-wasm` hands its host `clearStorage` and then `removeAccount` — its own commit semantics, already applied before the host is called — which is why the revm row is right too.

So the engine that disagreed with a trie was `@ethereumjs/vm` in `'none'` mode, not revm.

## 2. After the fix

`OverlayStorageStateManager.deleteAccount` (`packages/embedded-eth-node/src/state-manager.ts`) now clears the account's storage as well, which the per-account overlay layout of [ADR 0009](../../adr/0009-none-mode-storage-is-per-account-with-per-checkpoint-overlays.md) makes O(1) — one `delete` plus a tombstone on the TOP overlay, so it is revert-safe beside the account tombstone the base class writes.

| configuration | **slot 0** | storage in `dumpState` |
| --- | --- | --- |
| `'trie'` / `@ethereumjs/vm` | `0x…00` | n/a |
| `'none'` / `@ethereumjs/vm` | `0x…00` | no |
| `'none'` / `revm-wasm` | `0x…00` | no |

The probe's final check is that the three rows AGREE, not merely that each is plausible.

## 3. What this cost the default engine

`stateMode:'none'` on `@ethereumjs/vm` is the only configuration whose behaviour changed, and only for accounts that were DELETED: a destroyed contract's slots now read zero instead of their last value, and `dumpState` (hence IndexedDB persistence) no longer carries them. Nothing else moved — the account tombstone, the code map and every non-deleted account are untouched, and `'trie'` mode was already doing this.

## 4. Where the rest of the shapes are measured

The five state shapes this task is about — a creation, a nested creation, storage written through nested call frames, an account emptied to nothing, and a selfdestruct in both EIP-6780 halves — are diffed engine-against-engine on every run of the suite, not here: `packages/embedded-eth-node/test/helpers/post-state.ts` (the battery), `test/post-state-expected.ts` (the absolute numbers) and `test/revm-post-state.spec.ts` (the assertions). This document covers only the one shape where the two engines DISAGREED and a decision had to be taken.

Two results from that battery are worth repeating here, because both look like bugs and neither is:

- **the zero-tip coinbase vanishes.** Every transaction in the battery pays no priority fee, so the block's beneficiary is credited nothing, ends each transaction touched-and-empty, and is deleted under EIP-161 — on `@ethereumjs/vm` exactly as on revm.
- **`dumpState`'s key ORDER differs between the engines, on identical state.** Key order is insertion order, which is each engine's write order: revm hands its account changes over sorted by address, `@ethereumjs/vm` writes them in touch order. Measured on the battery's nested creation, which creates two accounts in one transaction:

  ```
  reference: … 0x5fbdb2…aa3, 0xe7f172…512, 0xcafac3…52c, …
  underTest: … 0x5fbdb2…aa3, 0xcafac3…52c, 0xe7f172…512, …
  ```

  A byte comparison of two CORRECT dumps therefore fails as soon as one transaction creates two accounts, which is why the battery compares them structurally (same accounts, same code, same slots, same values).
