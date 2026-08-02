---
title: Surface the EIP-3607 divergence on the revm engine, and ask upstream for the opt-out
slug: eth-call-from-a-contract-address-eip-3607
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
reason: superseded by revm-wasm-upgrade-honest-block-environment. revm-wasm 0.3.0 shipped `disableEip3607`, so this is no longer a divergence to surface and document but a flag to set, folded into the single upgrade task alongside the base-fee, balance and prevRandao switches. Verified on 0.3.0: with the flag, a call from a contract address returns the same status, gas and data as the same call from an EOA.
---

## What to build

> **VERIFIED 2026-08-01, so this is no longer an investigation.** Probed directly against `revm-wasm@0.2.0` (revm 42.0.1, abi 1, outcome v3) with a `MemoryStore`: a `call()` from an EOA returns `success`, 21018 gas, the expected return data; the SAME call with `from` set to an account holding code returns `status: 'validation-error'` carrying `Transaction(RejectCallerWithCode)` and burns no gas. On the other side, `@ethereumjs/evm`'s `runCall` performs NO such check (EIP-3607 is enforced in `@ethereumjs/vm`'s `runTx`, at `runTx.js:528`, with the message `invalid sender address, address is not EOA (EIP-3607)`). So the divergence is real and one-directional: an `eth_call` from a contract address works on the default engine and fails on the revm engine.
>
> That layering is also the argument to make upstream: ethereumjs puts the check on `runTx` and NOT on `runCall`, because EIP-3607 is a transaction-VALIDITY rule, not an execution rule. A simulation should not be bound by it. revm itself agrees in principle, exposing `disable_eip3607` on `CfgEnv`; `revm-wasm` simply does not surface it, in `0.1.0` or `0.2.0`.

Make the two engines agree, or fail loudly, and ask upstream for the flag that would let them agree properly.

EIP-3607 rejects a transaction whose sender has code. revm enforces it (`RejectCallerWithCode` is in the wasm's error set) and `revm-wasm` exposes no flag to disable it, including in `0.2.0`, which added `disableBaseFee`, `disableBalanceCheck` and `disableBlockGasLimit` but nothing for this. The Gate-2 review of `revm-engine-subpath` flagged that this looks unexamined: an `eth_call` with `from` set to a CONTRACT address may fail on the revm engine while working on `@ethereumjs/evm`.

This matters more than it sounds, because simulating a call FROM a contract is ordinary practice, not an edge case: smart-account / ERC-4337 flows, multicall aggregators, and any UI that previews "what would this contract see if it called that one". Real clients deliberately relax EIP-3607 for `eth_call` for exactly this reason.

Two things, one now and one when upstream lands:

**Now.** The revm engine must not hand back an opaque validation error for this. Surface it as a real, specific failure that names EIP-3607, names the engine, and says the default engine can serve the call, and document it in the README's engine caveats beside the block-environment notes. A consumer simulating a smart-account or multicall flow must be told which engine limitation they hit, not left comparing two nodes.

**When upstream lands.** File the `revm-wasm` request for a `disableEip3607` option on `ExecuteOptions`, the same shape and the same argument as the three that landed in `0.2.0`. When it exists, set it for reads and delete the refusal, because then the engines simply agree.

Do NOT paper over it by making the default engine reject too. Matching downward would break a case that works today, on the default path, for every existing consumer.

## Acceptance criteria

- [ ] A test pins the behaviour of `eth_call` with a contract `from` on BOTH engines, so this can never regress silently again in either direction.
- [ ] On the revm engine the failure names EIP-3607, names the engine, and points at the default engine as the way to serve the call. Not an opaque `validation-error`.
- [ ] The README's engine section documents it beside the existing caveats.
- [ ] The upstream request for a `disableEip3607` option is filed and linked from the task's done record.
- [ ] If that option has ALREADY shipped by the time this is built, use it instead and skip the refusal: the engines then agree, which is the outcome this task actually wants.
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
> THE FACTS ARE ESTABLISHED, so do not re-derive them: `revm-wasm@0.2.0` returns `validation-error` / `Transaction(RejectCallerWithCode)` for a `call()` from an account with code, while `@ethereumjs/evm`'s `runCall` never checks (ethereumjs enforces EIP-3607 in `runTx` instead, `runTx.js:528`). Re-confirm cheaply if you like, but the work is the refusal, the docs and the upstream request, not the discovery.
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
