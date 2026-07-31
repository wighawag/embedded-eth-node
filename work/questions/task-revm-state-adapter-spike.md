<!-- dorfl-sidecar: item=task:revm-state-adapter-spike type=task slug=revm-state-adapter-spike allAnswered=false -->

## Q1

**'task:revm-state-adapter-spike' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm build && pnpm test`; its last output was:
>
> packages/embedded-eth-node test:     Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBeLessThan[2m([22m[32mexpected[39m[2m)[22m
> packages/embedded-eth-node test:     Expected: < [32m15[39m
> packages/embedded-eth-node test:     Received:   [31m15[39m
> packages/embedded-eth-node test:       53 | 		t.mainThreadMaxGap,
> packages/embedded-eth-node test:       54 | 	);
> packages/embedded-eth-node test:     > 55 | 	expect(t.mainThreadMaxGap).toBeLessThan(15);
> packages/embedded-eth-node test:          | 	                           ^
> packages/embedded-eth-node test:       56 |
> packages/embedded-eth-node test:       57 | 	await h.dispose();
> packages/embedded-eth-node test:       58 | });
> packages/embedded-eth-node test:         at /tmp/dorfl-fresh-gate-zUvFp6/tip/packages/embedded-eth-node/test/worker.spec.ts:55:29
> packages/embedded-eth-node test:     Error Context: test-results/worker-slim-node-over-a-co-ca422-PI-main-thread-non-blocking-webkit/error-context.md
> packages/embedded-eth-node test:   1 failed
> packages/embedded-eth-node test:     [webkit] › test/worker.spec.ts:24:1 › slim-node over a comlink Worker: same API + main-thread non-blocking
> packages/embedded-eth-node test:   15 passed (23.9s)
> packages/embedded-eth-node test: Failed
> /tmp/dorfl-fresh-gate-zUvFp6/tip/packages/embedded-eth-node:
>  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  embedded-eth-node@0.0.2 test: `playwright test`
> Exit status 1
>  ELIFECYCLE  Test failed. See above for more details.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):

## Q2

**'task:revm-state-adapter-spike' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm build && pnpm test`; its last output was:
>
> packages/embedded-eth-node test:     Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBeLessThan[2m([22m[32mexpected[39m[2m)[22m
> packages/embedded-eth-node test:     Expected: < [32m15[39m
> packages/embedded-eth-node test:     Received:   [31m15[39m
> packages/embedded-eth-node test:       53 | 		t.mainThreadMaxGap,
> packages/embedded-eth-node test:       54 | 	);
> packages/embedded-eth-node test:     > 55 | 	expect(t.mainThreadMaxGap).toBeLessThan(15);
> packages/embedded-eth-node test:          | 	                           ^
> packages/embedded-eth-node test:       56 |
> packages/embedded-eth-node test:       57 | 	await h.dispose();
> packages/embedded-eth-node test:       58 | });
> packages/embedded-eth-node test:         at /tmp/dorfl-fresh-gate-zUvFp6/tip/packages/embedded-eth-node/test/worker.spec.ts:55:29
> packages/embedded-eth-node test:     Error Context: test-results/worker-slim-node-over-a-co-ca422-PI-main-thread-non-blocking-webkit/error-context.md
> packages/embedded-eth-node test:   1 failed
> packages/embedded-eth-node test:     [webkit] › test/worker.spec.ts:24:1 › slim-node over a comlink Worker: same API + main-thread non-blocking
> packages/embedded-eth-node test:   15 passed (23.9s)
> packages/embedded-eth-node test: Failed
> /tmp/dorfl-fresh-gate-zUvFp6/tip/packages/embedded-eth-node:
>  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  embedded-eth-node@0.0.2 test: `playwright test`
> Exit status 1
>  ELIFECYCLE  Test failed. See above for more details.

<!-- q2 fields: id=q2 kind=stuck -->

**Your answer** (write below this line):

## Q3

**'task:revm-state-adapter-spike' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm build && pnpm test`; its last output was:
>
> packages/embedded-eth-node test:     Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBeLessThan[2m([22m[32mexpected[39m[2m)[22m
> packages/embedded-eth-node test:     Expected: < [32m15[39m
> packages/embedded-eth-node test:     Received:   [31m15[39m
> packages/embedded-eth-node test:       53 | 		t.mainThreadMaxGap,
> packages/embedded-eth-node test:       54 | 	);
> packages/embedded-eth-node test:     > 55 | 	expect(t.mainThreadMaxGap).toBeLessThan(15);
> packages/embedded-eth-node test:          | 	                           ^
> packages/embedded-eth-node test:       56 |
> packages/embedded-eth-node test:       57 | 	await h.dispose();
> packages/embedded-eth-node test:       58 | });
> packages/embedded-eth-node test:         at /tmp/dorfl-fresh-gate-zUvFp6/tip/packages/embedded-eth-node/test/worker.spec.ts:55:29
> packages/embedded-eth-node test:     Error Context: test-results/worker-slim-node-over-a-co-ca422-PI-main-thread-non-blocking-webkit/error-context.md
> packages/embedded-eth-node test:   1 failed
> packages/embedded-eth-node test:     [webkit] › test/worker.spec.ts:24:1 › slim-node over a comlink Worker: same API + main-thread non-blocking
> packages/embedded-eth-node test:   15 passed (23.9s)
> packages/embedded-eth-node test: Failed
> /tmp/dorfl-fresh-gate-zUvFp6/tip/packages/embedded-eth-node:
>  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  embedded-eth-node@0.0.2 test: `playwright test`
> Exit status 1
>  ELIFECYCLE  Test failed. See above for more details.

<!-- q3 fields: id=q3 kind=stuck -->

**Your answer** (write below this line):
