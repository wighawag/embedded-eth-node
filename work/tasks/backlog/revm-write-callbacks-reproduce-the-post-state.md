---
title: The write callbacks reproduce ethereumjs's post-state exactly, including creation, storage and selfdestruct
slug: revm-write-callbacks-reproduce-the-post-state
spec: revm-engine-behind-runtx
blockedBy: [revm-executes-the-first-transaction-with-commit]
covers: [2]
---

## What to build

The first transaction proved the path; this proves the STATE. After a revm-executed transaction, the node's state must equal what `@ethereumjs/vm` would have left behind: balances, nonces, code and storage, for every account the transaction touched. That is story 2, and it is the half of the correctness bar the cross-backend gas gate structurally cannot see, because gas equality says nothing about balances.

Complete the write side of the state store for every case the binding's commit semantics produce, not just the ones a transfer produces. The binding hands the host a per-account change set with flags for selfdestructed, touched, created, code-changed and deleted, plus the changed slots, and it applies its own commit semantics BEFORE calling the host: a selfdestruct and an EIP-161 empty-account clearing both arrive as a storage clear followed by an account removal, and a created account arrives with its storage cleared FIRST so it cannot inherit storage from a previous life at its address. The host does not re-derive any of that. Implement it as the binding describes rather than reasoning about what a selfdestruct ought to do.

Storage clearing is cheap now and was not always: `stateMode:'none'` storage is per-account with per-checkpoint overlays (ADR 0009), so clearing one account is O(that account) and the binding's own requirement is met without translating between two models. Do not reintroduce anything that walks all of storage.

Cover the shapes a transfer did not: a contract CREATION (which exercises clear-then-write in one frame), storage written through nested call frames, code deployed, an account emptied to nothing, and a SELFDESTRUCT. Diff post-state against `@ethereumjs/vm` for each, through the node's own surface rather than by reaching into the state manager, so the assertion is about what a consumer can observe.

Expect the coinbase to VANISH from post-state when the priority fee is zero: it stays touched-and-empty and is deleted under EIP-161. `@ethereumjs/vm` does the same. It merely looks alarming in a diff, and it is the case most likely to be mistaken for a bug.

## Acceptance criteria

- [ ] After a revm-executed transaction, balances, nonces, code and storage match `@ethereumjs/vm`'s post-state exactly, asserted through the node's public surface, for: a creation, storage written through nested frames, code deployment, an emptied account, and a selfdestruct.
- [ ] The write callbacks implement the binding's commit semantics as documented (clear-then-remove for selfdestruct and EIP-161 clearing, clear-first for a created account), without re-deriving them.
- [ ] Storage clearing remains O(that account); nothing walks total storage.
- [ ] The zero-priority-fee coinbase disappearing under EIP-161 is asserted as EXPECTED behaviour on both engines, with a comment at the assertion saying why, so a future reader does not "fix" it.
- [ ] Writes remain proportional to what the transaction touched: no bulk sync, no whole-state rebuild after a write.
- [ ] `dumpState` output after a revm transaction is byte-identical to `dumpState` after the same transaction on the default engine.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- `revm-executes-the-first-transaction-with-commit` — the write path and the outcome mapping exist there; this completes them. It also owns the same files, so these are deliberately serialized.

## Prompt

> Goal: prove that a chain built on revm is the SAME chain as one built on `@ethereumjs/vm`, by diffing post-state rather than gas.
>
> FIRST, check this task against current reality: it was written on 2026-08-09 and may have DRIFTED. Confirm which write callbacks the previous task already implemented and which still throw, and confirm the storage layout is still per-account with per-checkpoint overlays. Complete what is there rather than restarting it.
>
> Read the binding's documentation of its write callbacks and of the account-change section of its outcome, `docs/adr/0009-...` for what storage is now (per-account maps with per-checkpoint overlays; clearing an account is O(1)), and the state store's write methods as the previous task left them.
>
> THE COMMIT SEMANTICS ARE ALREADY APPLIED when the host is called. Selfdestruct and EIP-161 clearing arrive as clear-then-remove; a created account arrives cleared first. Implement what the binding says it does; do not re-derive EVM rules on the host side, because a host that disagrees with the engine about what a selfdestruct means will produce a plausible wrong chain.
>
> Diff through the node's PUBLIC surface. An assertion that reaches into the state manager tests your own bookkeeping; an assertion that reads `eth_getBalance`, `eth_getCode`, `eth_getStorageAt` and `dumpState` tests what a consumer sees.
>
> The disappearing zero-tip coinbase is CORRECT on both engines. Assert it and say so at the assertion, or the next person will file it as a bug.
>
> Done means: five state-shaped transactions, each leaving state a diff cannot tell apart from ethereumjs's.
