---
title: A bad createEngine hangs the main thread instead of rejecting, and three smaller edges of the new worker-host
slug: a-bad-createengine-hangs-the-main-thread-instead-of-rejecting
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`make-the-worker-node-proxy-reusable-instead-of-hand-copied` shipped `embedded-eth-node/worker-host` and `exposeNode()`. Gate 2 approved it and found one real defect in the new surface plus three smaller edges.

**1. A misused `createEngine` HANGS the caller rather than failing.** `exposeNode()` calls `createNodeWorkerApi()` BEFORE `expose()`, and the refusal for a `createEngine` that is present but not a function throws from there. So the throw happens during worker module EVALUATION, `expose()` never runs, the worker registers no message listener, and an awaited `createWorkerNode()` on the main thread **never settles**. The consumer sees a hang; the actual message reaches only the worker's console, which in a bundled app is easy to miss entirely.

That is the opposite of what the refusal was added for, and it is squarely against this package's honest-edge convention: a plausible-looking failure with the explanation hidden. An infinite pending promise is worse than the `DataCloneError` the sibling refusal exists to prevent, because it produces no error at all.

Fix it so the misuse reaches the caller. Deferring the validation into the exposed `createNode()` so comlink rejects the main thread's promise is the obvious route, and it is probably right, but weigh it: validating early is genuinely better when it CAN be seen, so an option is to keep the early check AND make the failure observable (still `expose()` an api whose `createNode()` rejects with the recorded reason). Whatever you choose, the main thread must end up with a rejected promise carrying the real message, not a pending one.

**2. The revm worker spec's header describes the OLD recipe.** `test/revm-worker.spec.ts` still says the worker module builds the engine there, calls `createNode({engine})` there and comlink-exposes the node. The helper it drives now calls `exposeNode()`; the spec file was not touched. The prose that explains the recipe is now the only place still describing the superseded one.

**3. Two dead citations in `worker-roundtrip.ts`.** It cites `work/notes/observations/worker-entry-drops-sendermode.md` and (from the earlier spike) `worker-entry-cannot-be-reused-by-a-consumers-own-worker-module.md`. Neither exists; the second was discharged when its signal was carried into the task that produced `worker-host`. Repair them the way this repo repairs a discharged note's citation: name where the reasoning now lives, do not resurrect the file.

**4. The completeness guarantee covers REQUIRED members only.** The typed `nodeProxy` literal and the `Object.keys` parity check together stop a required `SlimNode` field being dropped from the proxy, which was the point. Neither catches an OPTIONAL field added to `SlimNode` later: the annotated literal does not demand it, and it is absent from the reference object the key check iterates. `SlimNode` has no optional members today, so nothing is missed, but the guarantee is narrower than it reads. Either close it or state the limit where the guarantee is documented, so a later author adding an optional field is not misled by it.

## Acceptance criteria

- [ ] A `createEngine` that is present but not a function causes the main thread's `createWorkerNode()` promise to REJECT with the real explanation. It never leaves the caller with a pending promise, and the reason is not confined to the worker console.
- [ ] That failure path is asserted from the main thread, in a browser, on both engines' specs as applicable, so a regression back to the hang is caught.
- [ ] `test/revm-worker.spec.ts`'s header describes the recipe as it now is, via `exposeNode()`.
- [ ] Neither dead citation in `worker-roundtrip.ts` remains; each names where the reasoning now lives.
- [ ] The proxy completeness guarantee either covers an optional `SlimNode` member too, or states plainly that it does not, wherever it is documented.
- [ ] The existing worker suites stay green on Chromium and WebKit, including the revm-in-a-Worker spec, and `worker-entry`'s import-time behaviour is unchanged.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] A changeset if the refusal's observable behaviour changes for a consumer, which item 1 does.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: misusing `createEngine` produces an error the caller can see, instead of a promise that never settles.
>
> FIRST, check this task against current reality: it was written on 2026-08-11 and may have DRIFTED. REPRODUCE the hang before fixing it, from the main thread, and confirm the message really is confined to the worker console.
>
> Read `src/worker-host.ts` end to end and `docs/spikes/make-the-worker-node-proxy-reusable-instead-of-hand-copied/decisions.md`, which records the refusal but not this consequence of where it throws.
>
> Note the ordering constraint that causes this: `expose()` adds a message listener, and a module that throws before reaching it answers nothing at all. Any fix has to leave the worker ABLE to answer, or the main thread has nothing to receive a rejection from.
>
> This package's convention is that a refusal says what happened and what to do about it, and that a plausible-looking failure is worse than a loud one. A hang is the least legible failure available, which is why this is worth a task rather than a note.
