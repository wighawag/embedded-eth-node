---
title: The prose undercounts the conformance battery's non-reference oracles, and the README clause overshot its brief
slug: the-prose-undercounts-the-conformance-batterys-non-reference-oracles
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

Two findings on the same paragraph, from Gate 2 on `finish-the-two-oracle-correction-on-the-other-doc-surfaces`.

**1. The count is wrong, and it is wrong in the direction that matters.** The README (and `CONTEXT.md`'s glossary entry identically) names TWO classes of conformance step whose oracle is not the trie-backed `@ethereumjs/vm` reference: the block-environment steps and the value-bearing steps. `test/helpers/conformance.ts` now carries THREE such comment blocks. The third is the block-gas-limit step added by `the-block-gas-limit-relaxation-diverges-by-engine`, and there the reference is not merely a weaker oracle, it is provably BLIND: the battery's own reference `mineBlock` passes `skipBlockGasLimitValidation`, exactly the flag whose removal that step exists to protect, so a node-versus-reference diff cannot see the behaviour at all. That step asserts the NODE's answer per engine for that reason.

The hazard is the one the parent task existed to close, left open for the newest step: an author who believes every step is a reference differential will eventually "fix" a non-reference step back onto the reference and silently destroy the property it was written to have. Closing it for two steps and not the third leaves the trap armed where the reasoning is least obvious.

**2. The README clause overshot the brief it was given.** The parent task asked for roughly one clause in the README's consumer voice, with `CONTEXT.md`'s glossary carrying the full definition, and said explicitly not to import the glossary sentence wholesale. What landed is a single sentence of about 570 characters that roughly doubles its paragraph and restates most of the glossary's reasoning (the hand-built chain, its own timestamps, a zero coinbase, no receipt for a refused read) rather than pointing at it. The content is accurate; the size is not what was asked for, and the README is the surface where a consumer meets this first.

Fix them together, since both are the same paragraph.

## Acceptance criteria

- [ ] The prose account of the battery's oracles covers all THREE non-reference classes, on both surfaces that state it (the README and `CONTEXT.md`'s glossary), or states the count in a way that cannot go stale as steps are added.
- [ ] The block-gas-limit step's reason for not using the reference is discoverable: that the reference itself passes `skipBlockGasLimitValidation` and is therefore blind to it.
- [ ] The README's clause is trimmed to the consumer-voice size the parent task asked for, leaning on the `CONTEXT.md` pointer it already carries rather than restating the glossary's reasoning.
- [ ] `CONTEXT.md`'s glossary remains the full definition, and the two surfaces do not contradict each other.
- [ ] No changeset: documentation only.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: the prose stops undercounting which conformance steps are judged against the trie reference and which are not, and the README says it at the size a README should.
>
> FIRST, check this task against current reality: it was written on 2026-08-10 and may have DRIFTED. Count the oracle-is comment blocks in `packages/embedded-eth-node/test/helpers/conformance.ts` yourself rather than trusting the number three here; more steps may have landed since.
>
> Consider whether naming a COUNT in prose is the right shape at all, given it has now been wrong twice as steps were added. A formulation that describes the RULE (which classes of bug the reference is structurally blind to, and why) ages better than one that enumerates.
>
> Keep the division of labour the parent task set: `CONTEXT.md`'s glossary carries the full definition, the README carries a consumer-voice pointer to it. Do not import the glossary sentence wholesale, and do not let the README paragraph double again.
>
> Done means all three non-reference classes are accounted for on both surfaces, the block-gas-limit step's blindness reason is discoverable, and the README clause is back to the size it was asked for.
