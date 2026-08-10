---
title: "'none' mode keeps a deleted account's CODE, on both engines"
date: 2026-08-10
status: open
---

Noticed while building `revm-write-callbacks-reproduce-the-post-state`. In `stateMode:'none'`, deleting an account (a `SELFDESTRUCT`, or an EIP-161 empty-account clearing) leaves its CODE in the code map: `SimpleStateManager.deleteAccount` never removes it, and the revm host's `removeAccount` (`packages/embedded-eth-node/src/revm-state-store.ts`) deliberately matches that. So `eth_getCode` on a destroyed contract still answers its bytes, and `dumpState` still carries them — where `stateMode:'trie'` answers `0x`, because the account is gone from the trie.

No cross-engine consequence (both engines are stale in exactly the same way, so the post-state differential in `test/revm-post-state.spec.ts` is green either way), which is why it was left alone: only the STORAGE half broke the two engines apart and was fixed, in the 2026-08-10 amendment to `docs/adr/0007-we-override-simplestatemanagers-no-op-clearstorage.md`. Two things a follow-up would want to weigh: a `dumpState` taken after a selfdestruct carries a code entry with no account, and `loadState`'s `putCode` CREATES an account for any code entry it finds — so a dump/reload round trip resurrects the destroyed address as a codeful, zero-balance, zero-nonce account.
