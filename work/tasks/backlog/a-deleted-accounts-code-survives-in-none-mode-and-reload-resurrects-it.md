---
title: A deleted account keeps its code in 'none' mode, and a dumpState reload resurrects the destroyed address
slug: a-deleted-accounts-code-survives-in-none-mode-and-reload-resurrects-it
spec: revm-engine-behind-runtx
blockedBy: []
covers: [13]
---

## What to build

`revm-write-callbacks-reproduce-the-post-state` aligned the STORAGE half of account deletion across the two engines and both state modes. It deliberately left the CODE half, because it has no cross-engine consequence: both engines are stale in exactly the same way, so the post-state differential stays green either way. That makes it invisible to the differential and therefore worth its own task rather than a note.

In `stateMode:'none'`, deleting an account (a `SELFDESTRUCT`, or an EIP-161 empty-account clearing) leaves its CODE behind: `SimpleStateManager.deleteAccount` never removes it, and the revm host's `removeAccount` deliberately matches that. In `stateMode:'trie'` the account is gone from the trie and `eth_getCode` answers `0x`. So the same destroyed contract answers its bytes in one mode and nothing in the other.

**The consequence that makes this more than an inconsistency.** A `dumpState` taken after a selfdestruct carries a code entry with NO account, and `loadState`'s `putCode` CREATES an account for any code entry it finds. So a dump-and-reload round trip RESURRECTS the destroyed address as a codeful, zero-balance, zero-nonce account that did not exist in the state that was dumped. Story 13 asks that persistence behave as before, and a round trip that does not round-trip is the sharpest form of that failing.

Decide and implement the honest resolution: either deletion removes the code in `'none'` mode too (aligning it with `'trie'`, as the storage half was aligned), or `dumpState` stops emitting code for an address with no account, or `loadState` stops minting accounts from bare code entries. Weigh them rather than taking the first: the third is the only one that also protects a hand-written or externally-produced dump.

**A second, smaller thing in the same area.** The selfdestruct probe in `test/helpers/slim-node-checks.ts` (shape 8) asserts the destroyed contract's code is `0x` and comments that this shows it was destroyed rather than merely emptied. Its fixture dies in its constructor and never deploys code, so that assertion cannot fail and measures nothing about code removal, which per the above does not even happen in `'none'` mode. Re-word or re-fixture it so a reader cannot mistake it for coverage of code deletion.

## Acceptance criteria

- [ ] A `dumpState` / `loadState` round trip taken after a `SELFDESTRUCT` produces the SAME observable state it started from: the destroyed address is not resurrected as a codeful account. Asserted on both engines and both state modes.
- [ ] `eth_getCode` on a destroyed contract answers consistently across `stateMode:'none'` and `stateMode:'trie'`, or the remaining difference is deliberate and stated where a consumer meets it.
- [ ] The chosen resolution is recorded with the alternatives that were weighed, per this repo's decision-recording convention. If it changes `'none'` mode's observable behaviour, ADR 0007 takes a DATED AMENDMENT rather than an edit.
- [ ] The shape 8 selfdestruct probe no longer reads as coverage of code deletion when it is not, either by re-wording it or by giving it a fixture that actually deploys code first.
- [ ] The post-state differential stays green on both engines and both state modes.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] A changeset if consumer-visible behaviour changes, which any of the three resolutions would.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: a destroyed account stays destroyed, including across a `dumpState` / `loadState` round trip, and the two state modes stop disagreeing about whether its code is still there.
>
> FIRST, check this task against current reality: it was written on 2026-08-10 and may have DRIFTED. Confirm the round-trip resurrection actually reproduces before changing anything; write the failing assertion first, since this is precisely the kind of claim that is easy to state and easy to get subtly wrong.
>
> Read the 2026-08-10 amendment to `docs/adr/0007-we-override-simplestatemanagers-no-op-clearstorage.md`, which aligned the STORAGE half and explains why `'none'` mode overrides the upstream no-op at all, and `revm-state-store.ts`'s `removeAccount`, which deliberately mirrors `SimpleStateManager.deleteAccount`.
>
> This has NO cross-engine consequence: both engines are stale identically, so the post-state differential cannot catch it and will stay green whatever you do. Do not rely on that differential to tell you this works; assert the round trip directly.
>
> Weigh the three resolutions rather than taking the first that passes. Removing the code on delete aligns the modes; making `dumpState` omit code for an absent account fixes the artifact; making `loadState` stop minting accounts from bare code entries is the only one that also protects a dump this node did not produce.
>
> Compare dump output STRUCTURALLY, never byte for byte: key order follows write order, and revm's account changes arrive sorted by address while ethereumjs writes in touch order.
