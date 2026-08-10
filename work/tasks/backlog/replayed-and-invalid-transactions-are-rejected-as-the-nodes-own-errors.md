---
title: A replayed or invalid transaction is REJECTED, and the refusal reaches the caller as the node's own error
slug: replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors
spec: revm-engine-behind-runtx
blockedBy: [fees-refunds-and-effective-gas-price-come-from-the-engine, stop-forwarding-revms-validation-error-text-as-eth-call-return-data]
covers: [5]
---

## What to build

A real node rejects a replay. A transaction claiming a nonce the sender has already used, or one whose sender cannot afford it, must FAIL on the revm path exactly as it fails on `@ethereumjs/vm`, and the failure must reach the caller as the node's own JSON-RPC error rather than as a wasm-shaped string. This is story 5, and it closes story 10 by proving from the outside what the previous tasks arranged from the inside.

Cover, on both engines, with the same assertion: a replayed nonce, a nonce far in the future, a sender who cannot afford `value + gas * price`, and a transaction whose gas limit is below its intrinsic gas. For each, assert that it FAILED, that the failure names the right cause, and that state is UNCHANGED afterwards, which is the part a "did it throw" test misses and the part that matters, because a rejected transaction that half-committed is worse than one that succeeded wrongly.

The error surface is a deliberate design point, not incidental. The node already has an error vocabulary and an honest-edge convention: a refusal says what happened and what to do about it. A validation failure from the engine must be translated into that vocabulary, and the engine's own message may be carried inside it, but it must not leak out where a client expects something else. There is a live instance of exactly that mistake to avoid, and this task is deliberately BLOCKED on its resolution rather than merely told to coordinate: `the rejectionMessage JSDoc in packages/embedded-eth-node/src/revm.ts (the note formerly at work/notes/observations/revm-validation-errors-surface-their-message-as-eth-call-return-data.md was DISCHARGED when that divergence was fixed)` records revm's validation text arriving at an `eth_call` caller as return data, which a viem client would try to decode as a contract's revert reason. `stop-forwarding-revms-validation-error-text-as-eth-call-return-data` decides how an engine's validation error is surfaced, and this task must FOLLOW that decision on the transaction path rather than invent a second answer. Two paths surfacing the same class of engine error two different ways is the drift the block exists to prevent.

Also assert the mirror of story 10 from the outside: a transaction that would be accepted without a nonce check is rejected WITH one, on the path a consumer actually uses, so the guarantee is not merely a code-reading exercise. Against an on-chain nonce of 5, a transaction claiming nonce 99 succeeds without the check and is rejected with a too-high-nonce error with it; that asymmetry is what the test should pin.

## Acceptance criteria

- [ ] On both engines: a replayed nonce, a far-future nonce, an unaffordable transaction and one whose gas limit is below intrinsic gas are all REJECTED, with the same outcome per case.
- [ ] After each rejection, state is unchanged (balances, nonces and storage), asserted through the node's public surface.
- [ ] Each rejection reaches the caller as the node's own error, in its existing vocabulary, naming the cause; no wasm-shaped message leaks into a field where a client expects something else.
- [ ] The nonce-check guarantee is asserted from OUTSIDE, through the node's public transaction path, not by reading the code.
- [ ] A rejected transaction does not appear in a block, produces no receipt, and does not advance `cumulativeGasUsed`.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- `fees-refunds-and-effective-gas-price-come-from-the-engine` — affordability rejection depends on fee arithmetic being settled, and both tasks own the same files.
- `stop-forwarding-revms-validation-error-text-as-eth-call-return-data` — it decides how an engine's validation error reaches a caller; this task applies that decision to the transaction path and must not invent a second answer. (If that task is dropped rather than built, this dependency must be removed deliberately and the decision made here instead.)

## Prompt

> Goal: prove the revm path refuses what a real node refuses, leaves nothing behind when it does, and says so in this node's own words.
>
> FIRST, check this task against current reality: it was written on 2026-08-09 and may have DRIFTED. Read what `stop-forwarding-revms-validation-error-text-as-eth-call-return-data` actually decided and follow it; if it was dropped rather than built, that decision is now yours to make here and to record.
>
> Read the node's existing error vocabulary and its honest-edge convention, the engine seam's transaction result and how a validation failure travels through it, and `the rejectionMessage JSDoc in packages/embedded-eth-node/src/revm.ts (the note formerly at work/notes/observations/revm-validation-errors-surface-their-message-as-eth-call-return-data.md was DISCHARGED when that divergence was fixed)`, which records the exact mistake to avoid: an engine's internal error text arriving where a client expects a contract's answer.
>
> ASSERT THE STATE, NOT ONLY THE THROW. "It failed" is the weakest half of this. The valuable half is that nothing moved: no balance, no nonce, no slot, no receipt, no block entry. A half-committed rejection is the worst outcome available on this path and only a state assertion catches it.
>
> Hold both engines to the SAME statement per case rather than to each other. Two engines can agree on an answer neither should have given; the repo's value-bearing conformance step exists because of exactly that, and it is a good model for the shape of these assertions.
>
> Done means: four invalid transactions, refused identically on both engines, with the node's own error and with state untouched.
