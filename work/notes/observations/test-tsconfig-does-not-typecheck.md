# The test tsconfig does not typecheck (pre-existing)

2026-08-11 — `pnpm exec tsc -p packages/embedded-eth-node/tsconfig.json --noEmit` reports 8 errors, all in `test/helpers/invalid-transactions.ts` (lines 630-643: `RefusalReading` / `AffordableReading` / `NonceCheckReading` passed where `Record<string, string>` is expected). They reproduce on a clean checkout of `main`, so they predate this task and nothing catches them: the `verify` gate builds `tsconfig.build.json` (src only) and Playwright transpiles the test files without typechecking them.

Spotted while adding the state round-trip suites (`every-node-feature-survives-a-revm-write-engine`); left alone, being outside that task.
