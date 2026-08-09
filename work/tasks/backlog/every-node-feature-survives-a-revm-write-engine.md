---
title: dumpState, loadState, persistence and the evm_set* cheats survive a revm write engine, unedited
slug: every-node-feature-survives-a-revm-write-engine
spec: revm-engine-behind-runtx
blockedBy: [eip-2930-access-lists-are-charged-and-warmed]
covers: [13]
---

## What to build

Story 13 is a REGRESSION bar, and the way to honour it is to change nothing and prove it. Adopting revm must cost a consumer none of the node's existing features: `dumpState`, `loadState`, IndexedDB persistence and the `evm_set*` cheats all keep working exactly as they do today, because state ownership never left the node and the engine reads it through host callbacks.

So run the EXISTING suites with a revm engine installed: persistence-reload, genesis-cheats, and the dump/load paths. **If any of them needs editing to pass, the state-ownership decision was implemented wrongly** and the right response is to fix the implementation, not the test. That sentence is the acceptance criterion; treat an edit to those tests as a failure signal rather than as progress.

Two interactions deserve their own cases because they are where "state is still ours" gets tested for real, both involving a WRITE now:

- A cheat applied BETWEEN two revm-executed transactions must be visible to the second one. The engine reads on demand through the callbacks, so a mutation the node makes directly is picked up on the next access; if it is not, something is caching state across a transaction boundary, which is the thing the design forbids.
- A `dumpState` taken after a revm-executed transaction, reloaded into a fresh node, must reproduce the same state, and a subsequent transaction on that reloaded node must behave identically. That is the round trip a persisted browser session actually performs.

## Acceptance criteria

- [ ] The existing persistence-reload, genesis-cheats and dump/load suites pass with a revm engine installed, UNEDITED. Any edit required to those suites is treated as a defect in the implementation and fixed there.
- [ ] A cheat (`evm_setStorageAt`, `evm_setBalance`, `evm_setCode`, `evm_setNonce`) applied between two revm-executed transactions is visible to the second, asserted.
- [ ] `dumpState` after a revm-executed transaction, reloaded into a fresh node, reproduces the state, and a following transaction on the reloaded node produces the same receipt and post-state as on the original.
- [ ] `dumpState` output is byte-identical between the two engines for the same sequence of transactions.
- [ ] No feature acquires an engine-conditional code path: the node's state-facing surface does not know which engine is installed.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- `eip-2930-access-lists-are-charged-and-warmed` — the write path should be complete before it is regression-tested against every feature.

## Prompt

> Goal: prove that adopting revm costs a consumer nothing they already had, by running the tests that already exist and changing none of them.
>
> Read the persistence-reload, genesis-cheats and dump/load suites, and the state-ownership ADR written earlier in this spec (the node owns state; the engine reads and writes it through host callbacks).
>
> AN EDIT TO THOSE SUITES IS A FAILURE SIGNAL. They encode today's behaviour, and today's behaviour is what story 13 promises. If one fails, the interesting question is which implementation assumption it caught, not how to make it green.
>
> The two cases worth adding are both about a WRITE crossing a boundary: a cheat applied between two revm transactions must be seen by the second, and a dump taken after a revm transaction must reload and keep behaving. Both fail loudly if anything cached state across a transaction, which is precisely what this design forbids.
>
> Done means: the old suites green untouched, and the two new round trips green on both engines.
