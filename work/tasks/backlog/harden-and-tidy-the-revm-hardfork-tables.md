---
title: Freeze the exported revm hardfork tables, and fix ADR 0008's stale probe citation
slug: harden-and-tidy-the-revm-hardfork-tables
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

Two loose ends around the revm engine's hardfork tables, both found by Gate-2 reviews.

> **Trimmed 2026-08-02.** This task originally carried a third item: a comment in `src/revm.ts` still naming the pre-rename `SPEC_BY_HARDFORK`. `intrinsic-gas-charges-eip-3860-on-forks-that-predate-it` rewrote that comment in passing, so the item is DONE and has been removed. Its stated rationale had also gone stale: it justified the `mixHash` read by "a pre-Merge fork the table still admits", and the admitted set is now `shanghai` + `cancun`, so no admitted fork is pre-Merge. The comment as it now stands says exactly that and keeps the `mixHash` read as belt and braces. Do not re-apply the removed item.

**1. The exported tables are `Readonly` at type level only, not frozen.** `REVM_SPEC_BY_HARDFORK` and `REVM_REFUSED_HARDFORKS` are public exports of `embedded-eth-node/revm` so consumers can ask which forks are served without provoking a throw. But `Readonly<Record<...>>` is erased at runtime, so a consumer can do `REVM_SPEC_BY_HARDFORK.prague = 'PRAGUE'` and defeat the construction guard that ADR 0008 exists to install. The guard's whole value is that a misconfiguration fails where the consumer can see it; a guard a stray assignment silently removes is weaker than it reads. `Object.freeze` on both is the obvious answer, in the same spirit as the engine's other honest edges. Decide also whether the refusal path should be robust to a mutated table (for instance by deriving the admitted set once at module load) or whether freezing is enough, and say which and why.

Note this matters more than it did when first written: the admitted set is now just `shanghai` and `cancun`, so there are five refused forks a consumer could try to re-admit by assignment, and three of them (`berlin`, `london`, `paris`) are refused for a reason no later check would catch, since the node and revm AGREE on the wrong number there (ADR 0008's amendment).

**2. ADR 0008 cites a probe script that does not exist under that name.** It refers to `probe.mjs`; the file is `docs/spikes/prague-intrinsic-gas-floor-or-refuse/probe-hardfork-costing.mjs`. The ADR's authority rests on "re-run this and check", so a citation that does not resolve costs it exactly the property it was written to have. (The amendment's own citations, added later, do resolve; it is the original section's reference that is stale.)

## Acceptance criteria

- [ ] `REVM_SPEC_BY_HARDFORK` and `REVM_REFUSED_HARDFORKS` cannot be mutated at runtime by a consumer, and a test asserts the construction guard still refuses a fork after an attempt to re-admit it through the exported table.
- [ ] Whether freezing alone is sufficient (versus deriving the admitted set once at load) is decided explicitly and the reasoning recorded at the code site.
- [ ] ADR 0008 cites the probe script by its real filename, and every other path it cites is confirmed to resolve.
- [ ] No behaviour changes for any admitted fork; the refusal messages keep naming the EIP, the file to change, and the ADR.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None.

## Prompt

> Goal: make the hardfork tables as solid as the ADR that relies on them, and fix a citation that no longer resolves.
>
> Read `REVM_SPEC_BY_HARDFORK` / `REVM_REFUSED_HARDFORKS` and the construction guard in `packages/embedded-eth-node/src/revm.ts`, plus `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` including its amendment.
>
> The interesting item is the first. These went public so that "which forks does this engine serve" is answerable in code rather than by provoking a throw, which is right. But `Readonly` is a compile-time claim only and the runtime object is mutable, so the construction refusal can be removed by a single assignment from outside. Decide whether freezing is enough or whether the guard should read from a snapshot taken at module load, and record the reasoning where the next reader will meet it.
>
> The second is small and factual: the ADR cites `probe.mjs` when the file is `probe-hardfork-costing.mjs`. Keep the surrounding text intact; only the name is wrong.
>
> Do NOT re-open which forks are admitted, and do not change any refusal message's content. This task hardens and tidies; re-admission is `readmit-refused-hardforks-once-the-node-can-cost-them`.
