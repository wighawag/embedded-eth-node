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

**Stop relaxing it.** Drop `skipBlockGasLimitValidation` from the default engine, so both engines reject a transaction whose gas limit exceeds the block's, which is also what a real node does. This is the honest direction, and the cost has to be checked rather than assumed: the flag was passed for a reason (the node mines one block per transaction, and the node's own default read budget is the block gas limit), so find out what actually breaks. The conformance battery's reference `runTx` passes the same flag, so it will not tell you.

**Or keep relaxing it and make revm agree.** Not available on a committing path today, by the binding's own refusal, so this reduces to raising the mined block's gas limit to accommodate the transaction, which changes what a block MEANS and would show up in `eth_getBlockByNumber`. Say so plainly if you take it.

**Or refuse the configuration.** If neither engine can be made to match, the honest edge is that the node REFUSES a transaction whose gas limit exceeds the block's, identically on both engines, with an error naming the reason. That is a behaviour change on the default engine and needs a changeset.

Whichever is chosen, the outcome is that the two engines answer the same question the same way, and a test asserts it on BOTH rather than describing it in a comment.

## Acceptance criteria

- [ ] A transaction whose gas limit exceeds the block gas limit gets the SAME outcome on both engines, asserted on both.
- [ ] The chosen resolution is recorded where the relaxation lives, including what was checked to establish that removing it (or keeping it) is safe.
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
> Prefer the direction that makes the node MORE like a real node, and if you take it, establish what the relaxation was buying rather than assuming it was cargo. The node mines one block per transaction, which is probably why it is there.
