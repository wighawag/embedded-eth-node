---
title: Decisions taken while building 'upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks'
date: 2026-08-02
status: open
decisionsFor: upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks
---

# Decisions taken while building `upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks`

The done record's `## Decisions` block, kept here because the task body is moved byte-identical by the runner. Each entry: what was chosen, why, what was rejected, and what it touches. Ratify or reverse.

Entry condition first, because the task asked for it explicitly and it gates everything below: both probes were re-run against the INSTALLED `revm-wasm@0.3.1` before any source changed, rather than trusting the recorded numbers. `probe-initcode-costing.mjs` reports a word-boundary delta of **4** on `BERLIN`/`LONDON`/`MERGE` and **6** on `SHANGHAI`/`CANCUN`; `probe-hardfork-costing.mjs` still shows `GasFloorMoreThanGasLimit { gas_floor: 25000, gas_limit: 22600 }` on `PRAGUE`/`OSAKA` and `TxGasLimitGreaterThanCap { gas_limit: 30021000, cap: 16777216 }` for the node's 30M read budget on `OSAKA`. The premise held, so the build proceeded. Recorded as §7 of `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md`.

## 1. The fork parameter is the node's `Common` ITSELF, not a hardfork name and not a predicate

**Chosen:** `intrinsicGas(data, isCreate, common: Common)`, required (not optional), with the EIP-3860 term gated on `common.isActivatedEIP(3860)`. `node.ts` passes the `Common` it builds in `createNode()`; `src/revm.ts` captures `context.common` at `connect` (as `nodeCommon`) and passes that. Those are the SAME OBJECT: the node populates `ReadEngineContext.common` with its own `common`.

**Why:** `intrinsic-gas.ts` exists for exactly one reason — two callers must produce ONE number, because `node.ts` ADDS it to what the read engine reports and `src/revm.ts` SUBTRACTS it from revm's `totalGasSpent`, so any disagreement surfaces as an `eth_estimateGas` that differs by engine. Adding a fork-dependent term reopens that risk, and passing one object closes it structurally rather than by convention: the two callers cannot name different forks because there is only one thing being named. It is also the right authority rather than a convenient one — `isActivatedEIP` is the table `@ethereumjs/vm`'s `runTx` consults, so the read path charges a deployment exactly what this node's own transaction path spends on it. That is ADR 0008 clause (b)'s independent witness, now consulted in the PRODUCTION code and not only in the test. Cost is nil: `import type {Common}` erases, and the measured default-entry bundle is unchanged at 413.7 KB raw / 124.6 KB gzip.

**Rejected:** (a) a hardfork NAME (`'berlin' | 'shanghai' | ...`) — the formula would need its own activation table, i.e. a second copy in this repo of the knowledge that EIP-3860 arrived in Shanghai, which is precisely the duplication this file exists to prevent, and it would let the two callers pass different strings; (b) an `isActivatedEIP`-style PREDICATE (`(eip: number) => boolean`) — it keeps `intrinsic-gas.ts` import-free, which is mildly nice, but it buys decoupling nobody needs (both callers hold a `Common`), adds ceremony at both call sites, and lets a caller pass a hand-rolled lambda that lies; (c) a derived flags record (`{initcodeWordCost: boolean}` plus a `forkRulesOf(common)` deriver) — one more named concept in the glossary for a formula with exactly one fork-dependent term, and the deriver becomes the thing two callers can forget to share; (d) moving the intrinsic gas ONTO `ReadCallRequest` so the node computes it once and the engine reads it — genuinely the most drift-proof shape, and deliberately not taken: it changes a PUBLIC seam type that third-party engines implement, and re-architecting the seam is a larger decision than threading a fork through it. Worth revisiting if a second fork-dependent term ever arrives.

**Touches:** `src/intrinsic-gas.ts` (signature + gate), `src/node.ts` (both call sites, in `eth_estimateGas` and `eth_fillTransaction`), `src/revm.ts` (captures `nodeCommon` at connect). Any future task adding a term to this formula inherits the parameter. `clause-b-covers-only-eip-3860-not-the-rest-of-the-formula` in `work/tasks/backlog/` is the one that widens clause (b) beyond this single term and should read this first. Reversible in three lines, but reversing it re-splits the two engines on the pre-Shanghai forks, so the test would go red first.

## 2. A NEW refusal: `call()` before `connect()` throws, rather than costing at a guessed fork

**Chosen:** `src/revm.ts`'s `call` throws if `nodeCommon` is undefined, naming the cause and the fix ("Pass the engine to `createNode()` before using it").

**Why:** the engine now needs a fork to compute intrinsic gas, and there is no honest default. The pre-existing `spec = 'CANCUN'` / `chainId = 1n` initialisers are placeholders for exactly the same window, and both are silently wrong if that window is ever reached; adding a third placeholder would mean answering an `eth_estimateGas` computed under rules the caller never chose. This is the same shape as the store's existing unbound guard (`revm-state-store.ts`: "the engine read state before connect() bound it to a node"), which fires slightly LATER in the same broken scenario, so the new throw does not add a failure mode — it moves an existing one earlier and makes it say what is wrong.

**Why it is recorded at all:** it is a new user-visible ERROR, which the decision bar treats as a design choice rather than a factual gap. It is unreachable through `createNode()` (the seam always calls `connect` before the node serves a request), so it can only fire for a consumer driving a `ReadEngine` by hand.

**Rejected:** (a) defaulting `nodeCommon` to a fabricated Cancun `Common` — constructs an object to tell a lie, and matches the placeholders this decision is trying not to extend; (b) `nodeCommon!` with a non-null assertion — the same lie with no message when it is wrong; (c) making `connect` mandatory in the `ReadEngine` type — a public seam change affecting every engine implementor, far out of proportion.

**Touches:** `src/revm.ts` only. No test asserts it (nothing in the suite drives an unconnected engine); if that is unwelcome, deleting the guard and defaulting the fork is a two-line reversal.

## 3. Clause (b) is re-stated as "charged exactly where the protocol charges it", measured three ways

**Chosen:** `test/revm-engine.spec.ts` no longer requires `EIP-3860 active === true` at every admitted fork. Per admitted fork it now requires that three independent readings agree: `@ethereumjs/common`'s activation table, revm's per-word charge MEASURED by delta across an initcode word boundary, and the NODE's own `intrinsicGas()` measured by the same delta. It additionally asserts that the admitted set SPANS the EIP-3860 boundary (`admittedPreEip3860 === ['berlin','london','paris']`).

**Why:** the old assertion was satisfiable by an ungated formula and is now false by construction, since three admitted forks predate EIP-3860. The span assertion is what keeps the other three load-bearing: if a later change narrowed the admitted set back to Shanghai..Cancun, every per-fork reading would pass again with the gate deleted, and nothing would say so. Measuring the node's own formula (rather than reading the source) is what makes the gate itself the thing under test.

**Rejected:** keeping `paris` as a hardcoded pre-Shanghai counter-example outside the admitted set — `paris` is now IN the set, so the counter-example had to become a property of the set rather than a fork named beside it.

**Touches:** `test/revm-engine.spec.ts`, `test/helpers/revm-engine.ts`. The Prague/Osaka counter-examples for clause (a) are unchanged.

## 4. The cross-engine CREATE assertion runs BELOW `createNode()`, on the two read engines directly

**Chosen:** a new section in `test/helpers/revm-engine.ts` builds both read engines by hand for each admitted fork — `createEthereumjsReadEngine({evm: await createEVM({common, stateManager}), stateManager})` and `createRevmEngine(...)` connected with the same `common` — issues one CREATE-shaped read at each, and assembles the estimate with `node.ts`'s own line (`executionGasUsed + intrinsicGas(data, isCreate, common)`). It asserts the absolute numbers (53298 pre-Shanghai, 53302 from Shanghai) rather than only engine-against-engine equality.

**Why:** `createNode()` pins `Hardfork.Cancun` and `NodeOptions` exposes no hardfork, so a pre-Shanghai fork is unreachable through the node's public API — which is the same reason the existing hardfork-refusal checks call `engine.connect()` directly, so this follows a pattern the file already established rather than inventing one. Asserting the absolute numbers matters because two engines agreeing is exactly what `0.3.0` did while both were wrong; equality alone would have passed before this change was needed.

**Rejected:** (a) adding a `hardfork` option to `NodeOptions` to make it reachable through the node — a user-visible API widening this task did not ask for, and every other fork-gated concern in this repo (the EIP-7623 floor, the refusals) is tested below the node for the same reason; (b) asserting only `default === revm` — see above; (c) reusing one shared state manager for both engines — a CREATE derives its address from the sender's nonce, so each engine gets its own empty state.

**Touches:** `test/helpers/revm-engine.ts`, `test/revm-engine.spec.ts`. If `NodeOptions` ever gains a hardfork, this section should move up to the node and assert the same numbers through `eth_estimateGas` itself.

## 5. The test helper's mirrored formula was narrowed to CALLs (`intrinsicGasForCall`)

**Chosen:** the local mirror in `test/helpers/revm-engine.ts` lost its `isCreate` parameter and is now `intrinsicGasForCall(dataHex)`; the CREATE case is measured against the REAL exported `intrinsicGas()` instead.

**Why:** a mirror of a fork-gated formula is a trap — it would have to be gated too, and then the test would be asserting that the mirror agrees with itself. Every fork-dependent term in the shared formula applies to a CREATE, so a CALL's intrinsic gas is fork-independent and a mirror of it is still a genuine independent restatement (its only two uses, decomposing an estimate into execution gas and building the default read budget, are both CALLs). Removing the parameter makes the next person unable to reach for it on a CREATE by accident.

**Touches:** `test/helpers/revm-engine.ts` only.
