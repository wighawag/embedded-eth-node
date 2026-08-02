---
title: Freeze the exported revm hardfork tables and fix two stale references left by the rename
slug: harden-and-tidy-the-revm-hardfork-tables
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

Three small, related loose ends left by `prague-intrinsic-gas-floor-or-refuse`, all in the same neighbourhood, all found by its Gate-2 review. They are grouped because they touch the same two exports and the same ADR, not because they are one idea.

**1. The exported tables are `Readonly` at type level only, not frozen.** `REVM_SPEC_BY_HARDFORK` and `REVM_REFUSED_HARDFORKS` became public exports of `embedded-eth-node/revm` so consumers can ask which forks are served without triggering a refusal. But `Readonly<Record<...>>` is erased at runtime, so a consumer can do `REVM_SPEC_BY_HARDFORK.prague = 'PRAGUE'` and defeat the construction guard that ADR 0008 exists to install. The guard's whole value is that a misconfiguration fails where the consumer can see it; a guard that a stray assignment silently removes is weaker than it reads. `Object.freeze` on both is the obvious answer, in the same spirit as the engine's other honest edges. Consider whether the refusal path should ALSO be robust to a mutated table (for example, by deriving the admitted set once at module load), or whether freezing is enough; say which and why.

**2. A comment still names the pre-rename constant.** `packages/embedded-eth-node/src/revm.ts` (in the `prevRandao` comment, around the `mixHash` explanation) says "which SPEC_BY_HARDFORK still maps". The constant is now `REVM_SPEC_BY_HARDFORK`. The sentence is load-bearing: it explains why `mixHash` is read instead of the `prevRandao` getter, which throws on a pre-Merge fork the table still admits, so a reader who greps the named constant and finds nothing may conclude the hazard is gone.

**3. ADR 0008 cites a probe script that does not exist under that name.** It refers to `probe.mjs`; the file is `docs/spikes/prague-intrinsic-gas-floor-or-refuse/probe-hardfork-costing.mjs`. The ADR's authority rests on "re-run this and check", so a citation that does not resolve costs it exactly the property it was written to have.

## Acceptance criteria

- [ ] `REVM_SPEC_BY_HARDFORK` and `REVM_REFUSED_HARDFORKS` cannot be mutated at runtime by a consumer, and a test asserts that the construction guard still refuses `prague` after an attempt to re-admit it through the exported table.
- [ ] Whether freezing alone is sufficient (versus deriving the admitted set once at load) is decided explicitly and the reasoning recorded at the code site.
- [ ] The stale `SPEC_BY_HARDFORK` reference in the `prevRandao` comment names the current constant, with the explanation it carries left intact.
- [ ] ADR 0008 cites the probe script by its real filename, and any other path it cites is confirmed to resolve.
- [ ] No behaviour changes for any admitted fork; the refusal messages keep naming the EIP, the file to change, and the ADR.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None.

## Prompt

> Goal: make the hardfork tables as solid as the ADR that relies on them, and fix two references that no longer resolve.
>
> Read `REVM_SPEC_BY_HARDFORK` / `REVM_REFUSED_HARDFORKS` and the construction guard in `packages/embedded-eth-node/src/revm.ts`, plus `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`.
>
> The interesting item is the first. These went public so the answer to "which forks does this engine serve" is available in code rather than by provoking a throw, which is right. But `Readonly` is a compile-time claim only, and the runtime object is mutable, so the construction refusal ADR 0008 installs can be removed by a single assignment from outside. Decide whether freezing is enough or whether the guard should read from a snapshot taken at module load, and record the reasoning where the next reader will meet it.
>
> The other two are small and factual: a comment naming the pre-rename constant, and an ADR citing `probe.mjs` when the file is `probe-hardfork-costing.mjs`. Keep the surrounding explanations intact; only the names are wrong.
>
> Do NOT re-open the Prague/Osaka decision here, and do not change any refusal message's content. This task hardens and tidies what landed; re-admission is `readmit-prague-and-osaka-once-the-node-can-cost-them`.
