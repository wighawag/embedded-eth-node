---
title: Establish what eth_call from a CONTRACT address does on each engine (EIP-3607)
slug: eth-call-from-a-contract-address-eip-3607
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

Find out, then make the two engines agree or document why they cannot.

EIP-3607 rejects a transaction whose sender has code. revm enforces it (`RejectCallerWithCode` is in the wasm's error set) and `revm-wasm` exposes no flag to disable it, including in `0.2.0`, which added `disableBaseFee`, `disableBalanceCheck` and `disableBlockGasLimit` but nothing for this. The Gate-2 review of `revm-engine-subpath` flagged that this looks unexamined: an `eth_call` with `from` set to a CONTRACT address may fail on the revm engine while working on `@ethereumjs/evm`.

This matters more than it sounds, because simulating a call FROM a contract is ordinary practice, not an edge case: smart-account / ERC-4337 flows, multicall aggregators, and any UI that previews "what would this contract see if it called that one". Real clients deliberately relax EIP-3607 for `eth_call` for exactly this reason.

Start by establishing the facts, because nobody has: does an `eth_call` with a contract `from` actually fail on our revm engine today, and what does `@ethereumjs/evm` do with the same call? The answer decides the work, and it may be that both engines already agree, in which case this closes with a test that pins it.

If they diverge, the options are, in preference order: an upstream request to `revm-wasm` for a `disableEip3607` flag (the same shape as the three that landed in 0.2.0, and the same argument: it is a transaction-validity rule, not an execution rule, so a simulation should not be bound by it); or refusing the call loudly on the revm engine so a consumer is told rather than silently given a different answer; or documenting it in the README's engine caveats beside the block-environment notes.

Do NOT paper over it by making the default engine reject too. Matching downward would break a case that works today, on the default path, for every existing consumer.

## Acceptance criteria

- [ ] The actual behaviour of `eth_call` with a contract `from` is established for BOTH engines, and recorded (a test that pins it, not prose).
- [ ] If they agree: a test asserts it, so a future engine change cannot silently break it, and this task closes.
- [ ] If they diverge: the divergence is either removed, or surfaced LOUDLY on the revm path with an error naming the reason, and documented in the README's engine section beside the existing caveats. It is never left silent.
- [ ] The default `@ethereumjs/evm` path's behaviour is UNCHANGED either way.
- [ ] If an upstream flag is the right answer, the request is filed and linked from the note or ADR that records the decision.

## Blocked by

- None. Independent of the `0.2.0` upgrade, though both touch the same engine file, so serialise them if they run close together.

## Prompt

> Goal: establish, then fix or honestly document, what an `eth_call` from a contract address does on each engine.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): read `src/revm.ts` and the decisions record `work/notes/observations/decisions-revm-engine-subpath-2026-08-01.md`. If a later change already handled EIP-3607, close this instead of redoing it.
>
> Read `CONTEXT.md` for *honest edge* and *conformance differential*. The convention that governs this task: a thing the node cannot do fails LOUDLY with a real error; it never returns a plausible-looking different answer.
>
> INVESTIGATE BEFORE YOU BUILD. The premise is a review finding, not a measurement: nobody has run the case. Write the smallest probe first (deploy any contract, then `eth_call` with `from` set to its address, on the default engine and on the revm engine) and let the result choose the branch. If both engines already agree, the deliverable is one test and a closed task, and that is a GOOD outcome, not a failed one.
>
> WHY THE CASE IS REAL: simulating a call from a contract is how smart-account and multicall UIs preview behaviour. This is not an exotic corner, which is why upstream clients relax EIP-3607 for `eth_call` specifically. Weight it accordingly, but confirm before acting.
>
> Note the shape of the fix that is NOT allowed: making the default engine reject the call as well, to force agreement. That would break working behaviour for every existing consumer of the default path in order to match a limitation of an optional one.
>
> If you conclude an upstream flag is right, the precedent is direct and recent: `revm-wasm@0.2.0` added `disableBaseFee` / `disableBalanceCheck` / `disableBlockGasLimit` after this repo asked for them, with the reasoning that a validity rule should not bind a simulation. The same argument applies verbatim to EIP-3607.
>
> Done means: nobody can get a different answer from the two engines on this case without having been told.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
