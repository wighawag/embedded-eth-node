---
title: The conformance differential covers TRANSACTIONS on revm, so a divergence fails the build
slug: the-conformance-differential-covers-transactions-on-revm
spec: revm-engine-behind-runtx
blockedBy: [eip-2930-access-lists-are-charged-and-warmed]
covers: [9]
---

## What to build

The acceptance bar for this whole spec is the conformance differential, and story 9 is delivered only for READS: the battery is engine-parameterised and runs against revm, but its transactions still execute on `@ethereumjs/vm` whatever engine is installed. Point it at transactions, so that any divergence between a revm-executed transaction and a `runTx` of the same transaction fails the build rather than being noticed later by a consumer.

The battery already runs the same signed transactions through the node and through a trie-backed `@ethereumjs/vm` reference, diffing receipts field by field plus post-state, and it already covers legacy, EIP-2930 and EIP-1559 transactions, a creation, a multi-log case and a revert. What changes is that with a revm engine installed those transactions now EXECUTE on revm, so the existing diff becomes a genuine cross-engine bar instead of a self-comparison. Confirm that is actually what happens rather than assuming it: a battery that quietly still runs transactions on ethereumjs would pass while proving nothing, which is the failure mode this task exists to prevent.

Add the negative cases the suite lacks and this spec makes reachable: a replayed nonce, insufficient funds, and a storage-clearing refund. Refunds are priced at the effective gas price, which a hand-rolled implementation gets wrong, so that case earns its place.

Mind the term. `CONTEXT.md` defines *conformance differential* and its entry now records that the battery uses TWO oracles: the trie reference for the receipt and post-state steps, and the node's own configured block plus an absolute succeed/fail statement for the block-environment and value-bearing steps. Transactions on revm belong to the first kind. If this task changes which oracle any step uses, `CONTEXT.md` must move with it in the same change.

## Acceptance criteria

- [ ] With a revm engine installed, the conformance battery's transactions EXECUTE on revm, asserted rather than assumed (the run reports which engine executed them, and the assertion fails if it is the default one).
- [ ] Receipts and post-state still diff clean against the trie-backed reference for every existing case: legacy, EIP-2930, EIP-1559, a creation, a multi-log transaction and a revert.
- [ ] Three negative cases are added and pass on both engines: a replayed nonce, insufficient funds, and a storage-clearing refund.
- [ ] Both conformance specs continue to assert their steps BY LABEL, so a step cannot silently stop running.
- [ ] `CONTEXT.md`'s *conformance differential* entry still describes the battery accurately, and is updated in this change if any step's oracle moved.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- `eip-2930-access-lists-are-charged-and-warmed` — the last of the behaviour tasks; the bar goes green once they are all in.

## Prompt

> Goal: make the repo's strongest correctness bar judge revm-executed TRANSACTIONS, so a divergence fails the build.
>
> FIRST, check this task against current reality: it was written on 2026-08-09 and may have DRIFTED. Confirm which of this spec's behaviour tasks actually landed and what they already assert, so the cases you add are the ones still missing rather than a second copy of coverage that now exists.
>
> Read `test/helpers/conformance.ts` (the battery, its steps and its two oracles), both conformance specs, and `CONTEXT.md`'s *conformance differential* entry.
>
> THE FAILURE MODE IS A VACUOUS PASS. If transactions quietly keep running on `@ethereumjs/vm` while the battery reports "revm", every assertion passes and proves nothing. Make the battery state which engine actually executed its transactions and assert it, the same way the suite already asserts a step ran by label.
>
> Add the three negative cases the spec names. The refund one is the valuable one: refunds are priced at the effective gas price and that is where a second implementation goes wrong.
>
> Do not change the oracle of any existing step as a convenience. Two steps deliberately do NOT use the trie reference, and the glossary now says why; if you genuinely need to move one, move `CONTEXT.md` with it and say why in the same change.
