---
title: Decisions taken while building 'intrinsic-gas-charges-eip-3860-on-forks-that-predate-it'
date: 2026-08-02
status: open
decisionsFor: intrinsic-gas-charges-eip-3860-on-forks-that-predate-it
---

# Decisions taken while building `intrinsic-gas-charges-eip-3860-on-forks-that-predate-it`

The done record's `## Decisions` block, kept here because the task body is moved byte-identical by the runner. Each entry: what was chosen, why, what was rejected, and what it touches. Ratify or reverse.

Context: the task offered three honest resolutions — gate the EIP-3860 term on the fork, refuse the forks that predate it, or record the exception — and asked for the evidence to pick one. Every number cited here is from `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/` (probe + measurements), and the durable rationale is the amendment to `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`.

The measured answer to the question the task asked first: the spike's claim was RIGHT and its conclusion was WRONG. `revm-wasm@0.3.0` does charge EIP-3860's initcode word cost on `BERLIN` / `LONDON` / `MERGE`, so the node and revm do agree there — and both are `2 * ceil(len/32)` gas above what the protocol charges (53296 vs 53292 for a 64-byte initcode), witnessed by `@ethereumjs/common`'s activation table and `@ethereumjs/tx`'s own intrinsic-gas arithmetic, which is what this node's `runTx` path charges a real transaction.

## 1. REFUSED rather than gated: `berlin`, `london` and `paris` leave `REVM_SPEC_BY_HARDFORK`

**Chosen:** the revm engine admits `shanghai, cancun` only, and refuses those three by name at `connect` with one shared reason naming EIP-3860, the shared file, the spike and ADR 0008. `src/intrinsic-gas.ts` keeps its UNCONDITIONAL EIP-3860 term.

**Why:** gating the term is measurably worse, not better. The engine subtracts `intrinsicGas()` from revm's `totalGasSpent` and the node adds the same number straight back, so on the revm engine the estimate IS revm's number whatever the formula says; a gate moves only the DEFAULT engine's estimate (53302 -> 53298) and leaves revm at 53302, converting an agreed wrong number into the cross-backend gas divergence the benchmark gate exists to catch. No change to this node alone can make those forks correct on this artifact, so refusal is the only resolution that leaves the code TRUE at every fork it admits. It is also cheap and consistent: the node pins Cancun and exposes no hardfork, so nothing a consumer can reach changes, and it is the same call ADR 0008 already made above the range.

**Rejected:** (a) gating the term alone — measured above, it splits the engines; (b) gating AND refusing — the gate branch would then be unreachable at every admitted fork and every fork the node can run, i.e. exactly the unexercised hardfork-gated arithmetic ADR 0008 refused to ship for EIP-7623, and it would have to thread a hardfork through a two-caller function whose entire value is that both callers share ONE answer; (c) recording it as a harmless exception — the over-charge is in the safe direction for a gas limit, but it is a plausible wrong number of exactly the shape ADR 0004's honest edge targets, it makes the node disagree with its own transaction path, and nothing downstream would ever notice it.

**Touches:** `packages/embedded-eth-node/src/revm.ts` (the two exported tables and their doc), `src/intrinsic-gas.ts` (doc only, no behaviour), README, ADR 0008, a `minor` changeset. Any consumer or task reading `REVM_SPEC_BY_HARDFORK` sees two entries instead of five — `readmit-prague-and-osaka-once-the-node-can-cost-them` and `harden-and-tidy-the-revm-hardfork-tables` in `work/tasks/backlog/` both touch this table and should be read with the amended rule in hand. Cheap to reverse: re-admitting a fork is a two-line move between tables, gated on the test below going green.

## 2. ADR 0008's admission rule gains a second clause rather than a new ADR

**Chosen:** amend ADR 0008 in place with a dated `## Amendment` section, and a pointer to it from the top. The rule is now: a fork is admissible when what the node computes about a transaction (a) agrees with what revm enforces under that spec AND (b) is what the PROTOCOL charges at that fork, judged by a witness that is neither of the two.

**Why:** it is the same decision ("which forks does this engine admit, and on what bar"), and splitting the bar across two ADRs would leave the first one stating a rule that is now known to be insufficient — the exact re-derivation this task exists to end. The repo's ADR format has no supersede-only convention, and one file per question keeps `REVM_REFUSED_HARDFORKS`' single ADR reference honest.

**Rejected:** a new ADR 0009 superseding 0008 (two files to read for one table, and 0008's Prague/Osaka reasoning is unchanged and still load-bearing); leaving the rule as written and just moving the entries (the bar that could not see this mis-costing would let the next one through, which is the task's stated point).

## 3. The protocol witness is `@ethereumjs/common`, asserted in the test per admitted fork

**Chosen:** `test/helpers/revm-engine.ts` now records, for every fork in `REVM_SPEC_BY_HARDFORK`, whether `@ethereumjs/common` says EIP-3860 is active and what revm charges PER INITCODE WORD (measured by delta across a word boundary: 32 bytes is one word, 33 is two, and the extra zero byte is worth 4 gas, so the delta is `4 + wordCost`). The spec requires `active === true` and `wordCost === 2` on every admitted fork, with `paris` asserted as the standing counter-example (`active === false`, `wordCost === 2`).

**Why:** clause (b) needs a third party, and `@ethereumjs/common` is one this repo already trusts — it is the table `@ethereumjs/vm`'s `runTx` consults to cost a real transaction on this very node, so it is not a formula re-typed for the test. Measuring revm's word cost rather than reading it off a table keeps the other half evidence-backed too: if a future `revm-wasm` fixes its spec gating, the delta changes and the test says so instead of silently agreeing. Re-admitting a pre-Shanghai fork now fails the build.

**Rejected:** asserting a hardcoded fork list in the test (a snapshot of intent, not of the code — the existing loop-over-the-exported-table pattern already avoids this); re-implementing EIP-3860's activation rule in the test (re-implements the rule under test, which is how both sides got here); enforcing clause (b) at runtime inside `connect` (it would duplicate the table that is already the source of truth, and pay for it on every construction).

## 4. `src/intrinsic-gas.ts` documents a fork RANGE, not just a forward edge

**Chosen:** the module doc now states that the formula is true for SHANGHAI..CANCUN and is wrong on BOTH sides of it, with the pre-Shanghai case written out — measured, why the term is deliberately not gated, and where the evidence is.

**Why:** the task's done bar is that nobody has to re-derive whether pre-Shanghai initcode costing is a bug. The previous doc only warned about moving the hardfork FORWARD, which is how this one stayed open: a reader looking at an ungated EIP-3860 term had no way to tell a considered decision from an oversight. Now the file says which it is, at the choice site.

**Rejected:** leaving the doc alone and relying on the ADR (the ADR is one link away and this is the line a reader is actually looking at).
