---
title: The README quotes a default-entry bundle size two re-pins out of date
date: 2026-08-10
status: open
---

Noticed while re-pinning `DEFAULT_ENTRY_BASELINE` in `packages/benchmarks/test/evm.spec.ts` for `revm-executes-the-first-transaction-with-commit`: the README's "What you pay if you never opt in" bullet says the default entry point is "413.5 KB raw / 124.6 KB gzip", while the asserted baseline has since moved to 417.2 KB / 125.7 KB (through the `clearStorage` fix, the storage re-layer, the seam widening and this change). The assertion is the source of truth and is green; only the prose is stale. Not touched here because it is a pre-existing drift on a surface this task does not otherwise own, and the honest fix is to make the README cite the assertion rather than restate a number that moves.
