<!-- dorfl-sidecar: item=task:revm-executes-the-first-transaction-with-commit type=task slug=revm-executes-the-first-transaction-with-commit allAnswered=false -->

## Q1

**'task:revm-executes-the-first-transaction-with-commit' was bounced — how should we proceed?**

> PR/code review (Gate 2) blocked this work:
> - The read-engine phrase sweep missed two LIVE sites that are false as of this commit, and the task owned every one of them. Fix both (one line each): (1) the published JSDoc of the factory consumers call, and (2) the benchmark package README, which additionally tells a maintainer that deploy/callAvg differences are noise - so a real engine-sensitive regression in those rows would now be dismissed. (packages/embedded-eth-node/src/revm.ts:200 - Build a revm-backed engine, serving the seam's READ half. And packages/benchmarks/README.md:72-76 - Only READS move here ... has no write half yet, so a revm-backed node still executes its transactions on @ethereumjs/vm: deploy and callAvg are unaffected by design and any difference there is noise. The same commit DID update the sibling comments in test/helpers/cut.ts and test/helpers/backend-slim-node.ts, so the README now contradicts the code beside it.)
> PR/code review (Gate 2) did not reach a unanimous approve across reviewMaxRounds=2 round(s) (a block is terminal and is never re-rolled); forcing needs-attention (never silently merged or looped).

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
