---
title: Freeze the exported revm hardfork tables, assert the unbound-Common refusal, and fix ADR 0008's stale probe citation
slug: harden-and-tidy-the-revm-hardfork-tables
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

Two loose ends around the revm engine's hardfork tables, both found by Gate-2 reviews.

> **Trimmed 2026-08-02.** This task originally carried a third item: a comment in `src/revm.ts` still naming the pre-rename `SPEC_BY_HARDFORK`. `intrinsic-gas-charges-eip-3860-on-forks-that-predate-it` rewrote that comment in passing, so the item is DONE and has been removed. Do not re-apply the removed item.
>
> **Re-checked 2026-08-02** after `upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks` re-admitted `berlin`, `london` and `paris`. An earlier version of this note said no admitted fork was pre-Merge and the `mixHash` read was therefore belt and braces. That is now FALSE twice over: `berlin` and `london` are pre-Merge, so the `prevRandao` getter would throw on them and the `mixHash` read is load-bearing rather than defensive. The comment in `src/revm.ts` was already corrected to say so by that task; nothing is owed here, and nobody should "simplify" that read back to the getter.

**1. The exported tables are `Readonly` at type level only, not frozen.** `REVM_SPEC_BY_HARDFORK` and `REVM_REFUSED_HARDFORKS` are public exports of `embedded-eth-node/revm` so consumers can ask which forks are served without provoking a throw. But `Readonly<Record<...>>` is erased at runtime, so a consumer can do `REVM_SPEC_BY_HARDFORK.prague = 'PRAGUE'` and defeat the construction guard that ADR 0008 exists to install. The guard's whole value is that a misconfiguration fails where the consumer can see it; a guard a stray assignment silently removes is weaker than it reads. `Object.freeze` on both is the obvious answer, in the same spirit as the engine's other honest edges. Decide also whether the refusal path should be robust to a mutated table (for instance by deriving the admitted set once at module load) or whether freezing is enough, and say which and why.

Note this matters more than it did when first written. The admitted set is `berlin`, `london`, `paris`, `shanghai`, `cancun`, and the two refused forks (`prague`, `osaka`) are refused for arithmetic this node does not implement, so a consumer who re-admits one by assignment gets an `eth_estimateGas` that revm itself rejects (`GasFloorMoreThanGasLimit`, and on Osaka `TxGasLimitGreaterThanCap` for the default read budget). The guard is the only thing standing between that assignment and a silently wrong estimate.

**3. The `call()` guard added by the 0.3.1 upgrade is not asserted.** `src/revm.ts`'s `call()` now throws if `connect()` never bound a `Common` (the fork the shared `intrinsicGas()` needs). It mirrors the existing unbound guard in `revm-state-store.ts` and is unreachable through `createNode()`, since the seam always connects first, so only a consumer hand-driving a `ReadEngine` can hit it. Every other honest edge in this repo is asserted rather than merely written, and a refusal nothing tests is one refactor away from silently disappearing. Add the assertion in the same style as the existing unbound-store one. (Raised by the Gate-2 review of the 0.3.1 upgrade, which recorded that no test covers it.)

> **Conductor note 2026-08-02 (drive-tasks pre-check), for item 2 and the "every other path resolves" criterion.** The probe rename is not the only dangling citation in ADR 0008. Its two `Decisions taken while amending this:` lines cite `work/notes/observations/decisions-intrinsic-gas-charges-eip-3860-on-forks-that-predate-it-2026-08-02.md` and `.../decisions-upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks-2026-08-02.md`, and NEITHER file exists: both were discharged by DELETION once the maintainer ratified them (commits `38e0164` and `40e0c73`), which is what `WORK-CONTRACT.md` mandates for a capture-bucket note ("they leave only by deletion; git history is the archive"). They are in scope for the criterion that every cited path resolves. **Do NOT recreate the deleted notes** and do not bulk-paste their content into the ADR. Fix them honestly, and say which you chose: cite the discharging commit (git history IS the archive), or drop the pointer where the ADR body already carries the reasoning. Everything else about item 2 stands: only the citation changes, never the surrounding text.

**2. ADR 0008 cites a probe script that does not exist under that name.** It refers to `probe.mjs`; the file is `docs/spikes/prague-intrinsic-gas-floor-or-refuse/probe-hardfork-costing.mjs`. The ADR's authority rests on "re-run this and check", so a citation that does not resolve costs it exactly the property it was written to have. (The amendment's own citations, added later, do resolve; it is the original section's reference that is stale.)

## Acceptance criteria

- [ ] `REVM_SPEC_BY_HARDFORK` and `REVM_REFUSED_HARDFORKS` cannot be mutated at runtime by a consumer, and a test asserts the construction guard still refuses a fork after an attempt to re-admit it through the exported table.
- [ ] Whether freezing alone is sufficient (versus deriving the admitted set once at load) is decided explicitly and the reasoning recorded at the code site.
- [ ] ADR 0008 cites the probe script by its real filename, and every other path it cites is confirmed to resolve.
- [ ] `src/revm.ts`'s `call()` refusal when `connect()` never bound a `Common` is ASSERTED by a test, in the style of the existing unbound-store assertion, so the refusal cannot disappear in a refactor unnoticed.
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
