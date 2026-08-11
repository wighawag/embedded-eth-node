---
title: Decisions taken while building 'the-conformance-differential-covers-transactions-on-revm'
date: 2026-08-11
status: open
decisionsFor: the-conformance-differential-covers-transactions-on-revm
---

# Decisions taken while building `the-conformance-differential-covers-transactions-on-revm`

The done record's `## Decisions` block, kept here because the task body is moved byte-identical by the runner. Each entry: what was chosen, why, what was rejected, and what it touches. Ratify or reverse.

## 0. What had already DRIFTED, and what was left to build

The task was written on 2026-08-09 against a battery whose transactions still ran on `@ethereumjs/vm`. By the time it was claimed, every behaviour task under `revm-engine-behind-runtx` had landed: `connectEngine` now REFUSES an engine with no `transact` and the node has no fallback, so with a revm engine installed the battery's transactions already executed on revm, and `revm-conformance.spec.ts` already asserted `engineId === 'revm-wasm'` plus a long list of transaction-path step labels. Acceptance criteria 1 (in its weak reading) and 2 were therefore already met on arrival, and criterion 6's reference gas is asserted elsewhere (`test/revm-engine.spec.ts`) and untouched by this change.

What was genuinely missing, and what this change is: (a) the engine that executed the transactions is now COUNTED at the seam rather than inferred from what the node was built with, and (b) the three negative cases the spec names.

## 1. The executing engine is COUNTED at the seam, not read off `node.engine`

**Chosen:** `runBattery` wraps the injected engine factory in `countingEngines`, a delegating `Engine` that increments `transactionsByEngine[engine.id]` on entry to `transact`. Every node the battery builds goes through it, and the count lands in `BatteryReport.transactionsByEngine`, asserted both inside the battery (a new step, `every transaction ran on the installed engine`) and in `revm-conformance.spec.ts`.

**Why:** `engineId` is what the node was BUILT with. It would go on saying `revm-wasm` if the mining path ever went back to running `@ethereumjs/vm` itself, and then the battery would be diffing the reference EVM against itself: every receipt identical, zero mismatches, nothing measured. That vacuous pass is the failure the task exists to prevent, and only an observation of the CALLS can see it. Verified by mutation: with the counter removed, the step reports `engines that executed transactions: node=[] ref=["revm-wasm"]` and the spec goes red.

**Rejected:** trusting `node.engine.id` plus the `connectEngine` argument (true today, but it is an argument about code that may change, not a measurement); having the node report the executing engine itself (a production-code change to serve a test, for a property the test can observe from outside).

**Touches:** anyone adding an engine-parameterised step gets counted automatically. An engine that is handed a transaction and rejects it still counts, deliberately: it is still a transaction that ran nowhere else.

## 2. `transactionsByEngine` is `null` for the unparameterised run, and the NULL is asserted

**Chosen:** the field is `Record<string, number> | null`; `null` when no engine was injected. `conformance.spec.ts` asserts both modes report `null` and that the new step is ABSENT.

**Why:** the default engine is built inside `createNode()` from the node's own VM, so nothing outside can wrap it — and there is nothing to prove either, since the default IS the reference EVM. The alternative shapes were worse: a fabricated `{'@ethereumjs/evm': n}` would be a number nobody measured, and an always-present step whose default-engine branch asserts a tautology would read as coverage where there is none. Asserting the `null` and the absence keeps the gap deliberate rather than looking like a recorder that quietly stopped counting.

**Touches:** `conformance.spec.ts` (the default battery) now makes a negative assertion. If someone later finds a way to observe the default engine, both specs move together.

## 3. The three negative cases go in the BATTERY even though the behaviour is covered elsewhere

**Chosen:** added as steps 19-21 of `test/helpers/conformance.ts`, each stating what it adds over the existing coverage in a comment.

**Why, per case.** The replay and the unaffordable transaction are covered in depth by `test/helpers/invalid-transactions.ts` (JSON-RPC code, the node's exact words, character-for-character equality across engines, wei-exact boundaries), and the storage-clearing refund by `test/helpers/fees.ts` (three balance flows plus the burn, on a 7-wei fee market, pinned to literals). What NEITHER can say is what the battery says: both of those helpers use a default-engine NODE as their reference, i.e. the same node code, so a refusal the node invents is refused identically on both of their chains and diffs clean — which is exactly why `revm-invalid-transactions.spec.ts` has to pin literals on top. Here the oracle is the hand-wired trie-backed `@ethereumjs/vm` `runTx` that owes the node nothing: it refuses the same two transactions, and the refund's net `gasUsed` (and therefore its price) is diffed against it field by field on the node's own default fee market. So this is a second READING under a different oracle, not a second copy of the same statement.

**Rejected:** adding nothing and reporting the criterion as already met (the spec names these three, and the reference-oracle reading is the one the battery uniquely provides); moving the deep assertions out of the two helpers into the battery (they are asking a different question, and the note `fees-report-files-setup-failures-under-mismatches` shows those helpers have their own vocabulary).

**Touches:** the battery is ~1.5x its previous transaction count in wall-clock terms (still under 1.5 s per spec). Anyone editing `invalid-transactions.ts` or `fees.ts` should know the battery now also fails on these behaviours, in the node's own default fee market.

## 4. The three cases run LAST, on the main node, rather than being renumbered into the middle

They depend on the whole sequence above having happened — a nonce can only be REPLAYED once it has been spent — and steps 14-18 build their own nodes and never touch the main node or its reference, so appending keeps them nonce-aligned. The alternative was inserting them after step 13 and renumbering five existing step comments, which is diff noise in a file several in-flight tasks read.

## 5. No oracle moved, so `CONTEXT.md` is unchanged

The task says the glossary must move with any step whose oracle changes. None did: the two refusal steps are judged BY the trie-backed reference (it refuses too), the refund's receipts and post-state are diffed against it, and the absolute companions they carry (no block mined, the sender ends at zero, a refund really happened) are the same shape the existing receipt steps already carry. The new engine-execution step is not an oracle question at all — it is a run-validity control, the same family as the existing `if (basefee === 0n) ... step proves nothing` guards, which the glossary likewise does not enumerate. The known undercount in that prose is already owned by `work/tasks/backlog/the-prose-undercounts-the-conformance-batterys-non-reference-oracles.md`, which explicitly tells its builder to count the comment blocks rather than trust a number, so nothing here was pre-empted.

## 6. `sendTx` / `blockNumberOf` / `nonceOf` were hoisted out of step 18 rather than copied

The block-gas-limit step had local helpers of exactly the shape the negative cases need. They were hoisted to the battery's helper section (`sendTx` renamed `submitTo`, `nonceOf` given an optional address) and step 18's four call sites renamed. Pure movement: same code, same behaviour, no assertion or label touched. The alternative was a second copy plus a comment admitting it was a copy.

## 7. No changeset

`packages/embedded-eth-node/src/` is untouched: this change is tests only. Same reading as `value-bearing-conformance-steps-assert-the-failure-shape`, which shipped without one, and the same rule `CONTEXT.md`'s conventions state (a changeset is for a user-facing change).
