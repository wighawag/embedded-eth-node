# Decisions taken while making the Worker node proxy reusable

The task (`make-the-worker-node-proxy-reusable-instead-of-hand-copied`) fixed the shape but deliberately left the naming and the exact form to the build, and the README half was an explicit "decide deliberately". This is where those choices are recorded, since the done record is moved byte-identical by the runner. Ratify or reverse.

What shipped, in one line: `src/worker-host.ts` holds the ONE `SlimNode` proxy plus `exposeNode()` / `createNodeWorkerApi()`; `src/worker-entry.ts` is now that module plus its import-time `expose()` and nothing else; `src/worker-client.ts` lost the `as any` casts that used to hide a dropped field from the compiler.

## 1. A NEW subpath (`embedded-eth-node/worker-host`), not a new export on `worker-entry`

**Chosen:** the api lives in a new module published as `embedded-eth-node/worker-host`, and `worker-entry` imports it and exposes it. `worker-entry` keeps exporting `workerApi` (now the object `exposeNode()` returned) and the `WorkerApi` type (now an alias of `NodeWorkerApi`), and still calls `expose()` at import time, so `import 'embedded-eth-node/worker-entry'` is untouched for consumers.

**Why:** the whole defect is that `worker-entry`'s `expose()` is a MODULE-SCOPE side effect, so importing it to reuse anything exposes the DEFAULT api on the importing thread; comlink's `expose()` adds a message listener, so a consumer who then exposed their own api would have two listeners answering the same message. A side effect cannot be imported, so the reusable half has to be a module without it. That is also why the task's own sketch (`import {exposeNode} from 'embedded-eth-node/worker-entry'`) could not be taken literally.

**Rejected:** making the side effect conditional (on `self instanceof WorkerGlobalScope`, or an env flag) so one module could serve both. It makes the published behaviour depend on where it is imported from, which is the opposite of the honest-edge convention, and it would have changed what `worker-entry` does for existing consumers. Also rejected: `./worker-node` and `./worker` as names, the first because *node* already means the thing being hosted and the second because it says nothing.

**The name checked against the glossary:** *worker host* is new and does not re-mean anything. `CONTEXT.md` and the README already call this "optional Web-Worker hosting", `worker-entry` keeps meaning the ready-made entry point, and `worker-client` keeps meaning the main-thread half. `CONTEXT.md` gains a *worker host* entry saying exactly that.

**What it touches:** the published export map (`package.json` `exports` gains `./worker-host`), the README's Worker section and its revm Worker bullet, and `worker-client`'s type import (it now imports `NodeWorkerApi` from `worker-host`, which is more honest: the client drives ANY worker exposing that api, including a consumer's).

## 2. The option is `createEngine`, a FACTORY, and passing a built engine is refused with a real error

**Chosen:** `exposeNode({createEngine: () => createRevmEngine({wasm})})`. The supplier may return a promise, is called ONCE PER `createNode()` call, and a `createEngine` that is present but not a function throws at `createNodeWorkerApi()` naming what to pass instead.

**Why the factory:** building an engine is async, and this way the await belongs to `createNode()`'s own await rather than to the consumer's module top level. More structurally, one engine instance serves one node (`connect()` binds it, and a connected engine handed to a second `createNode()` throws), so an engine VALUE here would work for the first node this worker was asked for and fail for the second.

**Why the name is not `engine`:** `NodeOptions.engine` is an `Engine` everywhere else in this package, and ADR 0006's whole point is that an engine is an OBJECT. One word meaning "an engine" in one place and "a function that makes one" in another is how the wrong value gets passed. `createEngine` matches `createNode` / `createRevmEngine` and reads as what it is. The task's sketch used `engine: () => ...` and explicitly said to treat it as intent.

**Why the refusal, which is a NEW user-visible error:** passing the engine where its factory belongs is the one plausible mistake, and a TypeScript consumer is stopped by the type. For a JS consumer the alternative was a `TypeError: createEngine is not a function` from inside `createNode`, which names nothing. The message says this thread builds one engine per node and shows both forms. This is the repo's honest-edge convention applied to a new option.

**Rejected:** accepting `Engine | EngineSupplier` and normalising. It admits the shape that breaks on the second node, silently, which is the failure the factory exists to prevent.

**What it touches:** nothing existing. `createEngine` is a brand-new option on a brand-new export. `createWorkerNode({engine})` is still refused on the main thread exactly as before, with its existing message updated to point at `exposeNode` instead of a hand-rolled `expose({...})` snippet.

## 3. The recurrence is prevented by the TYPE, and the runtime check names no field

**Chosen:** two mechanisms, neither of which enumerates today's fields.

- The one proxy (`nodeProxy` in `src/worker-host.ts`) is a literal annotated `SlimNode`, so a field added to `SlimNode` later stops the BUILD here. Verified by deleting `senderMode` from it: `error TS2741: Property 'senderMode' is missing ... but required in type 'SlimNode'`.
- `src/worker-client.ts`'s `(remote as any).stateMode` / `.senderMode` / `.engine` casts are gone, along with the other `as any`s on that path. That cast is what hid the original omission from the compiler; the remote is a `SlimNode`, so the reads are checked.
- `test/helpers/worker-roundtrip.ts` additionally compares the Worker-backed node against a main-thread `createNode()` FIELD BY FIELD (`Object.keys` of the reference, each present across the boundary with the same `typeof`) and `worker.spec.ts` asserts the gap list is empty. Verified by deleting `senderMode` from the proxy through a cast: `shapeGaps: ["senderMode: absent across the boundary"]`.

**Why the third one too, when the first two are compile-time:** a consumer writing their own worker module in plain JS gets nothing from types, but they no longer write a proxy at all, which is the real fix. The runtime check earns its place by covering the client's own hand-written literal and the comlink wiring, in the browsers this package actually ships to, for any future field.

**Rejected:** the parity assertion between the three copies (the task's own rejected alternative, and there is now one copy rather than three); a mapped type cleverer than `SlimNode` (there is nothing to widen: the proxy's job is to BE the node).

## 4. The README's pointer is resolved by INLINING the recipe, not by shipping test files in the tarball

**Chosen:** the worker module is now four lines, so the README shows the whole thing inline (twice: a new "A Worker that builds its own engine" section, and the revm caveat bullet). The text now says explicitly that `test/helpers/revm-worker.ts` and `test/revm-worker.spec.ts` are files in the REPOSITORY (linked to GitHub) that execute those lines on every run, not files in your `node_modules`. `package.json`'s `files` is unchanged.

**Why:** the criterion is that the pointer is either backed by a file the published package contains or unambiguously a repository reference. Inlining removes the need for either: nothing tells a reader to fetch a file any more, because the file is smaller than the sentence pointing at it, which is the point of the export. Adding `test/` to `files` would publish test helpers to every consumer to make one four-line file reachable, and would make the tarball's contents depend on a doc link.

**Rejected:** rewriting every relative repo link in the README to absolute GitHub URLs (out of scope, and `docs/spikes/` links are reference material a reader browses, exactly the case the task said may stay as it is).

**What it touches:** the README only. The published surface change is the new subpath, covered by the changeset.

## Not changed, deliberately

- `packages/benchmarks/test/evm.spec.ts`'s bundle baseline. The default entry point (`import {createNode} from 'embedded-eth-node'`) does not reach `worker-host` (`src/index.ts` re-exports no worker helper, precisely so comlink stays out of the core bundle), so the baseline is neither moved nor re-pinned. Confirmed by running the gate.
- Reference gas: unchanged, and still measured THROUGH the Worker by `test/revm-worker.spec.ts` (2446 / 498689 / 1107052 and the keccak hash), with the engine identity and the `stateMode:'trie'` refusal still proving revm ran there.
