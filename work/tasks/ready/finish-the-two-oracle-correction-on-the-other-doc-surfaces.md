---
title: Finish the two-oracle correction on the README, and repair the discharged-note citations left in the spike docs
slug: finish-the-two-oracle-correction-on-the-other-doc-surfaces
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

Two documentation drifts on surfaces the tasks that found them deliberately did not touch. Both are of the same kind — a document describing a state of the world that has since moved — and both are cheap.

**1. The README still describes the conformance battery as a single-oracle differential.** `context-md-conformance-differential-covers-both-oracles` fixed `CONTEXT.md`'s glossary entry: the battery uses the trie-backed `@ethereumjs/vm` reference for the receipt and post-state steps, and a DIFFERENT oracle (the node's own block plus its configured `blockEnv`; an absolute per-sender, per-value statement) for the block-environment and value-bearing steps, because those two classes of bug are structurally invisible to the reference. The README's own account of the same battery still says only "a battery of signed txs through BOTH the node and a hand-wired trie-backed `@ethereumjs/vm` `runTx` reference, asserting field-by-field equality of receipts/logs/return-data/gas/post-state in both state modes". That is the belief which, held by the next author, leads to "fixing" the two newer steps back onto the reference and destroying the property they exist to have. The task fenced itself to the glossary on purpose, so this is a follow-up rather than a miss.

Keep the README's voice: it is a prose overview for a consumer, not a glossary, so one clause naming the second oracle and why, pointing at `CONTEXT.md`'s term or at the code comments, is the right size. Do not import the glossary sentence wholesale.

**2. Two spike documents cite decision records that were discharged by deletion.** `harden-and-tidy-the-revm-hardfork-tables` repaired this in ADR 0008 and set the precedent: a ratified decision record leaves its bucket by deletion (`work/protocol/WORK-CONTRACT.md`, git history is the archive), so the honest citation names the discharging COMMIT and where the reasoning now lives. Three of the same dead pointers survive:

- `docs/spikes/revm-wasm-upgrade-honest-block-environment/measurements.md` cites decision 6 of `decisions-revm-wasm-upgrade-honest-block-environment-2026-08-02.md` (discharged in `38e0164`; that decision's reasoning is carried at the `disableBalanceCheck` code site in `packages/embedded-eth-node/src/revm.ts`).
- `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md` cites `decisions-intrinsic-gas-charges-eip-3860-on-forks-that-predate-it-2026-08-02.md` (discharged in `38e0164`) and `decisions-upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks-2026-08-02.md` (discharged in `40e0c73`).

Do NOT recreate the deleted notes, and do not copy their contents into the spike docs. A spike document's authority is "re-run this and check", exactly like an ADR's, so a citation that does not resolve costs it the property it was written to have. Note also that the first of those two files carries a §5 conclusion ("the node keeps its unconditional EIP-3860 term ... admits `shanghai` and `cancun` only") that §6 later inverts; while you are in the file, check that a reader cannot take the superseded conclusion for the current one, and mark it if they can.

## Acceptance criteria

- [ ] The README's description of the conformance battery names the second oracle and why the reference cannot serve those two steps, in the README's own voice, in roughly one clause or sentence.
- [ ] All three dead `work/notes/observations/decisions-*.md` citations in the two spike `measurements.md` files resolve, following the form ADR 0008 now uses (the discharging commit plus where the reasoning lives).
- [ ] No deleted note is recreated, and no decision record's content is pasted into a spike document.
- [ ] Any superseded conclusion in `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md` is marked as superseded where a reader would meet it, without rewriting the measurement history.
- [ ] Documentation only: no source, test, behaviour or gas change.

## Blocked by

- None.

## Prompt

> Goal: two documents still describe a world that moved, on surfaces the tasks that spotted them deliberately left alone.
>
> Read the *conformance differential* entry in `CONTEXT.md` (the corrected version), the battery paragraph in `README.md`, and the two `docs/spikes/*/measurements.md` files named in the body.
>
> The citation half has a precedent to follow, not a judgement to make: ADR 0008 now cites the discharging commit and names where each decision's reasoning lives, because `WORK-CONTRACT.md` makes deletion the discharge and git history the archive. Match that form.
>
> The README half is a voice question. It is a consumer-facing overview, so name the second oracle and the reason in a clause; the glossary carries the full definition already.
>
> Done means: no document in this repo still claims every conformance step diffs against the trie reference, and no citation in a spike document points at a file that is not there.
