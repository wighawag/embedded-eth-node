---
title: Put the node's revm engine under the conformance differential and the cross-backend gate
slug: revm-engine-under-conformance-and-gate
spec: revm-engine-behind-eth-call
blockedBy: [revm-engine-subpath, retire-vendored-revm-in-benchmarks]
covers: [7]
---

## What to build

Put the shipped revm ENGINE — the node running reads on revm — under the two checks that already exist, so a divergence from `@ethereumjs/evm` fails a build rather than reaching a user.

Note what this is NOT: the existing `revm` benchmark row is RAW revm driving everything and owning its own state, and it stays exactly as it is (`retire-vendored-revm-in-benchmarks` already moved it onto the published package). This task adds the configuration nobody currently measures — `embedded-eth-node` WITH the revm engine installed — and runs it under both checks.

**The conformance differential** runs signed transactions through the node and through a trie-backed `@ethereumjs/vm` `runTx` reference, diffing receipts field by field plus post-state. Run its READ assertions with the revm engine installed. Be deliberate about `stateMode`: the battery today runs twice, once in `'none'` and once in `'trie'`, and the revm engine is expected to serve only one of them. Cover the mode it can serve and leave the other running on the default engine, rather than weakening the existing check to make one pass.

**The cross-backend gate** asserts execution-gas equality and keccak-chain equality across every backend. Add the node-with-revm-engine as a backend row there, so its gas is compared against both the JS node and raw revm.

That row also closes an honesty gap: the frame numbers this whole feature is justified by (12.4 ms against 3.8 on Chromium, 15.0 against 5.0 on WebKit) were measured on RAW backends, not on the node with the engine installed. The node's own dispatch overhead becomes the dominant term after the swap, so the number a consumer would actually get is currently unmeasured. `engine-seam-docs-and-honest-edges` publishes a figure in the README and needs this row to have a truthful one to publish.

## Acceptance criteria

- [ ] The conformance differential's read assertions (`eth_call` return data, `eth_estimateGas` values) pass with the revm engine installed, against the `@ethereumjs/vm` reference.
- [ ] The `stateMode` coverage is explicit: the mode the revm engine serves is exercised with it, the other keeps its existing default-engine coverage, and NO existing assertion is relaxed or skipped to accommodate revm.
- [ ] A benchmark backend row exists for the node WITH the revm engine, distinct from the raw-revm row and from the plain-node row.
- [ ] Cross-backend execution-gas equality holds for that row, against both the JS node and raw revm, on both browser engines.
- [ ] The keccak-chain result is identical across every backend including the new row.
- [ ] The frame scenario (100 small reads against a 16.6 ms budget) is measured for that row on both browser engines and reported, so the README can cite the node's own number rather than a raw-engine number. Reported, NOT asserted — the timing rows stay unasserted.
- [ ] Tests cover the new behaviour (mirror the repo's existing test style).

## Blocked by

- `revm-engine-subpath` — there must be a shipped engine to point these at.
- `retire-vendored-revm-in-benchmarks` — that task rewrites the same benchmark spec and backend directory; this one is serialised behind it to avoid a merge conflict.

## Prompt

> Goal: make the two existing correctness checks cover the NODE RUNNING ON REVM, which is the configuration a consumer will actually ship and the only one currently unmeasured.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? Read what `revm-engine-subpath` actually shipped — in particular WHICH `stateMode` its engine serves, and what it does when handed one it cannot — rather than assuming its shape. If it refuses a mode, that refusal decides how you wire the conformance battery.
>
> Read `CONTEXT.md` for *the gate* and *conformance differential*, the two things this task wires up.
>
> WHY THE GATE MATTERS, so you weight it correctly. Two EVMs that agree on every return value can still disagree on GAS, and would then disagree about where execution runs OUT of gas — a state fork for anyone replaying the chain. Matching results is NOT sufficient. This gate has already caught one real non-conformance: an EIP-2929 warmth leak in the raw-`runCall` backends, where the second and subsequent reads of a slot were charged a warm SLOAD (100) instead of a cold one (2100), silently, and every value still looked plausible. Expect it to be the check that earns its keep — the node's read path performs a warm/access reset before each pure call precisely because of this, and the revm engine has to preserve that behaviour.
>
> Where to look, by concept: the library's conformance helper builds a trie-backed `@ethereumjs/vm` reference by hand and diffs the node against it over a battery of signed transactions, and it runs that battery TWICE, once per state mode. The benchmark package has one spec that drives every backend through a shared scenario and asserts cross-backend equality; its backends live beside it, one file each, behind a small shared interface, and one of them already drives the node the way a real dapp does.
>
> THE TRAP TO AVOID. It is easy to make revm pass by loosening something: running the battery in only one mode for BOTH engines, skipping an assertion revm cannot meet, or quietly narrowing the raw-revm backend. Do none of those. If the revm engine cannot satisfy an existing assertion, that is a finding to surface, not a check to soften.
>
> Reference numbers, so a wrong answer is obvious: `number()` is 2446 execution gas, `sumTo(2000)` is 498689, `keccakLoop(2000)` is 1107052 and returns `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`. Every backend must agree exactly.
>
> Note the benchmark suite runs on two browser engines and takes minutes; its timing rows are load-sensitive and deliberately NOT asserted on. Only gas equality, keccak equality and the scenario results are assertions. Report the new row's frame timing; do not assert on it. WebKit also clamps `performance.now()` to 1 ms, so a sub-millisecond timing claim is meaningless there.
>
> Done means: the node on revm is an ordinary backend under the same checks as every other, and the README finally has a measured number for the configuration it recommends.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
