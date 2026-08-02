---
title: review-gate non-blocking nits for 'intrinsic-gas-charges-eip-3860-on-forks-that-predate-it' (Gate 2 approve)
date: 2026-08-02
status: open
reviewOf: intrinsic-gas-charges-eip-3860-on-forks-that-predate-it
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'intrinsic-gas-charges-eip-3860-on-forks-that-predate-it' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify decision 1: berlin, london and paris move from REVM_SPEC_BY_HARDFORK to REVM_REFUSED_HARDFORKS, so the exported admitted set shrinks from five forks to two and connect() now throws by name on three forks it previously served. Shipped as a minor changeset on 0.0.2. Nothing reachable through createNode changes (the node pins Cancun and exposes no hardfork option), but a consumer driving a ReadEngine.connect with its own Common gets a new refusal. Accept, or re-admit?
  (packages/embedded-eth-node/src/revm.ts:95-165 (PRE_EIP_3860 reason string, both tables); .changeset/honest-forks-below-shanghai.md; decisions note section 1. Evidence is solid: docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md shows 53296 vs the protocol's 53292 on those forks, and a fork gate alone would split the two engines (default 53298 vs revm 53302).)
- ADR 0008's amended rule is stated generally (clause b: what the node computes must be what the PROTOCOL charges at that fork), but the test enforces it for EIP-3860 only. intrinsicGas() also hardcodes the 16/4 calldata costs (EIP-2028, Istanbul) and the 21000/32000 bases, so re-admitting a fork below Istanbul would pass the new clause-(b) assertions while being mis-costed. Widen the check (or say in the ADR that the test covers the EIP-3860 term specifically and the rest is on the re-admitter)?
  (test/helpers/revm-engine.ts:700-770 asserts only isActivatedEIP(3860) and revm word cost 2 per admitted fork; docs/adr/0008 amendment claims clause (b) is now enforced where clause (a) was. Impact is low today: re-admission requires a deliberate table edit, and any fork missing from both tables is already refused.)
- Unrecorded cross-task interaction: this diff rewrites the prevRandao/mixHash comment in src/revm.ts, which is exactly item 2 of work/tasks/backlog/harden-and-tidy-the-revm-hardfork-tables.md (the stale SPEC_BY_HARDFORK name). That item is now done, and its stated rationale (a pre-Merge fork the table still admits) is false since the admitted set is shanghai+cancun. Trim that backlog task to item 1 (freezing the tables) so it is not built on a stale premise?
  (src/revm.ts around line 289 in the diff now reads: every admitted fork is post-Merge today, so that is belt and braces. The decisions note flags that the two backlog tasks touch the table but does not record that this one is partly resolved.)
- Doc clarity in ADR 0008's amendment: the H1 still reads that Prague and Osaka are refused rather than half-supported, which is now only half the story (the banner one line below corrects it). In the same section the table quotes intrinsic gas (53296 vs 53292) and the next paragraph quotes estimates (53298 vs 53302, which include the 6 gas of execution) with no note that they are different quantities. Retitle and add the six words?
  (docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md:1-3 and the amendment section. The spike's measurements.md section 3 does explain the 6 gas; the ADR does not.)
