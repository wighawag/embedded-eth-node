---
title: Spike — can revm's synchronous StateStore read the node's own state?
slug: revm-state-adapter-spike
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

Throwaway code that answers ONE question, plus a durable record of the answer. The question:

**Can a `revm-wasm` `StateStore` read the node's authoritative state directly, synchronously, with no state copied across — and if so, at what cost and under which `stateMode`?**

This exists because `revm-engine-subpath` was written assuming the answer is yes, and the assumption does not survive a read of the published package. `revm-wasm@0.1.0`'s `StateStore` says, in its own doc comment: *"`getAccount`, `getStorage`, `getCode` and `getBlockHash` must be **synchronous**. That is not a style preference: the EVM interpreter is a synchronous loop inside wasm, and a state read happens in the middle of an opcode. There is no suspension point to await at. A consumer whose state is behind an async store must pre-load what a call needs (or run the whole thing in a worker with a synchronous view of it)."*

Every read on `SimpleStateManager` and `MerkleStateManager` returns a `Promise`. So the adapter the next task describes cannot be written against the state-manager INTERFACE. There may still be a synchronous path underneath it, and finding out is what this task is for.

Two known shape mismatches to answer at the same time, because they land on the same adapter:

- **Code is keyed differently.** revm asks `getCode(codeHash)`; ethereumjs stores code by ADDRESS. Something has to index codeHash to code, and whatever that is, it is state living outside the node's state manager.
- **Storage clearing.** `clearStorage(address)` must be O(that account). The node's flat address-plus-slot keying is not. The write half is out of scope, but the answer shapes whether the read adapter can be extended later without a redesign.

The deliverable is the ANSWER, not the code. Land it as an ADR in `docs/adr/` (it clears the gate: hard to reverse, surprising without context, a real trade-off), with the measurement and any harness kept under `docs/spikes/revm-state-adapter-spike/`.

## Acceptance criteria

- [ ] A written, evidenced answer to: is there a synchronous read path to the node's state in `stateMode:'none'`, and what exactly is it (which structures, and are they public API or an internal reach-through)?
- [ ] The same answer for `stateMode:'trie'` — including, if it is "no", the shortest honest statement of why, so the next task can refuse that combination loudly rather than discovering it at runtime.
- [ ] A demonstrated `eth_call` executed on `revm-wasm@0.1.0` reading the node's own state with NO state copied in ahead of the call, returning `2446` execution gas for `number()` on the Counter contract — or a written explanation of the specific thing that makes it impossible.
- [ ] The codeHash-to-code question answered: what indexes it, who owns that index, when it is populated, and whether it can go stale.
- [ ] A recommendation for `clearStorage` later: can the read adapter be shaped now so the write half does not require redesigning it?
- [ ] An ADR in `docs/adr/` recording the decision and the trade-off; the harness/measurements under `docs/spikes/revm-state-adapter-spike/`.
- [ ] No change to `packages/embedded-eth-node/src/**` — this task ships an answer, not a feature (it runs in parallel with `engine-seam-with-ethereumjs-default`, which owns those files).
- [ ] No change to any `package.json` or to `pnpm-lock.yaml`: run the harness in scratch space OUTSIDE the repo. A sibling task adds `revm-wasm` to the benchmarks package, and two agents editing the lockfile in parallel conflict for no reason.
- [ ] If the answer is NO — there is no honest synchronous read path — the consequence is stated for the SPEC, not worked around: which user stories become undeliverable as written, and whether the spec needs annotating in place or reopening to re-decompose.

## Blocked by

- None — can start immediately, in parallel with the engine seam.

## Prompt

> Goal: answer one question with throwaway code, then write the answer down and throw the code away.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the published `revm-wasm` version? If `revm-wasm` has moved past `0.1.0` and the `StateStore` contract changed, that IS the answer to part of this question — record it and adjust.
>
> Read `CONTEXT.md` for *engine* and *state mode*, and `docs/adr/0003-revm-wasm-is-the-engine-direction.md` for why revm at all.
>
> THE CRUX. Install `revm-wasm@0.1.0` and read `dist/host.d.ts` before writing anything. `StateStore` has four read methods (`getAccount`, `getStorage`, `getCode`, `getBlockHash`) and five write methods (`setAccount`, `setCode`, `setStorage`, `clearStorage`, `removeAccount`); the reads MUST be synchronous, and a read-only consumer may throw from all five writes. Then read the node's state manager usage: every access is awaited. That gap is the whole task.
>
> The obvious candidate answer is that `SimpleStateManager` exposes `accountStack`, `codeStack` and `storageStack` as public `Map` stacks, which CAN be read synchronously. Verify that, and be honest in the ADR about what it costs: it is a reach past the `StateManagerInterface` into a specific implementation's internals, so the node would be pinned to `SimpleStateManager` for the revm path and would break on an ethereumjs refactor that the type system would not catch. Say whether that is acceptable and what the alternative is (a worker with a synchronous view, a pre-load, or moving state ownership as `revm-engine-behind-runtx` contemplates).
>
> Also check the checkpoint/revert interaction: the node's read path checkpoints the state manager and reverts after each pure call, which pushes and pops a stack frame. A synchronous view has to read the TOP of that stack, not a cached bottom, or a read after a mid-call write sees the wrong value.
>
> Reference numbers, so a wrong answer is obvious rather than plausible: with the Counter contract, `number()` costs 2446 execution gas, `sumTo(2000)` costs 498689, and `keccakLoop(2000)` costs 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`. `@ethereumjs/evm` and `revm-wasm@0.1.0` agree on all of them, so a mismatch means the adapter is feeding revm the wrong state, not that the EVMs differ.
>
> Do NOT hand-roll an outcome decoder: the package returns typed results. Do NOT use `MemoryStore` except as a control to prove the harness itself works before pointing it at the node's state.
>
> Scope fence: touch no file under `packages/embedded-eth-node/src/`. The sibling task `engine-seam-with-ethereumjs-default` owns that tree and runs at the same time.
>
> A NO IS A RESULT, not a failure. If the synchronous path does not exist honestly, say so plainly and say what it costs: `revm-engine-subpath` would then be premised on a false assumption, and stories 2, 4, 5, 6, 8 and 11 of the spec have no delivering task in their current form. Route that as a drift signal against the spec (WORK-CONTRACT.md, "Drift is a needs-attention signal") rather than inventing a workaround that quietly changes what the feature is. A cheap no here is worth far more than an expensive maybe later.
>
> Scratch discipline: transient build scratch and throwaway installs belong outside the repo. Land only the ADR and whatever measurement artifacts are worth keeping under `docs/spikes/revm-state-adapter-spike/`.
>
> Done means: `revm-engine-subpath` can be rewritten from a known answer instead of an assumption, and the reason is written down where the next reader will find it.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
