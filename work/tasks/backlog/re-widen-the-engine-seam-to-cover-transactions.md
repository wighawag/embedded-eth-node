---
title: Re-widen the engine seam to cover transactions, with no behaviour change
slug: re-widen-the-engine-seam-to-cover-transactions
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

The node has ONE seam for reads and a HARDCODED path for writes: an injected object implements `ReadEngine` and answers `eth_call`, while transactions bypass it entirely and go straight to `@ethereumjs/vm`'s `runTx`. That asymmetry is invisible while the write half does not exist, and it is what this whole spec has to remove. Do it FIRST, as a pure refactor, so the change that adds a second EVM is not also the change that reshapes the seam.

The seam becomes ONE interface with two operations: execute a read-only call, and execute a committing transaction. The default `@ethereumjs/evm` engine implements BOTH, its transaction operation wrapping `runTx`, and the node's mining path always goes through the engine rather than calling `runTx` itself. Nothing about behaviour, gas, receipts, logs or errors moves. The node's own reporting follows the widening, so a consumer can ask which EVM is behind the node rather than which EVM is behind its reads.

**Why one interface rather than an optional capability.** The read and write paths differ in their VALIDITY rules, not in their engine-ness: the read path relaxes a transaction's validity (base fee, block gas limit, EIP-3607) and cannot commit, while the transaction path relaxes nothing. That asymmetry belongs to the two OPERATIONS, and stating it in one place where both are visible is clearer than splitting it across two interfaces. A capability-optional design would also multiply node configurations (reads on one EVM, writes on another, two identifiers that can disagree) for no gain. There are no third-party engines to break.

`CONTEXT.md`'s glossary already anticipated this and wrote down the condition: its *engine* entry says not to re-widen the term to mean "the EVM behind the node" **until a spec actually moves transactions onto it**. That spec is `revm-engine-behind-runtx`, so the condition is met and the entry is updated to say so rather than being quietly rewritten.

**The result type is the interesting part, and it is where the value of this task is.** Mapping `runTx`'s result into a neutral, engine-independent shape (status, gas used, logs in emission order, the bloom, any created address, the effective gas price) is what makes two engines COMPARABLE field by field. Design that shape for what a receipt needs, not for what ethereumjs happens to return, because the next task fills it from a completely different source. Keep block-level concerns (block construction, `cumulativeGasUsed`, the RPC layer, transaction parsing and signature recovery) OUT of the seam: they stay the node's, exactly as they are today.

Keep the read operation's existing guarantees intact: it still cannot commit, it still carries the simulation switches, and the engine still refuses `stateMode:'trie'` and a second `connect`.

## Acceptance criteria

- [ ] One engine interface covers both operations; the default `@ethereumjs/evm` engine implements both, with its transaction operation wrapping `runTx`.
- [ ] The node's mining path executes transactions THROUGH the engine; no direct `runTx` call remains on it.
- [ ] The transaction result crossing the seam is engine-independent (status, gas used, logs in emission order, logs bloom, created address, effective gas price) and carries no ethereumjs-shaped types.
- [ ] Block construction, `cumulativeGasUsed`, receipt assembly, the RPC layer, transaction parsing and sender recovery are unchanged and remain the node's.
- [ ] The node reports the engine behind it under the widened name, and the old read-only name is gone rather than aliased.
- [ ] `CONTEXT.md`'s *engine* glossary entry is re-widened, and says that the condition it set for re-widening (a spec that moves transactions onto the engine) was met by this one.
- [ ] The engine's existing refusals are untouched: `stateMode:'trie'` at construction, a second `connect`, a non-engine object, an engine whose `connect` throws, and the hardfork refusals.
- [ ] NO behaviour change anywhere: the full conformance differential, the state tests, the trusted-sender, persistence, worker and viem-surface suites all pass unchanged, and the reference gas is identical (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`).
- [ ] A changeset. This renames a published type and a returned property with no deprecation alias, which is a breaking change on the package's public surface even though nothing depends on it yet.
- [ ] If the bundle-size assertion in the benchmarks package moves, the baseline is re-pinned in the same change with the reason in its comment block.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: give the node ONE engine seam that covers reads AND transactions, with the default engine implementing both, and change no behaviour whatsoever. Every later task in this spec builds on the shape you choose here.
>
> Read `CONTEXT.md`'s *engine* and *read engine* vocabulary first (its glossary entry names the exact condition under which the term should be re-widened, and this spec is that condition), then the engine seam and its refusals, the node's mining path where `runTx` is called, and `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md`.
>
> THE DELIVERABLE IS THE RESULT TYPE. Designing the neutral transaction result is the real work: it is what lets a second EVM be compared with `@ethereumjs/vm` field by field, and the next task fills exactly this shape from a wasm outcome blob rather than from an ethereumjs object. Design it for what a RECEIPT needs. If a field only exists because `runTx` returns it, it does not belong.
>
> DO NOT MOVE ANY BEHAVIOUR. This task is a refactor and its bar is that the entire existing suite passes unchanged, including the reference gas numbers. If a test needs editing to pass, you have changed behaviour and should stop and reconsider rather than edit the test.
>
> Do not carry the read path's simulation switches anywhere near the transaction path; the next tasks depend on transactions running with full validation. Do not weaken any existing refusal.
>
> There are no consumers, so break the name rather than aliasing it: a compatibility shim here would outlive its usefulness immediately and would leave two words for one concept.
