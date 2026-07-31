---
title: A revm engine on the embedded-eth-node/revm subpath
slug: revm-engine-subpath
spec: revm-engine-behind-eth-call
needsAnswers: true
blockedBy: [engine-seam-with-ethereumjs-default, revm-state-adapter-spike, retire-vendored-revm-in-benchmarks]
covers: [2, 3, 4, 5, 6, 8, 11]
---

<!-- open-questions -->

## Open questions

**Questions 1-3 are now ANSWERED** by `revm-state-adapter-spike`, which landed: see `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md` and the working adapter at `docs/spikes/revm-state-adapter-spike/simple-state-store.ts`. They are kept below for the record, each with its answer. **Question 4 is still open and needs a human call**, which is why `needsAnswers` is still set.

1. **ANSWERED — how does the engine read the node's state synchronously?** `revm-wasm`'s `StateStore` read methods must be synchronous (the interpreter is a sync loop inside wasm, with no suspension point mid-opcode), while every read on `SimpleStateManager` / `MerkleStateManager` returns a `Promise`. Is the sanctioned path a reach-through into `SimpleStateManager`'s public `accountStack` / `codeStack` / `storageStack` Maps, a worker with a synchronous view, or something else? This decides the whole shape of the adapter, and the answer must survive the node's checkpoint/revert around each pure call.
2. **ANSWERED — what indexes codeHash to code?** revm asks `getCode(codeHash)`; ethereumjs stores code by ADDRESS. Some index has to exist, it lives outside the node's state manager, and "the node's state is the single source of truth" has to be restated honestly once it does.
3. **ANSWERED — which `stateMode` can this engine serve?** `'trie'` (`MerkleStateManager`) has no synchronous view at all, so the answer is probably `'none'` only — which makes revm + `stateMode:'trie'` a combination this task must refuse loudly, not one a later task discovers.
4. **STILL OPEN — where does `revm-wasm` land in `package.json`?** A plain `dependency` means every installer downloads it even if they never import the subpath; an optional `peerDependency` keeps the install lean but makes the subpath fail confusingly when it is missing. Story 3 is about paying nothing for an unused feature, and bundle-size tree-shaking only answers half of that.

> **The answers, from ADR 0005.** (1) Reach through `SimpleStateManager`'s public `accountStack` / `codeStack` / `storageStack`, reading `stack[stack.length - 1]` on EVERY access — a view cached across a checkpoint silently answers from the frame below. The node already does this in `dumpState`, so it is an existing technique, not a new one. (2) An engine-owned `codeHash -> code` index, rebuilt lazily on a miss; a stale index fails SILENTLY with empty code and a success status, so rebuild-on-miss is load-bearing. (3) `'none'` only; `'trie'` has no synchronous view at any depth and must be refused at construction.
>
> **Four things Gate-2 flagged on the spike artifact, all of which land on THIS task.** The adapter is a spike, not a shipping component — lift it with these fixed: (a) it reaches the stacks through an `as any` cast, which throws away the compile error that is the whole mitigation for this coupling; the fields are public in `@ethereumjs/statemanager@10.1.2`, so drop the cast. (b) `getBlockHash` is delegated to an optional callback and returns `undefined` when unwired, so `BLOCKHASH` silently answers nothing even though the node has blocks — wire it to the node's block store. (c) The ADR prescribes a per-account `storageOf` accessor so the write half can re-layer storage later, but the spike builds the flat key inline; ship the accessor. (d) The index rebuild has no negative caching, so a genuinely absent hash re-scans the whole code map on every read.

<!-- /open-questions -->

## What to build

An optional subpath export, `embedded-eth-node/revm`, providing an engine backed by `revm-wasm` that the node can be handed at construction:

```
const node = await createNode({engine: await createRevmEngine({wasm})});
```

The engine implements the read half of the seam from `engine-seam-with-ethereumjs-default`. It reads state from the node's EXISTING state, which stays authoritative: it does not copy state into the package's own store, and it does not own state. (How it does that synchronously is open question 1 — do not start until it is answered.)

The wasm may be supplied either as a runtime-fetched URL or as a bundler-resolved asset. Both are the same code path, because `revm-wasm` accepts bytes, a URL, a `Response` or a compiled module.

The core entry point must not grow. A consumer who never imports the subpath must not pay for revm, and that is enforced by an assertion rather than asserted in prose.

## Acceptance criteria

- [ ] `embedded-eth-node/revm` exports a factory producing an engine the node accepts.
- [ ] `eth_call` and `eth_estimateGas` through the revm engine return the SAME results and the SAME gas as the default engine, on the same state.
- [ ] The engine reads the node's authoritative state — a value written by a transaction is visible to a subsequent `eth_call` on the revm engine, without any explicit sync step.
- [ ] The mechanism by which that read is SYNCHRONOUS is the one the spike's ADR sanctions, and any coupling it introduces (e.g. to a specific state-manager implementation) is documented at the code site.
- [ ] A `stateMode` the engine cannot serve is refused LOUDLY at construction, naming the reason. On the spike's expected answer that means revm + `stateMode:'trie'` throws rather than constructing and failing later.
- [ ] `eth_call` on the revm engine cannot mutate state: the flag word is zero, and a call that would write leaves the node's state unchanged.
- [ ] The wasm loads from a runtime-fetched URL, in a real browser.
- [ ] The wasm loads from a bundler-resolved asset, in a real browser.
- [ ] **The default entry point's bundle size has not grown**, asserted against a baseline PINNED IN THIS TASK's change (the existing size measurement only prints numbers, so the baseline has to be established here), and `revm-wasm` does not appear in the default entry's dependency graph.
- [ ] The `package.json` placement decided in open question 4 is implemented, and the reasoning recorded.
- [ ] No outcome-blob parsing is written in this repo — the typed results from `revm-wasm` are consumed directly.
- [ ] Tests cover the new behaviour (mirror the repo's existing test style).

## Blocked by

- `engine-seam-with-ethereumjs-default` — the interface this implements must exist first.
- `revm-state-adapter-spike` — this task is premised on the node's state being readable synchronously, which is not yet established.
- `retire-vendored-revm-in-benchmarks` — no logical dependency, but both tasks edit the benchmark spec that owns the bundle-size measurement, so they are serialised to avoid a merge conflict.

## Prompt

> Goal: a revm-backed engine for `embedded-eth-node`, behind an optional subpath, reading the node's own state.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? In particular, read the engine interface `engine-seam-with-ethereumjs-default` actually shipped, and the ADR `revm-state-adapter-spike` produced — this task's `## Open questions` were written BEFORE that answer existed, so the ADR wins wherever they disagree. If the open questions are still unanswered, do not build: the task is flagged `needsAnswers` for a reason.
>
> Read `CONTEXT.md` for the vocabulary and `docs/adr/0003-revm-wasm-is-the-engine-direction.md` for why revm and not the alternatives.
>
> THE DEPENDENCY. `revm-wasm@0.1.0` is on npm: MIT, ZERO runtime dependencies, the prebuilt `.wasm` inside the tarball, no Rust toolchain needed. Its `Revm` instance exposes `call`, `transact`, `create` and `recoverSigner`, each taking an OPTIONS OBJECT. It reports `revmVersion`, `revmRevision`, `outcomeFormatVersion` and `abiVersion` at runtime. Only `call` is in scope here.
>
> HOW STATE CONNECTS — this is the crux, and the reason this task waited on a spike. `revm-wasm` exports a public `StateStore` interface: FOUR read methods (`getAccount`, `getStorage`, `getCode`, `getBlockHash`) and FIVE write methods (`setAccount`, `setCode`, `setStorage`, `clearStorage`, `removeAccount`). The package documents that a read-only consumer MAY THROW from all five writes, which is exactly this task's shape — the sibling spec `revm-engine-behind-runtx` adds the write half later. Implement `StateStore` as an ADAPTER over the node's existing state, per the spike's ADR. Do NOT use the package's `MemoryStore`, and do NOT copy state across.
>
> Three `StateStore` contract details, all easy to violate and all silent when violated:
>
> 1. The read methods are **synchronous by contract** — there is no suspension point mid-opcode to await at. The node's state-manager interface is entirely async. The spike's ADR says how to bridge that; follow it, and document the coupling it buys at the code site.
> 2. Arguments to the READ methods are **reused scratch buffers, valid only for the duration of the call**. That is what makes a read allocation-free. Copy them or consume them immediately; never retain one as a map key without copying.
> 3. `clearStorage` must be **O(that account)**, not O(total state). The node's flat address-plus-slot storage keying does not satisfy this. The write half is out of scope here, so you need not fix it — but do not design the adapter so that fixing it later requires redesigning the adapter.
>
> FAIL LOUDLY ON A MODE YOU CANNOT SERVE. If the sanctioned sync read path only exists for `stateMode:'none'`, then `createNode({stateMode:'trie', engine: revmEngine})` must throw at construction with a real error naming the reason. A consumer who asked for revm and silently got something else would measure the wrong thing forever. This criterion is the revm-specific INSTANCE; the node-side generic mechanism is `engine-seam-docs-and-honest-edges`, so keep the check in the engine and do not duplicate its plumbing.
>
> Do NOT hand-roll a decoder for revm's outcome blob. The package owns decoding and returns typed results. This repo has hand-rolled that decoder before and it broke silently twice as the format moved v1 to v2 to v3; the benchmark package still contains such a decoder and it is retired by `retire-vendored-revm-in-benchmarks`.
>
> WASM DELIVERY. `revm-wasm` accepts bytes, a `URL`, a `Response` or a compiled `WebAssembly.Module`, so both delivery shapes are the same code path — pass the caller's source through rather than implementing two loaders. Note a real trap: `revm-wasm/wasm-url` exports a `file:` URL, and Node's `fetch` cannot resolve that scheme, so the async factory fails in Node while working in a browser. Handle it, or document the Node path explicitly.
>
> Seams to test at: the library's conformance differential is the strongest bar for results, and the cross-backend gate in the benchmark package asserts execution-gas equality across engines. The bundle-size assertion belongs beside the existing size measurement in the benchmark suite — note that measurement currently only PRINTS sizes, so this task has to pin the baseline it asserts against, not assume one exists.
>
> Reference numbers, so a wrong answer is obvious rather than plausible: with the Counter contract, `number()` costs 2446 execution gas, `sumTo(2000)` costs 498689, and `keccakLoop(2000)` costs 1107052 and returns `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`. These are identical on `@ethereumjs/evm` and on `revm-wasm@0.1.0`, verified from a clean install.
>
> Done means: a consumer can opt into revm for reads with one option, the results and gas are identical to the default engine, a configuration the engine cannot serve is refused out loud, and a consumer who does not opt in pays nothing.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
