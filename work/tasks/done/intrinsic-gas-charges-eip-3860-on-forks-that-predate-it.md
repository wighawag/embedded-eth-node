---
title: The shared intrinsic-gas formula charges EIP-3860 on forks that predate it, and agrees with revm only because revm is wrong the same way
slug: intrinsic-gas-charges-eip-3860-on-forks-that-predate-it
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

`src/intrinsic-gas.ts` adds the EIP-3860 initcode word cost (`ceil(len/32) * 2`) to every CREATE, with NO hardfork gate. EIP-3860 arrived in Shanghai, but the engine's table still admits `berlin`, `london` and `paris`, so on those three forks the node charges a cost that did not exist yet.

The spike behind ADR 0008 noticed this and dismissed it because revm over-charges identically, so the two sides agree and the cross-engine invariant holds. That reasoning is worth taking seriously and is probably why it is not urgent, but it is also **agreement between two wrong sides**, which is exactly the shape ADR 0008 exists to refuse. The ADR's new admission rule is "everything the node computes about a transaction still agrees with what revm enforces under this spec" — and berlin/london/paris satisfy that rule while both parties charge a post-Shanghai cost on a pre-Shanghai fork. The rule as written cannot see this, which is the interesting part: a fork can pass the bar and still be mis-costed against the actual protocol. (Raised by the Gate-2 review of `prague-intrinsic-gas-floor-or-refuse`.)

Resolve it deliberately, in whichever direction the evidence supports. There are three honest outcomes and this task picks one:

**Gate it.** Add the fork gate so the initcode cost applies from Shanghai onward only. Note this may BREAK agreement with revm on berlin/london/paris if revm really does charge it unconditionally there, in which case gating alone makes things worse, not better. Measure before choosing.

**Refuse them.** If the node and revm cannot agree with the PROTOCOL on those forks, they belong in `REVM_REFUSED_HARDFORKS` for the same reason Prague is, and the admitted set shrinks to shanghai + cancun. This is the resolution most consistent with ADR 0008, and it is cheap: nothing reaches those forks today.

**Record it.** If it is genuinely harmless (for instance, because a CREATE read on a pre-Shanghai fork is not a shape any consumer can reach), write the reason into the table and into ADR 0008's rule so the next reader does not re-discover it as a bug. A recorded, reasoned exception is fine; an unexamined one is not.

Prefer whichever the measurement supports, and note the honest-edge convention (ADR 0004) prefers a loud refusal to a plausible wrong number.

## Acceptance criteria

- [ ] What revm ACTUALLY charges for initcode on `BERLIN`/`LONDON`/`MERGE` is measured against the shipped `revm-wasm` artifact and recorded, rather than assumed from the spike's summary. Extend `docs/spikes/prague-intrinsic-gas-floor-or-refuse/probe-hardfork-costing.mjs` or add a sibling probe.
- [ ] Whether the protocol-correct cost differs from what BOTH sides charge on those forks is stated explicitly, with the answer, since that is the whole question.
- [ ] One of the three resolutions above is implemented, and the reasoning is recorded durably (a decision record, and an amendment to ADR 0008 if the admission rule itself needs sharpening to cover "agrees with revm but not with the protocol").
- [ ] If the fork gate is added, `src/intrinsic-gas.ts` stays SHARED and unforked, and the node/engine agreement is re-asserted against the engine on every admitted fork, not just Cancun.
- [ ] Cancun and Shanghai behaviour are demonstrably unchanged, including the EIP-3860 initcode case the conformance differential already covers.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None.

## Prompt

> Goal: decide, on evidence, what the node should charge for initcode on the pre-Shanghai forks the revm engine still admits, and stop relying on "revm is wrong the same way we are" as the justification.
>
> Read `src/intrinsic-gas.ts` (the unconditional `32000` + word cost), `REVM_SPEC_BY_HARDFORK` in `src/revm.ts`, `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` (especially its admission rule), and section 3 of `docs/spikes/prague-intrinsic-gas-floor-or-refuse/measurements.md`, which noticed this and set it aside.
>
> MEASURE FIRST, DECIDE SECOND. The spike's claim is that revm over-charges identically on those forks. Verify it against the shipped artifact rather than inheriting it: the whole point of this task is that a claim of the form "we agree, therefore we are fine" is the one that needs checking, and if it is wrong the right resolution flips.
>
> THE SUBTLE PART, and it is the reason this task exists rather than a one-line gate: ADR 0008's admission rule is agreement between the node and revm. This case PASSES that rule while both sides are wrong about the protocol. If your resolution shows the rule is under-specified, amend the ADR too, because a bar that cannot see a real mis-costing will let the next one through as well.
>
> Prefer a loud refusal over a plausible wrong number (ADR 0004), and prefer a recorded, reasoned exception over an unexamined one.
>
> Done means: nobody has to re-derive whether pre-Shanghai initcode costing is a bug, because the answer and its evidence are written down and the code matches it.
