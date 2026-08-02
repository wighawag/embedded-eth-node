---
title: review-gate non-blocking nits for 'upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks' (Gate 2 approve)
date: 2026-08-02
status: open
reviewOf: upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify decision 1: the fork parameter is the node's Common instance itself (intrinsicGas(data, isCreate, common), required), gated on common.isActivatedEIP(3860). Verified against the bytes: node.ts passes the Common it builds at line 125 and hands the SAME instance to the engine via connect(..., {common}), which src/revm.ts captures as nodeCommon at connect, so the ADD side and the SUBTRACT side cannot name different forks. Also note the deliberately-deferred alternative (d): moving intrinsic gas onto ReadCallRequest so the node computes it once. That is the more drift-proof shape and is a public seam change; ratify the deferral or schedule it.
  (src/intrinsic-gas.ts:53-70, src/node.ts:97-106/745/774, src/revm.ts:170-176/240)
- Ratify decision 2: a NEW error. src/revm.ts call() now throws if connect() has not bound a Common. It is unreachable through createNode() (the seam always connects first), mirrors the existing unbound guard in revm-state-store.ts (verified, same phrasing and plain Error), and only a consumer hand-driving a ReadEngine can hit it. The agent recorded that no test asserts it; a 3-line assertion would make the new refusal load-bearing like every other honest edge in this repo.
  (src/revm.ts call() guard vs src/revm-state-store.ts:202)
- Ratify decisions 3-5 (test shape): clause (b) restated from 'EIP-3860 active at every admitted fork' to 'the node charges it exactly where the protocol does', measured three ways per fork; the new admittedPreEip3860 span assertion that keeps those readings load-bearing; the cross-engine CREATE estimate built BELOW createNode() because the node pins Cancun; and the helper mirror narrowed to intrinsicGasForCall so no mirror of a fork-gated formula can test itself. All three read as sound and follow patterns the file already used.
  (test/revm-engine.spec.ts:167-270, test/helpers/revm-engine.ts)
- The intrinsic-gas.ts header lost its lower bound. It previously said the true-for range 'has an end at BOTH sides'; it now says only 'THE FORK RANGE THIS FORMULA IS TRUE FOR ENDS ABOVE, AT PRAGUE', while the file still hardcodes 16/4 calldata costs (EIP-2028, Istanbul). Nothing is wrong today (no path reaches a pre-Istanbul fork, and admitting one needs a deliberate table edit), but now that the gate makes re-admission look cheap, the next author loses the warning that the calldata term is fork-dependent too. One clause restoring the Istanbul floor would keep the file's whole value intact.
  (packages/embedded-eth-node/src/intrinsic-gas.ts:29-46; the gap is owned by work/tasks/backlog/clause-b-covers-only-eip-3860-not-the-rest-of-the-formula.md)
- ADR 0008's second-amendment table gives 53296 / 53292 (intrinsic gas only, execution excluded) while the prose two paragraphs later gives 53302 / 53298 (the full estimate), with no label saying which basis each uses. Both are correct and both match measurements sections 1 and 6, but the ADR is the durable record a re-admitter reads first, and the two number families side by side read as a contradiction. A four-word column header would fix it.
  (docs/adr/0008-...md, second amendment table vs the paragraph citing default 53302 vs revm 53298)
- ADR 0008's H1 still reads 'every fork outside Shanghai..Cancun is refused rather than half-supported', which is now false: berlin, london and paris are admitted. The two amendment banners sit immediately under it, and the first amendment set the precedent of leaving the title alone, so this is a judgement call for the human, not a defect.
  (docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md:1)
- Cross-task drift the human may want to route: three backlog tasks now carry stale premises. readmit-refused-hardforks-once-the-node-can-cost-them still advertises family 2 (berlin/london/paris) as UNBLOCKED work, which this change just delivered; clause-b-covers-only-eip-3860-not-the-rest-of-the-formula has an acceptance criterion pinning the admitted set to shanghai+cancun and asks for a pre-Istanbul counter-example 'the way paris is', but paris is now admitted; harden-and-tidy-the-revm-hardfork-tables asserts no admitted fork is pre-Merge and counts five refused forks. Leaving them untouched is contract-correct (tasks are launch snapshots and the builder must not edit other work/ items), and each carries a drift check, but a re-cut would save a claim cycle.
  (work/tasks/backlog/ x3 vs the new REVM_SPEC_BY_HARDFORK)
