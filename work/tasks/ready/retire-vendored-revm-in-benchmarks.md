---
title: Retire the vendored revm artifact in the benchmarks package, consuming revm-wasm from npm
slug: retire-vendored-revm-in-benchmarks
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

Delete the scaffolding that makes the revm benchmark row a special case, by consuming the published `revm-wasm` package instead of a hand-vendored artifact.

The benchmark package's revm backend today loads a gitignored ~1.2 MB blob copied from a local revm clone by `scripts/vendor-revm.mjs`, and hand-rolls its own outcome decoder (including a conditional 256-byte bloom present only when the log count is non-zero) and a 72-byte account packing. All three exist only because there was nothing on npm. There is now: `revm-wasm@0.1.0`, MIT, zero runtime dependencies, with the prebuilt `.wasm` in the tarball.

This needs NOTHING from the engine seam. It is a straight swap of an artifact source and a decoder, which is why it is split out of the gate work: it un-skips the revm row in CI today rather than after the whole seam lands.

Keep the backend's SCOPE exactly as it is. It currently drives everything — deploy, state-changing transactions and reads — and that is what puts the WRITE path under the cross-backend gas gate. Do not narrow it to reads while swapping its wasm source; putting the node's read-only engine under the gate is a different task and must not cost this coverage.

## Acceptance criteria

- [ ] The benchmarks package depends on `revm-wasm` from npm; the backend consumes its typed results.
- [ ] No outcome-blob decoding, bloom-length branching or account byte-packing remains in this repo.
- [ ] `scripts/vendor-revm.mjs`, the `vendor:revm` and `pretest` scripts, the gitignored `vendor/` directory, its entry in `packages/benchmarks/.gitignore`, and the skip-when-absent branches in `evm.spec.ts` (both the `test.skip` and the `revmPresent` branch in the bundle-size test) are all removed.
- [ ] The revm row RUNS on a fresh clone with no extra step, and in CI on both Chromium and WebKit, rather than skipping.
- [ ] The backend still covers deploy, state-changing transactions and reads: the gas rows it contributed before are all still contributed.
- [ ] Cross-backend execution-gas equality and keccak-chain equality still hold with revm among the backends, on both browser engines.
- [ ] The revm wasm size still appears in the bundle-size report, now sourced from the package rather than `vendor/`.
- [ ] The prose that documented the vendoring is updated, not orphaned: `packages/benchmarks/README.md` and the `cross-backend gate` step comment in `.github/workflows/ci.yml` both currently explain the skip and tell the reader to vendor a blob.
- [ ] The stale backend-registry comment is corrected: the registry in `test/helpers/cut.ts` still describes the revm row as driving the READ path only, which `backend-revm.ts` contradicts (it gained deploy, transactions and commit). Whichever is true after this change, the two must agree.
- [ ] Tests cover the new behaviour (mirror the repo's existing test style).

## Blocked by

- None — can start immediately. It touches only `packages/benchmarks/**`, `.gitignore` and the CI comment, so it is file-orthogonal to the engine seam work running in parallel.

## Prompt

> Goal: make the revm benchmark row an ordinary row that runs everywhere, by consuming a published package instead of a machine-local blob.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the current `revm-wasm` release? If the package has moved past `0.1.0`, use what is published and note any API difference in the done record.
>
> Read `CONTEXT.md` for *the gate*: every EVM backend must charge the same EXECUTION gas and produce the same keccak-chain result for the same call. Gas equality, not result equality, is what makes an interpreter swap safe — engines that disagree on gas disagree on where execution runs OUT of gas, and a client replaying the chain would fork. This gate has already caught one real non-conformance: an EIP-2929 warmth leak in the raw-`runCall` backends, where the second and subsequent reads of a slot were charged a warm SLOAD (100) instead of a cold one (2100), silently, with every value still looking plausible.
>
> Where to look, by concept: the benchmark package has one spec that drives every backend through a shared scenario and asserts cross-backend equality; the backends live beside it, one file each, behind a small shared interface. One of them is revm, and it is the only one that needs a build step on the developer's machine.
>
> WHAT NOT TO CHANGE. That backend deliberately drives the WRITE path too (its own commit path, its own host maps), and the header comment explains why: it puts writes under the gas gate instead of only reads. Swapping where the wasm comes from must not shrink that. If you find yourself deleting the deploy or transaction rows, stop — you are doing the other task, and doing it by accident.
>
> TWO COMMENTS IN THIS PACKAGE DISAGREE, so do not trust either on sight. The backend registry says the revm row drives the read path only and is a hybrid; the backend's own header says that WAS true until it gained logs, code bytes for created accounts and a commit path, and that it now executes everything. Read the code, decide which is true today, and make the comments agree — a builder on the next task will act on whichever one they read first.
>
> Reference numbers, so a wrong answer is obvious: `number()` is 2446 execution gas, `sumTo(2000)` is 498689, `keccakLoop(2000)` is 1107052 and returns `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`. Every backend must agree exactly.
>
> Note the benchmark suite runs on two browser engines and takes minutes; its timing rows are load-sensitive and deliberately NOT asserted on. Only gas equality, keccak equality and the scenario results are assertions. Do not add a timing assertion — CI runners are too noisy, and the existing config comments say so.
>
> Finish the sweep in prose too. The benchmarks README and the CI workflow both currently TELL the reader that the revm row skips and that artifacts must be vendored. A deletion that leaves its own documentation behind is drift the next reader will believe.
>
> Done means: nothing in this repo knows how to vendor a wasm artifact any more, and the revm row runs on a fresh clone and in CI with no extra step.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
