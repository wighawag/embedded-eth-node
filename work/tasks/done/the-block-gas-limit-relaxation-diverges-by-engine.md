---
title: A transaction whose gas limit exceeds the block's is rejected on revm and accepted on the default engine
slug: the-block-gas-limit-relaxation-diverges-by-engine
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`revm-executes-the-first-transaction-with-commit` introduced a real, user-visible cross-engine divergence, and it is the exact shape the seam task predicted one task earlier. The node passes `skipBlockGasLimitValidation` to `runTx`, so on the default engine a transaction whose gas limit exceeds the block gas limit is ACCEPTED and mined. revm has no equivalent on a committing path: it expresses that relaxation as a simulation switch and REFUSES to combine any simulation switch with committing, so the same transaction is rejected with a caller-gas-limit error. Same node, same transaction, two answers depending on which engine is installed.

This is the class of defect the whole spec exists to remove ("a node running two different EVMs has two chances to disagree with itself"), so it cannot rest as an accepted quirk. Decide which behaviour is CORRECT and make both engines do it. The options, and they are not symmetric:

**THE RESOLUTION IS DECIDED (maintainer, 2026-08-10): drop the skip flag, and let CONFIGURATION buy the permissiveness back.** Remove `skipBlockGasLimitValidation` so both engines enforce the rule a real node enforces, and tell a consumer who wants enormous gas limits to raise `blockGasLimit`, which `NodeOptions` already exposes (default 30,000,000). The permissiveness stops being a hidden per-transaction exemption that one engine cannot honour and becomes a visible, configured property of the block, which BOTH engines then honour by construction: revm rejects against the block gas limit it was given, `runTx` rejects against the same one, and they are given the same one.

It is also strictly more honest than the flag. Today a transaction is accepted against a limit the block does not have. Afterwards, if the block says its limit is huge, the limit really is huge, and `GASLIMIT` reports it to a contract truthfully.

Three consequences to handle rather than discover:

- **The default does not move.** `blockGasLimit` stays 30,000,000, so nothing changes for a consumer who never asked for more. What changes is that a transaction asking for MORE than the configured limit is refused instead of mined.
- **The read budget follows the block gas limit**, so a consumer who sets it enormous also enlarges the default `eth_call` budget, and a runaway contract then burns far more wall clock before running out of gas. Decide explicitly whether that link should be broken (a separately-bounded read budget) or documented as the cost of the configuration; do not leave it to be discovered by someone whose browser tab locks up.
- **The refusal must be legible**, naming the limit that was exceeded and `blockGasLimit` as the knob, in this repo's honest-edge voice, on BOTH engines.

~~**Stop relaxing it.**~~ (Superseded by the decision above; kept because the cost it names is still what you must check.) Dropping `skipBlockGasLimitValidation` from the default engine, so both engines reject a transaction whose gas limit exceeds the block's, which is also what a real node does. This is the honest direction, and the cost has to be checked rather than assumed: the flag was passed for a reason (the node mines one block per transaction, and the node's own default read budget is the block gas limit), so find out what actually breaks. The conformance battery's reference `runTx` passes the same flag, so it will not tell you.

~~**Or keep relaxing it and make revm agree.**~~ REJECTED. Not available on a committing path today, by the binding's own refusal, so this reduces to raising the mined block's gas limit to accommodate the transaction, which changes what a block MEANS and would show up in `eth_getBlockByNumber`. Say so plainly if you take it.

~~**Or refuse the configuration.**~~ Subsumed by the decision: the refusal IS the behaviour, and configuration is what lifts it. If neither engine can be made to match, the honest edge is that the node REFUSES a transaction whose gas limit exceeds the block's, identically on both engines, with an error naming the reason. That is a behaviour change on the default engine and needs a changeset.

Whichever is chosen, the outcome is that the two engines answer the same question the same way, and a test asserts it on BOTH rather than describing it in a comment.

## Acceptance criteria

- [ ] `skipBlockGasLimitValidation` is gone, and a transaction whose gas limit exceeds the block gas limit is REFUSED identically on both engines, asserted on both.
- [ ] Raising `blockGasLimit` restores the old permissiveness end to end: a transaction with a gas limit above 30,000,000 is mined on a node configured for it, on both engines, and `GASLIMIT` read through a contract reports the configured value.
- [ ] The refusal names the limit that was exceeded and `blockGasLimit` as the knob, on both engines.
- [ ] The link between the block gas limit and the default read budget is decided explicitly (broken or documented) and the reasoning recorded at the code site.
- [ ] The conformance battery covers the case, so it cannot regress silently. Note the battery's own reference passes the same skip flag, so the assertion must be about the NODE's answer, not the reference's.
- [ ] If the resolution changes what the default engine accepts, there is a changeset saying so.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None.

## Prompt

> Goal: one answer per question. Today the node accepts an over-limit transaction on one engine and rejects it on the other, which is precisely the two-EVMs-disagreeing failure this spec exists to remove.
>
> FIRST, check this task against current reality: it was written on 2026-08-10 and may have DRIFTED. Reproduce the divergence before deciding anything, on both engines, and confirm the mechanism is what this task says it is.
>
> Read where the default engine passes the two skip flags and the comment block that explains why they live there (it predicted this exact divergence: a neutral request field would have been a promise the next engine cannot keep, because revm refuses to combine that relaxation with committing). Read the binding's simulation-flag refusal for the other half.
>
> BEWARE THE REFERENCE. The conformance battery's own `runTx` passes the same skip flag, so a battery that diffs node against reference cannot see this. Assert on the node's answer per engine.
>
> THE DIRECTION IS DECIDED: drop the flag, and let `blockGasLimit` (already in `NodeOptions`) buy the permissiveness back. Do not re-open it. What is left to you is doing it well: the refusal must say which limit was exceeded and which knob raises it, the configured-high-limit path must be proven end to end on BOTH engines, and the block-gas-limit-to-read-budget link must be decided rather than inherited.
>
> Do NOT reach for the shape where the node quietly widens the block it hands the engine to fit the transaction. That would make `GASLIMIT` lie to a contract, which is the exact class of dishonesty the block-environment work removed.

## Recovery handoff (2026-08-10, conductor)

**The `work/task-the-block-gas-limit-relaxation-diverges-by-engine` branch is GOOD. CONTINUE from its tip; do NOT restart and do NOT redo the work already on it.** Gate 1 (`pnpm format:check && pnpm build && pnpm test`) passed green on that branch, reference gas was exact, and acceptance criterion 4 was genuinely satisfied: `DEFAULT_READ_BUDGET` is a node-wide constant in `src/node.ts`, deliberately decided apart from `blockGasLimit`, with the reasoning recorded at its `evmCall` use site.

Gate 2 blocked on ONE thing, and it is the only thing to fix:

The `disableBlockGasLimit` stanza of the simulation-switch comment in `packages/embedded-eth-node/src/revm.ts` (in the read path, around the `disableBaseFee` / `disableBlockGasLimit` / `disableEip3607` block) still opens with `the node's default read budget IS the block gas limit`. That sentence was true before this branch and is false after it, because this same branch is what decided the two apart. On a node whose `blockGasLimit` has been raised (the very configuration this task introduces to buy back the relaxation) the 30,000,000 read budget is now BELOW the block limit, so the stated reason no longer holds and a later maintainer could reasonably conclude the switch is removable.

**The switch must stay.** Re-state its rationale so it remains true on every node, rather than deleting it: the switch is required because a read may be given a gas budget equal to the block gas limit, either from `DEFAULT_READ_BUDGET` on a default node (where the two numbers coincide at 30,000,000) or from an explicit `gas` argument on any node, and revm charges intrinsic gas out of that same limit while `@ethereumjs/evm`'s `runCall` charges none, so the effective requirement is `gas + intrinsic`, which exceeds the block limit by exactly `intrinsic` (`CallerGasLimitMoreThanBlock`).

Fix that comment, change nothing else, and leave the rest of the branch as it stands. The `work/notes/observations/adr-0008-calls-the-read-budget-the-block-gas-limit.md` note you filed is correct and should REMAIN as an open signal: it tracks the same stale phrasing in ADR 0008, which is a separate doc surface this task does not own.
