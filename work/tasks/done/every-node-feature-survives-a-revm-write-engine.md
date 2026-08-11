---
title: dumpState, loadState, persistence and the evm_set* cheats survive a revm write engine, unedited
slug: every-node-feature-survives-a-revm-write-engine
spec: revm-engine-behind-runtx
blockedBy: [eip-2930-access-lists-are-charged-and-warmed]
covers: [13]
---

## What to build

Story 13 is a REGRESSION bar, and the way to honour it is to change nothing and prove it. Adopting revm must cost a consumer none of the node's existing features: `dumpState`, `loadState`, IndexedDB persistence and the `evm_set*` cheats all keep working exactly as they do today, because state ownership never left the node and the engine reads it through host callbacks.

So run the EXISTING suites with a revm engine installed: persistence-reload, genesis-cheats, and the dump/load paths.

**Be precise about what "unedited" means, because those suites cannot currently take an engine at all.** `persistence-reload.ts` and `genesis-cheats-perf.ts` call `createNode()` with no engine option anywhere, so parameterising them IS the task, not a violation of it. Two kinds of edit, and only one is allowed:

- **Parameterisation is EXPECTED**: threading an engine factory through so each suite can run twice, once on the default engine and once on revm, following the precedent set when the conformance battery was pointed at revm (which needed both a factory parameter and its own bundle entry, so budget for that shape rather than a one-line change).
- **An ASSERTION edit is a FAILURE SIGNAL**: if a suite's expectations have to change to pass on revm, the state-ownership decision was implemented wrongly and the fix belongs in the implementation, not the test. That is the sentence to hold on to.

That distinction triples this task's real size relative to "run the tests", and it is why it is its own task rather than a criterion on another one.

Two interactions deserve their own cases because they are where "state is still ours" gets tested for real, both involving a WRITE now:

- A cheat applied BETWEEN two revm-executed transactions must be visible to the second one. The engine reads on demand through the callbacks, so a mutation the node makes directly is picked up on the next access; if it is not, something is caching state across a transaction boundary, which is the thing the design forbids.
- A `dumpState` taken after a revm-executed transaction, reloaded into a fresh node, must reproduce the same state, and a subsequent transaction on that reloaded node must behave identically. That is the round trip a persisted browser session actually performs.

## Acceptance criteria

- [ ] The existing persistence-reload, genesis-cheats and dump/load suites run on BOTH engines, and their ASSERTIONS are unchanged. Parameterising them by engine is expected work; changing what they assert is a defect to be fixed in the implementation instead.
- [ ] Each of those suites is parameterised rather than duplicated, following the conformance battery's precedent, and continues to run on the default engine as it does today.
- [ ] A cheat (`evm_setStorageAt`, `evm_setBalance`, `evm_setCode`, `evm_setNonce`) applied between two revm-executed transactions is visible to the second, asserted.
- [ ] `dumpState` after a revm-executed transaction, reloaded into a fresh node, reproduces the state, and a following transaction on the reloaded node produces the same receipt and post-state as on the original.
- [ ] `dumpState` output is EQUIVALENT between the two engines for the same sequence of transactions, compared structurally (same accounts, same code, same slots, same values) rather than byte for byte: the serialised key order follows insertion order, which follows each engine's write order, and the two engines legitimately write in different orders (revm's account changes arrive sorted by address, ethereumjs writes in touch order). A byte comparison would fail on a correct implementation the moment a transaction creates two accounts.
- [ ] No feature acquires an engine-conditional code path: the node's state-facing surface does not know which engine is installed.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- `eip-2930-access-lists-are-charged-and-warmed` — the write path should be complete before it is regression-tested against every feature.

## Prompt

> Goal: prove that adopting revm costs a consumer nothing they already had, by running the tests that already exist and changing none of them.
>
> FIRST, check this task against current reality: it was written on 2026-08-09 and may have DRIFTED. Confirm those suites still exist under the names this task assumes and that an earlier task in this spec has not already edited them; an edit that already happened is itself the finding.
>
> Read the persistence-reload, genesis-cheats and dump/load suites, and the state-ownership ADR written earlier in this spec (the node owns state; the engine reads and writes it through host callbacks).
>
> AN ASSERTION EDIT IS A FAILURE SIGNAL, but PARAMETERISATION IS THE JOB. Those suites cannot take an engine today, so you will be threading a factory through them; that is expected. What is not expected is changing what they ASSERT. If an expectation has to move to pass on revm, the interesting question is which implementation assumption it caught, not how to make it green.
>
> Do not compare `dumpState` output byte for byte across engines. Key order follows write order and the two engines write in different orders; compare structurally.
>
> The two cases worth adding are both about a WRITE crossing a boundary: a cheat applied between two revm transactions must be seen by the second, and a dump taken after a revm transaction must reload and keep behaving. Both fail loudly if anything cached state across a transaction, which is precisely what this design forbids.
>
> Done means: the old suites green untouched, and the two new round trips green on both engines.
