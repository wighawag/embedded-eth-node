# Decisions taken while making a misused `createEngine` reject instead of hang

Task: `a-bad-createengine-hangs-the-main-thread-instead-of-rejecting`. The done record is moved byte-identical by the runner, so the choices live here. Ratify or reverse.

What shipped, in one line: the `createEngine` refusal in `packages/embedded-eth-node/src/worker-host.ts` is now a recorded VALUE (reported on the worker thread at construction, re-thrown from `createNode()` so it crosses comlink as a rejection) instead of a throw during worker-module evaluation, and the misuse is asserted from the main thread on both engines.

## 0. The hang, reproduced before it was fixed

Measured on Chromium with `test/helpers/misused-engine-worker.ts` (a worker module passing an engine-shaped object where the factory belongs) driven by `test/helpers/engine-misuse.ts`, BEFORE the production change:

```
"mainThread": { "outcome": "NEVER_SETTLED", "message": "", "elapsedMs": 10000 }
"early":      { "reported": "", "threw": "embedded-eth-node/worker-host: `createEngine` must be a FUNCTION ..." }
```

So the premise held exactly as the task described it: the refusal fired (the message existed, in the worker, at module-evaluation time), `expose()` was never reached, and the main thread's `createWorkerNode()` was given nothing at all. `outcome` is a three-way classification (`REJECTED` / `DID_NOT_THROW` / `NEVER_SETTLED`) rather than a `try`/`catch`, because the failure under test is the absence of an event and a plain timeout would report it as "the test was slow".

After the change, same driver: `outcome: "REJECTED"` in 58 ms, message intact, and the worker still reported it at construction (`threw: "DID_NOT_THROW"`, `reported: <the message>`).

## 1. The refusal is a VALUE, and BOTH threads are told

**Chosen:** `createNodeWorkerApi()` computes the refusal message, `console.error`s it immediately, and stores it; `createNode()` throws it. `exposeNode()` therefore always calls `expose()`, so the worker can always answer.

**Why:** comlink's `expose()` registers the message listener. Anything that throws BEFORE it leaves the worker unable to answer any message, which is what turned a refusal into a pending promise on the main thread. Keeping the early `console.error` keeps the signal a developer with the worker console open sees at load time; adding the rejection means a consumer who never opens that console still gets the reason. The maintainer's steer (2026-08-11) was explicit that both are kept rather than one traded for the other.

**Rejected:** moving the validation INTO `createNode()` only. It fixes the hang identically and costs the early signal, and there was no reason to pay that. Also rejected: `postMessage`ing the reason to the main thread by hand (a second, bespoke channel next to comlink's, which the client would have to grow a listener for).

**What it touches:** a user-visible behaviour change for anyone who already misuses `createEngine` (it used to throw synchronously from `createNodeWorkerApi()` / `exposeNode()`, and now those return normally and the failure surfaces at `createNode()`). Covered by a changeset. `createNodeWorkerApi()` is also the composition point for a consumer building a larger exposed api; they see the same shift.

## 2. The message has a PROMISE branch

**Chosen:** two messages. A thenable `createEngine` is told it was CALLED rather than passed, and shown `() => createRevmEngine({wasm})` against `createRevmEngine({wasm})`. Anything else non-function is told this thread builds one engine PER NODE, with the received kind named (`an object`, `a string`, ...).

**Why:** the promise case is the mistake a revm consumer actually makes (the parentheses are already there, so dropping the arrow reads harmless), and "must be a function" describes a value that is one arrow from correct without saying so. The package's convention is that a refusal names what happened, what was expected, and what to do.

**What it touches:** the refusal text only. Both branches are asserted, in different bundles: the object branch in `test/worker.spec.ts` (default engine), the promise branch in `test/revm-worker.spec.ts` (revm, where it is the real typo).

## 3. The top-level-`await` hazard is DOCUMENTED, not engineered away

**Chosen:** the promise message warns against `await createRevmEngine({wasm})` as a repair, and the hazard is stated on the `exposeNode` doc comment and in the README's Worker section. The `await` form is deliberately NOT the form the test exercises.

**Why:** a worker module that awaits anything slower than a microtask before `exposeNode()` can lose the main thread's first message, so `createWorkerNode()` hangs whatever the refusal does (measured on Chromium and WebKit: `work/notes/observations/a-top-level-await-in-a-worker-module-loses-the-first-message.md`). Nothing in `worker-host` can fix it, since there is no listener to register before the consumer's module gets that far. Testing the await form would assert a hang this task cannot remove and would read as a regression of the one it did.

**What it touches:** the README's Worker section and the `exposeNode` doc comment, which is where a consumer looks. A separate task could try to close the underlying hazard (buffering the handshake is not in this package's power; a documented shape is).

## 4. The proxy completeness guarantee is CLOSED at compile time, and its runtime half states its limit

**Chosen:** `nodeProxy`'s literal is annotated `Required<SlimNode>` rather than `SlimNode`, so an OPTIONAL member added to `SlimNode` later also fails the build here. The runtime parity check in `test/helpers/worker-roundtrip.ts` now says plainly that it enumerates the keys of a reference node INSTANCE and therefore cannot see an optional member that instance does not carry.

**Why:** the task's option was "close it or state the limit"; the compile-time half closes for free (`SlimNode` has no optional members today, so `Required<>` is a no-op now and a demand later), and the runtime half genuinely cannot be closed by enumeration, so it says so where it is documented instead of reading wider than it is.

**Rejected:** leaving both halves as they were and only documenting. The compile-time gap was the one that would actually mislead a later author, since the annotation is the mechanism the module advertises.

**What it touches:** `src/worker-host.ts` (the annotation and its comment), `test/helpers/worker-roundtrip.ts`, and `CONTEXT.md`'s *worker host* entry, which states the guarantee for the vocabulary.

## Not changed, deliberately

- `src/worker-entry.ts`. It calls `exposeNode()` with no options, so no refusal is ever computed and its import-time behaviour is byte-for-byte what it was.
- The `createWorkerNode({engine})` refusal on the main thread (`src/worker-client.ts`). It throws before any Worker message is sent, on the caller's own thread, so a throw there IS the observable failure.
- Reference gas, unchanged and still measured through the Worker: 2446 / 498689 / 1107052 and the keccak hash.
