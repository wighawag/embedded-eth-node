---
title: Harden the two new log conformance assertions, which can weaken silently
slug: harden-the-new-log-conformance-assertions
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`logs-and-the-logs-bloom-come-from-the-engine` added conformance steps covering the log that must NOT appear. Gate 2 approved them and found two ways they can stop testing what they claim, without going red.

**1. The bloom-absence assertion depends on an unstated coupling.** Absence is asserted as byte-equality between the receipt's bloom and a baseline `emitTwo(3,4)` receipt's bloom, with no bloom computed test-side and a guard that the baseline is not all zero. That is a good shape, and it holds ONLY while the two transactions keep identical log addresses and topics. A future edit to either probe function, changing a topic or emitting from a different address, makes the two blooms legitimately differ and the assertion then fails for a reason that has nothing to do with a discarded log, or worse is "fixed" by re-baselining and silently stops asserting absence. The coupling is load-bearing and is currently only implicit.

**2. Two of the four new steps are asserted by label on one engine only.** `revm-conformance.spec.ts` names all four; `conformance.spec.ts` names only the discarded-sub-call and `logIndex` steps, so the zero-log-bloom and reverted-top-level steps are guarded on the default engine by nothing but the `steps.length >= 20` bar. If either were dropped from the battery, the default-engine spec would not notice.

**3. Added 2026-08-11 from Gate 2 on `the-conformance-differential-covers-transactions-on-revm`: the engine-execution bar is a FLOOR where an exact count is available.** That task added an assertion that transactions ran on the installed engine, pinned as `MIN_TRANSACTIONS_ON_THE_ENGINE = 20` (mirrored as a bare `20` literal in `test/revm-conformance.spec.ts`), while the battery actually hands the engine close to thirty. So a PARTIAL regression, say five of thirty reverting to an in-node path, still passes. The battery already knows exactly how many transactions it submitted, so asserting that number closes the slack at no cost. Remove the duplicated bare literal while you are there.

**4. Added 2026-08-11 from Gate 2 on `every-node-feature-survives-a-revm-write-engine`: a vacuous field presented as evidence.** In `test/helpers/state-roundtrip.ts`, `cheats.secondTxNonce` is filled from the compile-time constant `CHEAT_SENDER_NONCE` and then asserted against that same constant in both specs. It cannot fail, while being documented as the cheated nonce the second transaction was accepted at, which is exactly the kind of assertion a reader counts as coverage and gets none from. The load-bearing evidence next to it is real (`cheatSenderNonceAfter`, read from the node via `eth_getTransactionCount`, plus the transaction being admitted at all), so the fix is to read the value from the node or drop the field rather than to add more around it.

**5. Added 2026-08-11 from Gate 2 on `sender-recovery-uses-the-engines-ecrecover`: a refusal row that proves something other than what it says.** The `legacy-bad-v` case in `test/helpers/sender-recovery.ts` is documented as covering recovery-id disagreement, but `v = chainId*2+37` is rejected by `@ethereumjs/tx`'s constructor inside `createTxFromRLP`, on BOTH nodes, so it never reaches `recoverSender` and what it actually proves is parse-time agreement. Relatedly the `recovery !== 0/1` guard in `recoverSender` is effectively unreachable from a parsed transaction, since legacy `v` is constrained by the constructor and typed y-parity by its own validation. The acceptance criterion it serves is still met observably (both refuse, nothing is mined, no state moves) and the genuine recovery-id coverage lives elsewhere, so this is a comment correction rather than a missing test: say what the row proves, and note the guard's reachability where it is defined.

## Acceptance criteria

- [ ] The coupling the bloom-absence assertion depends on is enforced or made explicit, so that changing a probe function's address or topics cannot silently turn the assertion into a re-baselining exercise. Asserting the two transactions' log addresses and topics agree, at the point the baseline is taken, is sufficient.
- [ ] All four new log steps are asserted by label on BOTH conformance specs, not only on the revm one.
- [ ] The engine-execution assertion pins the EXACT number of transactions the battery submitted rather than a floor, and the duplicated bare literal in the revm spec is gone.
- [ ] The battery stays green on both engines and both state modes, with no step's meaning changed.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] No assertion in the touched helpers compares a constant against itself; `secondTxNonce` is either read from the node or removed.
- [ ] No changeset: test-only.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: two log conformance assertions that cannot quietly stop asserting what they were written to assert.
>
> FIRST, check this task against current reality: it was written on 2026-08-10 and may have DRIFTED. Confirm the baseline-equality shape and the label asymmetry still exist before changing them.
>
> Do NOT compute a logs bloom test-side to fix item 1. Computing one would re-introduce exactly the second implementation of protocol arithmetic that the parent task existed to remove, and the baseline-comparison shape is deliberately chosen to avoid it. Enforce the COUPLING instead: make the test state, and check, that the two transactions it compares really do produce the same log addresses and topics.
>
> Done means a probe edit cannot silently weaken the absence assertion, and neither conformance spec is relying on a step count to notice a missing step.
