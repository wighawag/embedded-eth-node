---
title: review-gate non-blocking nits for 'make-the-worker-node-proxy-reusable-instead-of-hand-copied' (Gate 2 approve)
date: 2026-08-11
status: open
reviewOf: make-the-worker-node-proxy-reusable-instead-of-hand-copied
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'make-the-worker-node-proxy-reusable-instead-of-hand-copied' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the new published subpath embedded-eth-node/worker-host with exposeNode(), rather than a new export on worker-entry. It is additive but it is a published export-map entry, so reversing it later is a breaking rename.
  (packages/embedded-eth-node/package.json exports adds ./worker-host; rationale in docs/spikes/make-the-worker-node-proxy-reusable-instead-of-hand-copied/decisions.md section 1 (a module-scope expose() cannot be imported, so the task sketch importing exposeNode from worker-entry could not be taken literally).)
- Ratify the option name createEngine (a factory, called once per createNode) and the NEW user-visible refusal thrown when it is present but not a function.
  (src/worker-host.ts WorkerHostOptions + createNodeWorkerApi throw; decisions.md section 2. Naming is coherent with the glossary: engine means the injected OBJECT everywhere else, so a factory could not reuse that word.)
- The createEngine refusal throws inside createNodeWorkerApi, which exposeNode calls BEFORE expose(), i.e. at worker module evaluation. Should the check be deferred into createNode() so comlink rejects the main thread promise instead?
  (src/worker-host.ts: exposeNode -> createNodeWorkerApi throws -> expose() never runs -> the worker answers no message, so an awaited createWorkerNode() on the main thread never settles and the message only reaches the worker console. The decisions doc records the throw but not this consequence.)
- Ratify exporting createNodeWorkerApi as a second public entry point alongside exposeNode; it widens the published surface beyond the one factory the task asked for and is only justified by a one-line comment about composing into a larger api.
  (src/worker-host.ts exports createNodeWorkerApi, exposeNode, NodeWorkerApi, EngineSupplier, WorkerHostOptions. decisions.md names createNodeWorkerApi but gives no rationale for publishing it.)
- Ratify resolving the README pointer by INLINING the four-line recipe and leaving package.json files as [dist, src], so no test file is published.
  (decisions.md section 4; README now names test/helpers/revm-worker.ts and test/revm-worker.spec.ts as repository files and links the GitHub test DIRECTORY on branch main rather than each file, so a reader lands one level above the two files.)
- The changeset links ADR 0006 with a repo-relative path, which will render as a broken link in the published package CHANGELOG on npm; elsewhere the changelog uses absolute github.com URLs for the same ADRs.
  (.changeset/worker-host-exposes-the-node-proxy.md line 16 vs packages/embedded-eth-node/CHANGELOG.md line 206.)
- test/revm-worker.spec.ts header prose still describes the OLD recipe (build the engine there, createNode({engine}) there, comlink-expose the node) although the helper it drives now calls exposeNode(); the file was not touched by this change.
  (packages/embedded-eth-node/test/revm-worker.spec.ts lines 6-12 and the comment at the workerEntry const.)
- worker-roundtrip.ts still cites work/notes/observations/worker-entry-drops-sendermode.md, which does not exist (nor does worker-entry-cannot-be-reused-by-a-consumers-own-worker-module.md, cited from the earlier spike). Pre-existing, but adjacent lines were edited here.
  (packages/embedded-eth-node/test/helpers/worker-roundtrip.ts item 2b; work/notes/observations/ contains neither file.)
- The compile-time completeness guarantee holds for REQUIRED SlimNode members only: an OPTIONAL field added to SlimNode later would neither fail the annotated nodeProxy literal nor appear in the Object.keys shape check (absent on the reference node object).
  (src/worker-host.ts nodeProxy typed SlimNode; test/helpers/worker-roundtrip.ts iterates Object.keys(reference). SlimNode currently has no optional members, so nothing is missed today.)
