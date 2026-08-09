---
title: revm executes a transaction with commit, and the node builds the receipt from its outcome
slug: revm-executes-the-first-transaction-with-commit
spec: revm-engine-behind-runtx
blockedBy: [re-widen-the-engine-seam-to-cover-transactions]
covers: [1, 10, 16]
---

## What to build

The tracer bullet: with a revm engine installed, a plain value transfer submitted through `eth_sendRawTransaction` EXECUTES ON REVM, commits, and produces a receipt indistinguishable from the one `@ethereumjs/vm` produces for the same transaction. Narrow on purpose: one transaction shape, the smallest set of state writes that shape needs, and the receipt. Storage, code, creation, selfdestruct, fees in depth, logs, access lists and the negative cases are the tasks that follow.

Three things have to come alive together, which is what makes this a vertical slice rather than three horizontal ones: the engine's transaction operation (built on the binding's committing execute), the write half of the state store (currently five methods that throw), and the mapping from the binding's outcome into the neutral result the seam now carries.

**Nonce checking is chosen BY CONSTRUCTION from the call path, never by a caller-supplied parameter.** The binding already helps: its committing operations default the nonce check ON precisely because a caller who forgets it gets a silently replayable transaction, while the read operation defaults it off for `eth_call` semantics. Do not re-expose that as an option anywhere the node's callers can reach, and do not set it explicitly per call site: the point of story 10 is that forgetting it must be impossible, not merely discouraged.

**The transaction path gets NONE of the read path's simulation switches.** `disableBaseFee`, `disableBlockGasLimit` and `disableEip3607` relax a transaction's VALIDITY, and the binding refuses to combine any of them with committing, because a committed transaction from a contract address is one the chain would reject. A builder copying the read engine's options object would silently disable transaction validity, which is the single most dangerous mistake available in this task. Assert that the transaction path runs with full validation rather than trusting it.

**State stays the node's, read and written through host callbacks.** The engine reads accounts, code, storage and block hashes on demand and writes back ONLY the touched accounts and changed slots; it must never bulk-sync state per transaction. That is what keeps the cost proportional to what a transaction touched, and it is why `dumpState`, `loadState`, persistence and the `evm_set*` cheats keep working untouched. The benchmarks package's revm backend rebuilds host state wholesale after every write; that is an artefact of it having been a read-only hybrid and must NOT be copied here.

**Write the state-ownership ADR as part of this task**, because it is the decision this task implements and the spec explicitly asks for it to outlive its launch snapshot. Proposed title: "revm reads and writes through host callbacks; the node keeps owning state." The reasoning to record, and the evidence, both belong in it:

- The reason ownership stays on the JS side is NOT the migration cost of `dumpState` / persistence / cheats. It is that both engines then run against IDENTICAL state, which is what lets the conformance differential compare them in place, keeps a JS-only fallback working when the wasm fails to load, and preserves the route to a state root computed outside revm over the authoritative state. Moving state into wasm forfeits all three permanently.
- It is affordable, measured rather than argued: the boundary is crossed once per COLD state access, because the engine's journal caches within a transaction. Counted directly, a contract executing 2,000 `SLOAD`s of the SAME slot causes ONE host storage callback (283,003 gas), and one reading 2,000 DIFFERENT slots causes 2,000 (4,283,003 gas) — a 4,000,000 gas difference that is exactly the cold-2100 versus warm-100 delta, so callbacks track EIP-2929 cold accesses one for one. A crossing is paid precisely where the EVM already charges a cold-access premium.
- The caveat that cuts the other way, recorded honestly: EIP-2929 resets warm/cold every transaction, so a game loop re-reading the same entities every tick re-pays those crossings every tick, where state living inside wasm would pay once. Gas is identical either way; only wall clock differs. Revisit if a real contract reads thousands of DISTINCT slots per tick, and measure it with the benchmark suite's existing rows rather than arguing it. The adapter shape means a wasm-side cache spanning transactions could be added later (it would need invalidation on the `evm_set*` cheats) without redesigning the seam.

## Acceptance criteria

- [ ] With a revm engine installed, a signed value transfer through `eth_sendRawTransaction` executes on revm and commits, and the resulting receipt matches the one `@ethereumjs/vm` produces for the identical transaction field for field.
- [ ] Post-state after that transfer matches `@ethereumjs/vm` exactly for the accounts it touched (balances and nonces at minimum).
- [ ] The state store's write methods are implemented for the accounts this path touches; the engine reads on demand and writes only what changed, with no bulk sync anywhere.
- [ ] Nonce checking on the transaction path is not reachable as an option from any node-level caller, and is demonstrated ON (a replayed nonce is rejected — the depth of that case belongs to a later task, one assertion is enough here).
- [ ] The transaction path carries NO simulation switch, asserted rather than assumed.
- [ ] `dumpState`, `loadState` and the `evm_set*` cheats behave identically with the revm engine installed for the state this task touches.
- [ ] An ADR records the state-ownership decision, its reasoning and the measured affordability above, including the caveat that cuts against it.
- [ ] Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`), and the default engine's behaviour is untouched.
- [ ] A changeset.

## Blocked by

- `re-widen-the-engine-seam-to-cover-transactions` — the seam and the neutral transaction result must exist first.

## Prompt

> Goal: the first transaction this node executes on revm, end to end, committing, with a receipt that matches `@ethereumjs/vm`'s. Keep it to a value transfer; everything else in this spec is a later task.
>
> Read the widened engine seam and its neutral transaction result, the revm engine module and its read path (for the switches you must NOT reuse), the state store whose five write methods currently throw, `docs/adr/0005-...` (why the store reaches into the state manager at all) and `docs/adr/0009-...` (what storage actually looks like now: per-account maps with per-checkpoint overlays, and a retired flat stack that THROWS if read).
>
> Read the binding's own documentation of its committing execute and of its outcome blob before writing the mapping. Two details in that format bite hand-rolled decoders and the package says so: the 256-byte bloom is present ONLY when the log count is non-zero, and code bytes are conditional on a flag that means "the code hash changed", not "revm loaded some code". Use the package's decoder rather than reading the blob yourself.
>
> THE DANGEROUS MISTAKE IS COPYING THE READ PATH'S OPTIONS. Those simulation switches relax transaction validity and the binding refuses to combine them with committing. A transaction that runs with them is not a transaction. Assert their absence.
>
> Nonce checking must be impossible to forget, which means it is chosen by the call path and never surfaced as a parameter a node-level caller can pass.
>
> Do not bulk-sync state. Reads are on demand; writes are only what changed. The benchmarks package's revm backend does the opposite and is not a model to copy.
>
> Done means: one transfer, on revm, committed, with a receipt and post-state a diff cannot tell apart from ethereumjs's, plus the ADR that records why the node still owns state.
