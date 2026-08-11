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

Fix it so the misuse reaches the caller. **The maintainer's steer (2026-08-11) is that the errors should be NICE: whoever made the mistake should read a message that names it and says what to do, from the thread they made it on.** That resolves the fork this task originally left open in favour of keeping BOTH signals rather than moving the check: keep validating early, where a developer with the worker console open sees it immediately, AND make the failure observable to the main thread by still calling `expose()` with an api whose `createNode()` rejects carrying the recorded reason. Simply deferring the validation into `createNode()` also fixes the hang, but it trades away the early signal, and there is no need to pay that.

The bar is that neither thread is left guessing: the main thread's promise REJECTS with the real explanation rather than pending forever, and the worker still says something at the moment the mistake is made. Match the voice of this package's other refusals, which name what happened, what was expected, and what to do about it.

**2. The revm worker spec's header describes the OLD recipe.** `test/revm-worker.spec.ts` still says the worker module builds the engine there, calls `createNode({engine})` there and comlink-exposes the node. The helper it drives now calls `exposeNode()`; the spec file was not touched. The prose that explains the recipe is now the only place still describing the superseded one.

**3. Two dead citations in `worker-roundtrip.ts`.** It cites `work/notes/observations/worker-entry-drops-sendermode.md` and (from the earlier spike) `worker-entry-cannot-be-reused-by-a-consumers-own-worker-module.md`. Neither exists; the second was discharged when its signal was carried into the task that produced `worker-host`. Repair them the way this repo repairs a discharged note's citation: name where the reasoning now lives, do not resurrect the file.

**4. The completeness guarantee covers REQUIRED members only.** The typed `nodeProxy` literal and the `Object.keys` parity check together stop a required `SlimNode` field being dropped from the proxy, which was the point. Neither catches an OPTIONAL field added to `SlimNode` later: the annotated literal does not demand it, and it is absent from the reference object the key check iterates. `SlimNode` has no optional members today, so nothing is missed, but the guarantee is narrower than it reads. Either close it or state the limit where the guarantee is documented, so a later author adding an optional field is not misled by it.

## Acceptance criteria

- [ ] A `createEngine` that is present but not a function causes the main thread's `createWorkerNode()` promise to REJECT with the real explanation. It never leaves the caller with a pending promise, and the reason is not confined to the worker console.
- [ ] The worker side ALSO still reports the mistake at the moment it is made, so the early signal is kept rather than traded for the late one.
- [ ] The message names what was expected and what to do, in the voice of this package's other refusals, and is legible to someone who has never read this source.
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

## Requeue 2026-08-11

RECOVERY HANDOFF (2026-08-11, conductor). The previous run COMPLETED this work; it was lost to a disk-full failure in the runner's own commit step, not to anything wrong with the approach. Nothing of it survives on the branch, so build it again, but do not re-derive the design: it was reviewed and it was right.

The shape that worked: make the createEngine refusal a VALUE, not control flow. exposeNode() must still call expose() so comlink's message listener is registered, and createNode() then rejects with the recorded message, which crosses the boundary as a rejection the main-thread caller can read. A throw before expose() is exactly what causes the hang, because the worker then answers nothing at all. Keep the worker-side signal too, so both threads say something.

Detect the promise case specifically: typeof value?.then === 'function' means the caller wrote createEngine: await createRevmEngine({wasm}) instead of createEngine: () => createRevmEngine({wasm}), and the message should say precisely that, naming both forms.

A HARD LIMIT you must document rather than engineer away, measured on Chromium and WebKit and now landed at work/notes/observations/a-top-level-await-in-a-worker-module-loses-the-first-message.md: a top-level await in a worker module before exposeNode() loses the main thread's FIRST message, so createWorkerNode() hangs regardless of what the refusal does. Nothing in worker-host can fix it, since there is no listener to register before the consumer's module gets that far. Test the promise form rather than the await form for that reason, and say so on the exposeNode doc comment and the README Worker section, which is where a consumer would look.
