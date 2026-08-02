<!-- dorfl-sidecar: item=task:revm-wasm-upgrade-honest-block-environment type=task slug=revm-wasm-upgrade-honest-block-environment allAnswered=true -->

## Q1

**'task:revm-wasm-upgrade-honest-block-environment' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm build && pnpm test`; its last output was:
>
> packages/embedded-eth-node test:     at write (node:internal/fs/promises:747:8)
> packages/embedded-eth-node test:     at writeFileHandle (node:internal/fs/promises:504:7)
> packages/embedded-eth-node test:     at LastRunReporter.onEnd (/tmp/dorfl-fresh-gate-7XTe1j/tip/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/lib/runner/index.js:6153:5)
> packages/embedded-eth-node test:     at wrapAsync (/tmp/dorfl-fresh-gate-7XTe1j/tip/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/lib/runner/index.js:1614:12)
> packages/embedded-eth-node test:     at Multiplexer.onEnd (/tmp/dorfl-fresh-gate-7XTe1j/tip/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/lib/runner/index.js:1582:25)
> packages/embedded-eth-node test:     at InternalReporter.onEnd (/tmp/dorfl-fresh-gate-7XTe1j/tip/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/lib/runner/index.js:1749:12)
> packages/embedded-eth-node test:     at finishTaskRun (/tmp/dorfl-fresh-gate-7XTe1j/tip/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/lib/runner/index.js:5822:26)
> packages/embedded-eth-node test:     at runTasks (/tmp/dorfl-fresh-gate-7XTe1j/tip/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/lib/runner/index.js:5809:10)
> packages/embedded-eth-node test:     at Object.runAllTestsWithConfig (/tmp/dorfl-fresh-gate-7XTe1j/tip/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/lib/runner/index.js:6480:18)
> packages/embedded-eth-node test:     at runTests (/tmp/dorfl-fresh-gate-7XTe1j/tip/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/lib/cli/testActions.js:93:18)
> packages/embedded-eth-node test:     at _Command.<anonymous> (/tmp/dorfl-fresh-gate-7XTe1j/tip/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/lib/program.js:50:7) {
> packages/embedded-eth-node test:   errno: -28,
> packages/embedded-eth-node test:   code: 'ENOSPC',
> packages/embedded-eth-node test:   syscall: 'write'
> packages/embedded-eth-node test: }
> packages/embedded-eth-node test: Failed
> /tmp/dorfl-fresh-gate-7XTe1j/tip/packages/embedded-eth-node:
>  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  embedded-eth-node@0.0.2 test: `playwright test`
> Exit status 1
>  ELIFECYCLE  Test failed. See above for more details.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):

NOT A CODE FAILURE. The gate did not fail on this work: it failed on the MACHINE. The error is `ENOSPC` (`errno: -28`, `syscall: 'write'`) raised by Playwright's `LastRunReporter.onEnd` while writing its run report, because the fresh-gate worktree lives under `/tmp`, which on this host is a 16 GB tmpfs that was 100% full (4.1 MB free) at the time, with the space held by unrelated scratch data from other projects. No assertion failed and no test reported a wrong value. Nothing in this branch caused it and nothing in this branch can fix it.

CONTINUE FROM THE EXISTING BRANCH. `work/task-revm-wasm-upgrade-honest-block-environment` is at `538188e` and the fix it carries is CORRECT and already reviewed by the conductor. Do not restart it, do not re-litigate the decision, and do not revert anything. The gate is simply to be re-run with room to write; it will be re-dispatched with the temporary directory pointed at a filesystem that has space.

WHAT THE BRANCH NOW CARRIES, and it answers q1 exactly as directed. The read path deliberately does NOT set `disableBalanceCheck`; it takes only `disableBaseFee`, `disableBlockGasLimit` and `disableEip3607`. That was established empirically rather than assumed: `docs/spikes/revm-wasm-upgrade-honest-block-environment/probe-simulation-switches.mjs` probes `revm-wasm@0.3.0` directly and `measurements.md` records the table. The measured result confirms the reasoning in the answer to q1: revm demands `balance >= gasLimit * gasPrice + value`, the read's gas price is 0 so the demand collapses to exactly `value`, the zero-value unfunded call that the flag was originally taken for already succeeds with the flag OFF once `disableBaseFee` is present, and the only rows the flag changes are the unaffordable transfers that MUST fail. The cross-engine invariant is therefore restored, and it is now covered by tests over funded and unfunded senders.

IF THE RE-RUN IS RED FOR A REAL REASON, that is a different matter and should be reported as such: two wall-clock assertions in this repo were previously replaced with load-invariant ones, so a genuine red gate here is most likely a real failure rather than a flake, and must not be waved through. `ENOSPC` is the one exception in play right now, and it is an environmental fault with an unambiguous signature, not a flake.

CONSTRAINTS UNCHANGED. Reference gas must stay exact: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`. If the bundle-size assertion in `packages/benchmarks/test/evm.spec.ts` fires, follow its failure message and re-pin the baseline in the SAME change with the reason written into the comment block above it; never raise it silently.
