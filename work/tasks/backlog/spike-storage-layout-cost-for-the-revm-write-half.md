---
title: Spike — what does the flat storage layout actually cost, and what would a per-account layout buy?
slug: spike-storage-layout-cost-for-the-revm-write-half
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

Throwaway code that answers ONE question with NUMBERS, plus a durable record of the answer. The question:

**What does `SimpleStateManager`'s flat `${address}_${slot}` storage map cost this node today, and what would a per-account layout (`Map<address, Map<slot, value>>`) with copy-on-write checkpoints buy or cost instead?**

`revm-engine-behind-runtx` cannot be tasked until this is settled, because the answer shapes four of its user stories (2 post-state equality, 3 the fee write-back, 13 dumpState/loadState/persistence/cheats, 16 host callbacks rather than bulk sync). The spec says the ownership question must be decided BEFORE any task is cut, and the repo's own rule is that a question like this is measured rather than argued.

**The ownership question is already answered and is NOT re-opened here.** State ownership stays on the JS side: that is what lets both engines run against identical state (so the conformance differential can compare them in place), keeps a JS-only fallback working when the wasm fails to load, and preserves the `@ethereumjs/mpt`-over-authoritative-state route to a state root. This spike measures what the LAYOUT costs under that decision. If the numbers contradict the decision, say so loudly rather than quietly re-deciding.

### What is already known, so you do not re-derive it

Read these first; they are the reason this spike exists and they are not in dispute.

- `revm-wasm`'s `StateStore` declares `clearStorage(address): void` with "Must be O(that account)", and its `MemoryStore` doc records that the flat layout was tried in the original spike and "knowingly shipped broken" for exactly this reason. Its commit semantics call `clearStorage` on SELFDESTRUCT, on EIP-161 empty-account clearing, AND on every contract creation.
- `src/state-manager.ts`'s `clearStorage` override is a prefix scan, O(total slots). ADR 0007's "Cost" section records it.
- `src/revm-state-store.ts`'s `#storageOf(addressKey)` is the only place the READ adapter builds a flat key, shaped that way on purpose by ADR 0005.
- Measured already, in `revm-engine-behind-runtx`'s Further Notes: a boundary crossing is paid once per COLD state access (callbacks track EIP-2929 one for one), at roughly 1.3 microseconds, of which about 60% is JS-side hex key construction (a 104-character string per access) rather than the crossing itself.

### The four questions to answer with measurements

**Q1. What does the CHECKPOINT actually cost today?** This is the one nobody has counted, and it may be the whole answer. `SimpleStateManager.checkpointSync()` does `this.storageStack.push(new Map(this.topStorageStack()))`, a full shallow copy of the ENTIRE flat storage map, and `@ethereumjs/evm` checkpoints per message frame. Measure, at realistic state sizes (at least 1k, 10k and 100k slots): the cost of one checkpoint, and the number of checkpoints incurred by (a) one `eth_call` through the node's read path, (b) one ordinary transaction, and (c) one transaction with nested calls. Report the per-transaction total, not just the per-checkpoint figure.

**Q2. What does `clearStorage` cost today, and how often is it really called?** Measure the prefix scan at the same state sizes, and count the calls a realistic transaction mix produces. Remember a CREATE triggers one, so "rare" is an assumption to test rather than to repeat.

**Q3. What would the per-account layout with copy-on-write actually change?** Prototype it (under `docs/spikes/`, NOT in `src/`) as a `SimpleStateManager` subclass or standalone equivalent that stores `Map<address, Map<slot, value>>` and, on checkpoint, copies the OUTER map only, deferring an inner-map copy until a frame first writes to that account. A plain `new Map(outer)` shares the inner maps and would leak a child frame's writes into the parent, so the copy-on-write part is the design, not an optimisation. Measure the same three things: checkpoint, `clearStorage`, and a per-slot read and write. Include the pathological case for copy-on-write (a transaction that writes one slot each across many accounts).

**Q4. How much of the 1.3 microseconds is the string?** The per-account layout replaces `prefix + slotHex` concatenation with two map lookups. Measure a cold state access both ways and say what fraction of the claimed 60% is genuinely recovered. This is independently useful: if it is most of the cost, it is a cheap win the write half can bank early.

### What to report beyond the numbers

- **The blast radius, checked rather than assumed.** ADR 0005 says the layout can be swapped "behind that one accessor, and only the accessor changes". Verify or refute that. Four places know the flat key format: `SimpleStateManager.getStorage/putStorage` upstream, our `clearStorage` override, `revm-state-store.ts`'s `#storageOf`, and `node.ts`'s `dumpState`, which parses the key back apart with `indexOf('_')`. State plainly whether re-layering is possible without replacing `SimpleStateManager`'s own storage representation, and if it is not, say what replacing it entails (which methods, what the checkpoint/commit/revert contract becomes, and what breaks if upstream changes).
- **The recommendation `revm-engine-behind-runtx` needs**, in one paragraph a tasker can act on: re-layer, or keep the flat map and pay the cost, or a third shape the numbers suggest. Name what you would NOT do and why.
- **Whether upstream is the right home.** We already carry a `SimpleStateManager` subclass because of an upstream bug that is filed and fixed. If the honest fix here is also upstream's, say so, with the same reasoning ADR 0007 used to decide subclass-versus-patch (we are a library; a patch fixes only our own test runs).

## Acceptance criteria

- [ ] `docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/measurements.md` records real, re-runnable measurements for Q1 to Q4, at the stated state sizes, with the machine and conditions noted and every number produced by a committed probe rather than quoted from reasoning.
- [ ] The probe(s) live under the same folder and run standalone (`node probe-*.mjs` or equivalent), the way the existing spike probes do.
- [ ] The copy-on-write per-account prototype exists under `docs/spikes/`, is exercised by the probe, and its correctness is demonstrated at least against checkpoint/revert (a write in a reverted frame does not survive) and commit (a write in a committed frame does), because a faster wrong layout is worth nothing.
- [ ] The blast-radius question is answered explicitly: can the layout change behind `#storageOf` alone, or must `SimpleStateManager`'s storage representation be replaced? List every site that would change.
- [ ] A one-paragraph recommendation a tasker can act on, plus what you would not do and why.
- [ ] NO change to `packages/embedded-eth-node/src/**`, no change to any `package.json` or `pnpm-lock.yaml`, and no new dependency: this ships an answer, not a feature.
- [ ] Reference gas is unchanged and untouched: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] If any measurement contradicts the standing decision that state ownership stays on the JS side, that is REPORTED as the headline finding rather than acted on.

## Blocked by

- None.

## Prompt

> Goal: answer one question with throwaway code and numbers, then write the answer down. `revm-engine-behind-runtx` is blocked on it.
>
> MEASURE, DO NOT ARGUE. Every number in the deliverable must come from a committed probe someone else can re-run. If you find yourself reasoning about what a `Map` copy costs, stop and measure it. A plausible number is worse than no number here, because the next decision rests on it.
>
> Read, in this order: `work/specs/ready/revm-engine-behind-runtx.md` (State ownership, and the Further Notes measurements), `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md`, `docs/adr/0007-we-override-simplestatemanagers-no-op-clearstorage.md`, `packages/embedded-eth-node/src/state-manager.ts`, `src/revm-state-store.ts`, the `'none'` branch of `dumpState` in `src/node.ts`, and `SimpleStateManager.checkpointSync` in `@ethereumjs/statemanager` itself.
>
> THE CRUX IS Q1, and it is the one the spec did not know about. `checkpointSync` copies the WHOLE storage map, and the EVM checkpoints per message frame, so the flat layout may be costing a full-map copy several times per transaction rather than a prefix scan on a rare `clearStorage`. If that is true, it changes which fix matters. If it is false, say why.
>
> The per-account prototype must be COPY-ON-WRITE. A shallow copy of the outer map shares the inner maps, so a child frame's write would leak into the parent and a revert would not undo it. Demonstrate the checkpoint/revert and commit semantics hold before you report a single timing number.
>
> DO NOT re-open state ownership. It is decided: the node keeps owning state, because that is what lets both engines run against identical state, keeps the JS-only fallback alive, and preserves the route to a state root. Measure the layout under that decision, and if the numbers contradict it, report that as the headline rather than quietly re-deciding.
>
> Scope fence: nothing under `packages/embedded-eth-node/src/`, no dependency changes, no lockfile churn. The prototype is spike code and stays in `docs/spikes/`.
