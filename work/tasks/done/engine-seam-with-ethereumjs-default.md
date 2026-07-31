---
title: Introduce the EVM engine seam, with @ethereumjs/evm as the default engine
slug: engine-seam-with-ethereumjs-default
spec: revm-engine-behind-eth-call
blockedBy: []
covers: [1, 9]
---

## What to build

A seam that makes the node's EVM swappable, with **no behaviour change whatsoever**.

The node currently reaches `@ethereumjs/evm` directly for its read path. Introduce an engine abstraction, route that read path through it, and ship a default engine that wraps exactly today's behaviour. A consumer who passes no engine gets precisely what they get now.

The read path is a SINGLE internal function serving three callers (`eth_call`, `eth_estimateGas` and `eth_fillTransaction`'s gas estimation). Route the seam there, so all three go through the engine rather than only the two the spec names.

Also expose which engine is active, so a bug report can say unambiguously which EVM produced a result. Be precise about WHAT it names: this spec routes only the READ path through the engine, so with a non-default engine installed the node runs two EVMs — the injected one for reads, `@ethereumjs/vm` for transactions. A single unqualified "engine" reading would be a half-truth exactly where a bug report leans on it, so name the read engine as the read engine.

This is deliberately a pure refactor. It is a real tracer bullet rather than a stub because "the entire existing suite still passes, on both browser engines" is a complete, demoable outcome — and because every later task in this spec is only safe if this one changed nothing.

> **FORWARD-POINTER, added after `revm-state-adapter-spike` landed (`docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md`) — it constrains WHERE you put the seam.** The pure-read helper described below does two things before running the call: it resets the EIP-2929 warm/access tracking, and it `checkpoint()`s the state manager so the call cannot mutate state. Both are requirements of `@ethereumjs/evm` specifically. A revm engine needs NEITHER: `Revm#call` is structurally incapable of committing (proved in the spike, section 5), so it needs no checkpoint at all — and the checkpoint is not free, because `checkpointSync()` copies all three state maps and clones every account. Measured in the spike: 0.384 ms per call at 2002 accounts, which is larger than the entire revm read it would be wrapping (0.016 ms).
>
> So do NOT leave the checkpoint/revert and the 2929 reset in a node-side wrapper that every engine pays. Put them INSIDE the default `@ethereumjs/evm` engine, where they belong, and let the seam be the plain "execute this read-only call" boundary. Getting this wrong is silent: everything still works, the gas is still right, and the revm engine simply carries an O(state) copy per call forever, which is most of what it came to remove.

## Acceptance criteria

- [ ] `createNode()` with no engine option behaves identically to before: the whole existing test suite passes unchanged, on both Chromium and WebKit.
- [ ] The node's read path (`eth_call`, `eth_estimateGas`, and `eth_fillTransaction`'s estimation) goes through the engine abstraction rather than reaching the EVM directly.
- [ ] A default engine wrapping `@ethereumjs/evm` is used when none is supplied, and the node does not require callers to know engines exist.
- [ ] The active READ engine is readable from the node, under a name that does not imply it executed transactions (transactions still run on `@ethereumjs/vm`).
- [ ] The default engine reports a stable identifier, so the reading is meaningful with no engine supplied too.
- [ ] The engine interface is exported as a TYPE so an external engine can be written against it.
- [ ] `CONTEXT.md`'s glossary entry for *engine* is updated to match what the seam actually is: today it says "the EVM implementation behind the node", which after this change is true only of the READ path. Pin the term so the next author cannot re-fork it.
- [ ] The EIP-2929 warm/access reset that the current read path performs before each pure call is preserved by the default engine. Dropping it silently under-reports gas by ~2000 on a warm slot; there is a long comment at the existing reset site explaining why, and a benchmark assertion that catches it.
- [ ] The reset AND the state-manager checkpoint/revert live inside the default engine, not in a node-side wrapper above the seam, so an engine that needs neither does not pay for them (see the forward-pointer above and ADR 0005).
- [ ] `eth_estimateGas` keeps its exact current semantics: the engine reports EXECUTION gas and the node adds intrinsic gas, as it does today.
- [ ] No new runtime dependency is added to the core entry point.
- [ ] Tests cover the new behaviour (mirror the repo's existing test style).

## Blocked by

- None — can start immediately.

## Prompt

> Goal: make the EVM behind `embedded-eth-node` swappable, changing nothing observable.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.
>
> Read `CONTEXT.md` for the domain vocabulary — in particular *engine*, *honest edge*, *state mode*, *the gate* and *conformance differential*. Read `docs/adr/` before changing public surface; `0001` and `0004` both constrain what the node is allowed to be.
>
> Where to look, by concept rather than path: the node's request dispatcher handles every EIP-1193 method in one switch; near it is a single pure-read helper that runs a call against the EVM without mutating state (it checkpoints and reverts, and resets the EVM journal's EIP-2929 warm/access tracking plus the original-storage cache first). That helper IS the seam. Three cases in the dispatcher call it.
>
> The engine interface should be the SMALLEST thing that serves that helper: execute a read-only call against the current state and report return data, execution gas, and whether it reverted. Do not design for transactions — a sibling spec covers those, and guessing at their shape now will get it wrong.
>
> Two constraints that are not obvious:
>
> 1. The warm/access reset before each pure call is load-bearing, not incidental. `runCall` (unlike `runTx`) never clears the journal's EIP-2929 tracking, so slot warmth leaks from one `eth_call` into the next and the second estimate for a warm SSTORE comes back ~2000 gas too low. viem then uses that under-estimate as a gas LIMIT and the real transaction runs out of gas. The existing code comments this at length. Whatever the default engine does, that reset must still happen.
> 2. Do not add an `engine: 'name'` string option. The engine is an INJECTED OBJECT. Naming engines by string would force the core to reference every engine it can name, which defeats tree-shaking and makes a JS-only consumer pay for an engine they never use.
>
> Seams to test at: the existing suites are the bar. `test/conformance.spec.ts` diffs receipts and post-state against a trie-backed `@ethereumjs/vm` reference; `test/slim-node-checks.spec.ts` pins the honest edges; the benchmark package asserts cross-backend execution-gas equality. All of them must pass untouched. If a test needs editing to pass, the refactor changed behaviour and is wrong.
>
> On exposing the active engine: resist `node.engine`. Reads go through the injected engine and transactions do not, so an unqualified name invites a bug reporter to attribute a receipt to revm that revm never touched. `readEngine` (or an equivalent that carries the scope) plus a one-line doc comment is the whole fix, and it is far cheaper now than after it is public API.
>
> Done means: the seam exists, the default engine is `@ethereumjs/evm`, and nothing observable changed.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record. **One is already known to need an ADR**: the engine is an injected object rather than a named string. Write it in `docs/adr/` with the reasoning above — it is hard to reverse because it is public API shape, and surprising because the string form is the more obvious design. The spec (`work/specs/tasked/revm-engine-behind-eth-call.md`) marks it explicitly for promotion.
