---
title: review-gate non-blocking nits for 'engine-seam-with-ethereumjs-default' (Gate 2 approve)
date: 2026-07-31
status: open
reviewOf: engine-seam-with-ethereumjs-default
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'engine-seam-with-ethereumjs-default' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the connect(context) lifecycle hook: the task asked for the SMALLEST interface that serves the read helper (execute a call, report data/gas/reverted), and the agent added a second, optional method plus a ReadEngineContext of {stateManager, common, stateMode}. It is load-bearing for the two follow-on tasks (it is where revm refuses stateMode trie and where engine-seam-docs-and-honest-edges hangs its loud-failure mechanism), so it is worth an explicit yes.
  (src/types.ts ReadEngine.connect + ReadEngineContext; src/node.ts calls await readEngine.connect?.({stateManager: sm, common, stateMode}) during createNode. Recorded in docs/adr/0006 Consequences.)
- Ratify the seam's value types: ReadCallRequest carries @ethereumjs Address and Block objects rather than hex/plain values, so every third-party engine must depend on @ethereumjs types and convert internally (revm takes bytes). The rationale, avoiding a conversion in a refactor whose point is changing nothing, is sound but is recorded only in a doc comment, not in the ADR, and it is exported public API type shape.
  (src/types.ts ReadCallRequest (from: Address, to?: Address, block: Block); exported from src/index.ts.)
- Worker path: WorkerNodeOptions extends NodeOptions, so engine is now a typed-legal option on createWorkerNode, but comlink structured-clones the options object and an engine is a function-bearing object. Passing one should fail with an opaque DataCloneError rather than the repo's honest-edge error. Is that acceptable until engine-seam-docs-and-honest-edges lands (it sits behind two other tasks), or should the worker client reject engine explicitly now?
  (src/worker-client.ts: const {worker, ...nodeOptions} = opts; await api.createNode(nodeOptions). Not mentioned in the changeset, the ADR, or any note.)
- The new readEngine property was added to the worker-entry proxy but nothing tests that it survives the boundary. That is the exact omission that silently dropped senderMode (captured this run in work/notes/observations/worker-entry-drops-sendermode.md) and it went unnoticed precisely because worker-roundtrip asserts no such property. One assertion in the worker roundtrip would close the class, not just the instance.
  (src/worker-entry.ts adds readEngine: node.readEngine; test/helpers/worker-roundtrip.ts unchanged.)
- ReadEngineContext gives an engine no access to the node's block store, yet revm-engine-subpath is required to wire getBlockHash to it (BLOCKHASH otherwise answers nothing silently). The ADR names this as an additive field on ReadEngineContext; confirm the next task is expected to widen the context rather than reach around the seam.
  (src/types.ts ReadEngineContext {stateManager, common, stateMode}; docs/adr/0006 last Consequences bullet; work/tasks/ready/revm-engine-subpath.md flagged item (b).)
