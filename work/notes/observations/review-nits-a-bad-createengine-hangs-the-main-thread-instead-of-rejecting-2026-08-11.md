---
title: review-gate non-blocking nits for 'a-bad-createengine-hangs-the-main-thread-instead-of-rejecting' (Gate 2 approve)
date: 2026-08-11
status: open
reviewOf: a-bad-createengine-hangs-the-main-thread-instead-of-rejecting
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'a-bad-createengine-hangs-the-main-thread-instead-of-rejecting' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The early worker-side signal is asserted by calling createNodeWorkerApi() on the PAGE thread (reportEarlySignal in test/helpers/engine-misuse.ts, driven from cut.ts / cut-revm.ts), not inside the misused worker itself, and the revm variant feeds it a hand-made Promise.resolve({id:'revm-wasm'}) rather than the value the worker module actually passes. It proves the same function reports-and-does-not-throw, but nothing proves the real worker logged anything at load. Ratify this as sufficient coverage for the criterion the worker side ALSO still reports, or ask for a worker-console capture.
  (test/helpers/engine-misuse.ts reportEarlySignal(); test/helpers/cut-revm.ts results.early = reportEarlySignal(Promise.resolve({id:'revm-wasm'})))
- Required<SlimNode> also strips the undefined from a future optional member's type, so a later author forwarding node.foo would get a not-assignable error rather than the missing-property error the doc comment describes, and could silence it with a cast. The guarantee still fires (the build breaks), so this is a wording/ergonomics point on a comment that is itself the advertised mechanism.
  (src/worker-host.ts nodeProxy: const forwarded: Required<SlimNode>, plus the module comment and the CONTEXT.md worker host entry)
- Task item 3 had drifted: only one dead citation was in worker-roundtrip.ts; the second lived in docs/spikes/prove-the-revm-in-a-worker-recipe-the-readme-recommends/measurements.md. The agent repaired it there and also appended a Superseded 2026-08-11 blockquote editing that historical spike record, which decisions.md does not list under What it touches. Ratify editing a past spike record in place as the repo's repair pattern.
  (docs/spikes/prove-the-revm-in-a-worker-recipe-the-readme-recommends/measurements.md, Rejected paragraph plus the new Superseded blockquote)
