---
title: review-gate non-blocking nits for 'prague-intrinsic-gas-floor-or-refuse' (Gate 2 approve)
date: 2026-08-02
status: open
reviewOf: prague-intrinsic-gas-floor-or-refuse
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'prague-intrinsic-gas-floor-or-refuse' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify decision 1: the task offered implement-or-refuse and the agent chose REFUSE, removing prague and osaka from the engine's hardfork table rather than adding the EIP-7623 floor to the shared intrinsic-gas.ts. The reasoning (branch would be unreachable while createNode pins Cancun; Osaka also breaks on the EIP-7825 cap; Prague brings EIP-7702/EIP-2935 the tx path was never checked against) is measured and cheap to reverse, but it is the load-bearing call of this task.
  (work/notes/observations/decisions-prague-intrinsic-gas-floor-or-refuse-2026-08-02.md entry 1; docs/adr/0008; packages/embedded-eth-node/src/revm.ts REVM_REFUSED_HARDFORKS)
- Ratify decision 2: the two hardfork tables became PUBLIC named exports of embedded-eth-node/revm (REVM_SPEC_BY_HARDFORK, REVM_REFUSED_HARDFORKS), enlarging the subpath's API surface so the test can loop over the admitted set. Note both are Readonly at type level only, not frozen, so a consumer can re-admit prague at runtime and defeat the construction guard.
  (src/revm.ts:69-121 exports; README.md caveat; .changeset/quiet-forks-refuse-loudly.md)
- Unrecorded decision: the changeset labels this minor for embedded-eth-node 0.0.2, even though it REMOVES two hardforks the engine previously admitted. Reachable only by a consumer driving engine.connect directly (the node pins Cancun), so minor is defensible on a 0.x package, but it is a user-visible versioning call nobody recorded.
  (.changeset/quiet-forks-refuse-loudly.md front matter says minor; packages/embedded-eth-node/package.json version 0.0.2)
- Deliberate non-delivery is documented but not named as a follow-up item: ADR 0008 says work/tasks/backlog/ is the place for the eventual Prague costing work, yet no backlog task exists for it. Should one be cut so the refusal does not become permanent by neglect?
  (docs/adr/0008 Consequences, last bullet; work/tasks/backlog/ contains only context-md-conformance-differential-covers-both-oracles and value-bearing-conformance-steps-assert-the-failure-shape)
- The new admission rule (the node's arithmetic must agree with what revm enforces) leaves berlin, london and paris admitted while the shared formula charges the EIP-3860 initcode word cost UNCONDITIONALLY, i.e. on forks that predate it. The spike noticed this and dismissed it because revm over-charges identically, so the two agree; but that is agreement between two wrong sides, which is the shape ADR 0008 exists to refuse. Accepted as-is, or worth a note in the table?
  (src/intrinsic-gas.ts adds 32000 + word cost with no fork gate; docs/spikes/prague-intrinsic-gas-floor-or-refuse/measurements.md section 3)
- Two stale references left behind by the rename and the probe filename: a comment still names the old const, and ADR 0008 cites a probe script that does not exist under that name.
  (packages/embedded-eth-node/src/revm.ts:244 says SPEC_BY_HARDFORK (renamed to REVM_SPEC_BY_HARDFORK); docs/adr/0008 line 7 cites probe.mjs, the file is docs/spikes/prague-intrinsic-gas-floor-or-refuse/probe-hardfork-costing.mjs)
