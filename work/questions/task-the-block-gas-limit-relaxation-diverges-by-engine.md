<!-- dorfl-sidecar: item=task:the-block-gas-limit-relaxation-diverges-by-engine type=task slug=the-block-gas-limit-relaxation-diverges-by-engine allAnswered=false -->

## Q1

**'task:the-block-gas-limit-relaxation-diverges-by-engine' was bounced — how should we proceed?**

> PR/code review (Gate 2) blocked this work:
> - packages/embedded-eth-node/src/revm.ts:346 still justifies the read path's disableBlockGasLimit switch by stating, in present tense, that the node's default read budget IS the block gas limit. This same commit decides the opposite in src/node.ts (DEFAULT_READ_BUDGET, deliberately NOT blockGasLimit) and even files an observation note about the identical phrasing in ADR-0008, so the code site was left contradicting the decision the task's acceptance criterion 4 exists to record. On a node with a raised blockGasLimit the stated reason is now plainly false (30,000,000 + intrinsic is no longer over the block limit), which invites a maintainer to conclude the switch is removable, when it is still needed for a call that passes gas up to the limit. One comment to correct. (src/revm.ts:344-352 (disableBlockGasLimit rationale) vs src/node.ts:74-80 + 782-800 (DEFAULT_READ_BUDGET, decided apart on purpose) and work/notes/observations/adr-0008-calls-the-read-budget-the-block-gas-limit.md, which sweeps the ADR but not the live code.)
> PR/code review (Gate 2) did not reach a unanimous approve across reviewMaxRounds=2 round(s) (a block is terminal and is never re-rolled); forcing needs-attention (never silently merged or looped).

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
