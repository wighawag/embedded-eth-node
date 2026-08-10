---
title: revm executes a transaction with commit, and the node builds the receipt from its outcome
slug: revm-executes-the-first-transaction-with-commit
spec: revm-engine-behind-runtx
blockedBy: [re-widen-the-engine-seam-to-cover-transactions]
covers: [1, 10, 16]
---

> **RECOVERY HANDOFF 2026-08-10. The work on `work/task-revm-executes-the-first-transaction-with-commit` is GOOD and NEARLY DONE: continue from it, do not restart.** Gate 1 passed and Gate 2 blocked on exactly two one-line documentation misses in the read-engine sweep this task owns. Both are FALSE as of that branch's own commit, which is what makes them worth a bounce rather than a nit:
>
> 1. `packages/embedded-eth-node/src/revm.ts`, the JSDoc of the factory consumers actually call: "Build a revm-backed engine, serving the seam's READ half." It now serves both halves.
> 2. `packages/benchmarks/README.md`: "Only READS move here ... has no write half yet, so a revm-backed node still executes its transactions on `@ethereumjs/vm`: `deploy` and `callAvg` are unaffected by design and any difference there is noise." Every clause of that is now wrong, and the last one is actively harmful: it tells a maintainer to DISMISS a difference in the `deploy` and `callAvg` rows as noise, when those rows are exactly what this change makes engine-sensitive. Rewrite the paragraph so those rows are named as meaningful, and check the row list that follows it (`read`, `compute`, `keccak`, `frame`, `floor`) for the same staleness. The same commit correctly updated the sibling comments in `test/helpers/cut.ts` and `test/helpers/backend-slim-node.ts`, so the README currently contradicts the code beside it.
>
> Nothing else was raised. Fix those, re-run the sweep across the whole surface once more (the phrase hides in row labels and config comments, not only in prose), and let the gates judge it again. Do NOT undo or redo anything else on the branch.

## What to build

The tracer bullet: with a revm engine installed, a plain value transfer submitted through `eth_sendRawTransaction` EXECUTES ON REVM, commits, and produces a receipt indistinguishable from the one `@ethereumjs/vm` produces for the same transaction. Narrow on purpose: one transaction shape, the smallest set of state writes that shape needs, and the receipt. Storage, code, creation, selfdestruct, fees in depth, logs, access lists and the negative cases are the tasks that follow.

Three things have to come alive together, which is what makes this a vertical slice rather than three horizontal ones: the engine's transaction operation (built on the binding's committing execute), the write half of the state store (currently five methods that throw), and the mapping from the binding's outcome into the neutral result the seam now carries.

**Nonce checking is chosen BY CONSTRUCTION from the call path, never by a caller-supplied parameter.** The binding already helps: its committing operations default the nonce check ON precisely because a caller who forgets it gets a silently replayable transaction, while the read operation defaults it off for `eth_call` semantics. Do not re-expose that as an option anywhere the node's callers can reach, and do not set it explicitly per call site: the point of story 10 is that forgetting it must be impossible, not merely discouraged.

**The transaction path gets NONE of the read path's simulation switches.** `disableBaseFee`, `disableBlockGasLimit` and `disableEip3607` relax a transaction's VALIDITY, and the binding refuses to combine any of them with committing, because a committed transaction from a contract address is one the chain would reject. A builder copying the read engine's options object would silently disable transaction validity, which is the single most dangerous mistake available in this task. Assert that the transaction path runs with full validation rather than trusting it.

**State stays the node's, read and written through host callbacks.** The engine reads accounts, code, storage and block hashes on demand and writes back ONLY the touched accounts and changed slots; it must never bulk-sync state per transaction. That is what keeps the cost proportional to what a transaction touched, and it is why `dumpState`, `loadState`, persistence and the `evm_set*` cheats keep working untouched.

**Read `packages/benchmarks/test/helpers/backend-revm.ts` before you start: it is the closest worked example of the committing path in this repo**, and it already does the right thing (a store-backed host with the binding's committing execute writing back through it). What it does NOT have is what makes this task hard: its store is a standalone `MemoryStore` that it owns, where yours is the node's live, authoritative, checkpointed state. Take the shape of its request and outcome handling; take none of its state ownership.

**TWO GAS FIELDS, AND THEY DO NOT MEAN WHAT THE OTHER ENGINE'S MEAN.** The node's receipt takes `gasUsed` from ethereumjs's `totalGasSpent`, which is NET of refunds. revm's outcome carries BOTH a `gasUsed` and a `totalGasSpent`, and its `gasUsed` is the net-of-refunds one while its `totalGasSpent` is not: the read path deliberately uses `totalGasSpent` because a read has no refund and it wants the gross number. Copying that mapping onto the transaction path puts gas-BEFORE-refunds on the receipt. A value transfer has a zero refund, so this task's own case passes either way and the error surfaces four tasks later, in the refund case, as a wrong number nobody can attribute. Get it right here and say which field you took and why at the mapping site.

**The created address is DERIVED, not reported.** The binding's outcome has no created-address field; the address must be derived from the account changes (the entry flagged as created). That is unambiguous for this task's transfer, which creates nothing, and it is NOT unambiguous for a transaction performing nested creations, which is the next task's problem. Shape the mapping so that derivation lives in one place with the ambiguity noted, rather than inline where the next task will have to find it.

**Write the state-ownership ADR as part of this task**, because it is the decision this task implements and the spec explicitly asks for it to outlive its launch snapshot. Proposed title: "revm reads and writes through host callbacks; the node keeps owning state." The reasoning to record, and the evidence, both belong in it:

- The reason ownership stays on the JS side is NOT the migration cost of `dumpState` / persistence / cheats. It is that both engines then run against IDENTICAL state, which is what lets the conformance differential compare them in place, keeps a JS-only fallback working when the wasm fails to load, and preserves the route to a state root computed outside revm over the authoritative state. Moving state into wasm forfeits all three permanently.
- It is affordable, and the claim is that the boundary is crossed once per COLD state access, because the engine's journal caches within a transaction. The figures inherited from the spec are: a contract executing 2,000 `SLOAD`s of the SAME slot causes ONE host storage callback (283,003 gas), one reading 2,000 DIFFERENT slots causes 2,000 (4,283,003 gas), and the 4,000,000 gas difference is exactly the cold-2100 versus warm-100 delta, so callbacks track EIP-2929 cold accesses one for one. **Those numbers were measured on the ENGINE side, not in this repo, and no re-runnable probe here produces them.** This repo's standard is a committed probe plus a measurements document, and it has just spent two changes repairing citations that did not resolve. So either re-measure them here with a small probe (counting host callbacks is cheap: wrap the store) and cite that, or state plainly in the ADR that the figures are inherited and name their origin. Do NOT present an unverifiable number as this repo's own measurement.
- The caveat that cuts the other way, recorded honestly: EIP-2929 resets warm/cold every transaction, so a game loop re-reading the same entities every tick re-pays those crossings every tick, where state living inside wasm would pay once. Gas is identical either way; only wall clock differs. Revisit if a real contract reads thousands of DISTINCT slots per tick, and measure it with the benchmark suite's existing rows rather than arguing it. The adapter shape means a wasm-side cache spanning transactions could be added later (it would need invalidation on the `evm_set*` cheats) without redesigning the seam.

## Acceptance criteria

- [ ] With a revm engine installed, a signed value transfer through `eth_sendRawTransaction` executes on revm and commits, and the resulting receipt matches the one `@ethereumjs/vm` produces for the identical transaction field for field.
- [ ] Post-state after that transfer matches `@ethereumjs/vm` exactly for the accounts it touched (balances and nonces at minimum).
- [ ] The state store's write methods are implemented for the accounts this path touches; the engine reads on demand and writes only what changed, with no bulk sync anywhere.
- [ ] Nonce checking on the transaction path is not reachable as an option from any node-level caller, and is demonstrated ON (a replayed nonce is rejected — the depth of that case belongs to a later task, one assertion is enough here).
- [ ] The SENDER crosses the seam as an explicit value rather than as something the engine derives for itself. The node supports a trusted-sender mode whose whole point is that the claimed sender may differ from the recoverable one, so an engine that recovers its own sender would execute a transaction as the wrong address with a plausible receipt. The end-to-end proof of that belongs to `trusted-sender-transactions-run-on-the-write-engine-as-the-claimed-sender`; making it structurally impossible belongs here.
- [ ] The receipt's `gasUsed` is net of refunds on both engines, with the chosen outcome field and the reason recorded at the mapping site.
- [ ] The transaction path carries NO simulation switch, asserted rather than assumed.
- [ ] `dumpState`, `loadState` and the `evm_set*` cheats behave identically with the revm engine installed for the state this task touches.
- [ ] **`Engine.transact` becomes REQUIRED and the fallback is DELETED, in this change.** The seam task shipped it OPTIONAL for one reason only: the revm engine had no write half, so requiring it would have meant either refusing every transaction on a revm-backed node or changing behaviour, and that task's bar was that nothing changes. This task removes that reason. So finish the contraction here rather than leaving a vestigial capability check in shipped code: drop the `?`, delete the node's `transacts(engine) ? engine : defaultEngine` fallback and the second internally-built engine it selects, and remove the transitional wording from `Engine.transact`'s doc, ADR 0006's amendment and `CONTEXT.md`. The maintainer's tasking-time decision was ONE interface with both operations, not an optional capability; this is where that becomes true.
- [ ] With the contraction done, `node.engine` reports the engine that ran BOTH the reads and the transactions, so the misattribution ADR 0006's second consequence warned about is gone rather than merely documented.
- [ ] The phrase *read engine* no longer DESCRIBES this engine anywhere it would then be false. It survives in about ten live places (this module's own header, the README's battery paragraph, the benchmark row label and its config comment, the conformance and engine-seam helpers, the benchmarks slim-node backend), and every one of them is ACCURATE today precisely because this engine only reads. This task is what falsifies them, so it owns them. Two exclusions in the same spirit as the seam task's: `CHANGELOG.md` is history, and `docs/spikes/revm-engine-under-conformance-and-gate/frame-measurements.md` is a titled record of a past measurement run — leave both alone.
- [ ] The seam's construction refusal for a present-but-not-callable `transact` is ASSERTED, in the same place the other engine refusals are (the engine-seam honesty checks). It shipped untested, and this repo's own convention is that a refusal nothing measures is one refactor away from disappearing.
- [ ] An ADR records the state-ownership decision, its reasoning and the measured affordability above, including the caveat that cuts against it.
- [ ] Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`), and the default engine's behaviour is untouched.
- [ ] A changeset.

## Blocked by

- `re-widen-the-engine-seam-to-cover-transactions` — the seam and the neutral transaction result must exist first.

## Prompt

> Goal: the first transaction this node executes on revm, end to end, committing, with a receipt that matches `@ethereumjs/vm`'s. Keep it to a value transfer; everything else in this spec is a later task.
>
> FIRST, check this task against current reality: it was written on 2026-08-09 and may have DRIFTED. Confirm the seam task actually landed and in what shape, confirm the state store's write methods still throw, and confirm the binding's committing execute still defaults its nonce check on. Build on what is there, not on what this file assumes.
>
> Read the widened engine seam and its neutral transaction result, the revm engine module and its read path (for the switches you must NOT reuse), the state store whose five write methods currently throw, `docs/adr/0005-...` (why the store reaches into the state manager at all) and `docs/adr/0009-...` (what storage actually looks like now: per-account maps with per-checkpoint overlays, and a retired flat stack that THROWS if read).
>
> Read the binding's own documentation of its committing execute and of its outcome blob before writing the mapping. Two details in that format bite hand-rolled decoders and the package says so: the 256-byte bloom is present ONLY when the log count is non-zero, and code bytes are conditional on a flag that means "the code hash changed", not "revm loaded some code". Use the package's decoder rather than reading the blob yourself.
>
> THE DANGEROUS MISTAKE IS COPYING THE READ PATH'S OPTIONS. Those simulation switches relax transaction validity and the binding refuses to combine them with committing. A transaction that runs with them is not a transaction. Assert their absence.
>
> Nonce checking must be impossible to forget, which means it is chosen by the call path and never surfaced as a parameter a node-level caller can pass.
>
> FINISH THE CONTRACTION. `Engine.transact` is optional today only because this engine could not implement it. Once it can, the optional marker and the node's fallback to a second internally-built engine are vestigial code in a published package, and nobody else owns removing them. Delete them here, and take the transitional wording out of the doc comment, ADR 0006's amendment and the glossary with them.
>
> Done means: one transfer, on revm, committed, with a receipt and post-state a diff cannot tell apart from ethereumjs's, plus the ADR that records why the node still owns state.
