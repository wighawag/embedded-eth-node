---
title: The tevm benchmark backend crashed its page once under a full `pnpm test`, failing the gate-coverage check with it
date: 2026-08-02
status: open
---

Seen while verifying `prague-intrinsic-gas-floor-or-refuse`: one full-monorepo `pnpm test` run had `packages/benchmarks` `test/evm.spec.ts:144 backend tevm` fail with `page.evaluate: Target page, context or browser has been closed`, which cascaded into `every backend contributed to the gate` (2 failed / 18 passed). The same suite passed on its own immediately after (20 passed), and had passed in an earlier full run, so it looks like a flake in the tevm backend rather than a regression. Nothing in this task touches `packages/benchmarks`.
