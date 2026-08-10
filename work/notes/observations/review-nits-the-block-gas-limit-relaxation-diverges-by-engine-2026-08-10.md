---
title: review-gate non-blocking nits for 'the-block-gas-limit-relaxation-diverges-by-engine' (Gate 2 approve)
date: 2026-08-10
status: open
reviewOf: the-block-gas-limit-relaxation-diverges-by-engine
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'the-block-gas-limit-relaxation-diverges-by-engine' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the in-scope design decision the task did not specify: the NODE answers the refusal itself, at submit, ahead of both engines, with a new RpcError code -32000 (the first use of -32000 in this codebase; existing codes are 3, -32004, -32601). Consequences worth a human nod: it applies to all four submit RPCs including the evm_*As cheats, an over-limit tx now throws at eth_sendRawTransaction* instead of sitting in pending under manual/interval mining, the same rule is now enforced in three places (node + both engines as backstop), and the refusal prose re-pins the default bundle baseline 417.2 -> 417.8 KB raw paid by every consumer including the JS-only one. The task only required that the refusal be legible on both engines; the pre-flight placement was the agent's call. It is recorded in the changeset and at the code site, but there is no Decisions block and it was never ratified.
  (src/node.ts:606-648 (refuseIfOverBlockGasLimit, called from submit); .changeset/block-gas-limit-is-enforced.md; packages/benchmarks/test/evm.spec.ts DEFAULT_ENTRY_BASELINE)
- The refusal names the wrong knob on a node created with blockEnv.gasLimit. minedBlockGasLimit is blockEnv?.gasLimit ?? blockGasLimit, so blockEnv WINS, yet the error's one actionable instruction is createNode({blockGasLimit: Xn}), which such a node would ignore; only the trailing clause mentions blockEnv.gasLimit, and as a statement about the default rather than as the knob to turn. Narrow (BlockEnv is documented as mined-block header overrides, e.g. for GeneralStateTest env) but this is exactly the legibility criterion the task made acceptance. No test covers the blockEnv path.
  (src/node.ts:318 (precedence) vs src/node.ts:634-640 (the message))
- Doc drift this branch created and did not sweep: ADR 0006 still says @ethereumjs/vm's TWO skip*Validation flags stayed INSIDE the default engine, and justifies it with revm refusing to combine its equivalent relaxation with committing, which is the reasoning for the exact flag this branch DELETED. Line 49 repeats the two skip*Validation flags. ADR 0006 is a live, actively amended doc (it already carries three dated amendments for this seam), and the agent filed an observation note for the analogous stale phrasing in ADR 0008, so the sweep is incomplete by its own standard. Either a dated amendment or a second observation note.
  (docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md:26 and :49; compare work/notes/observations/adr-0008-calls-the-read-budget-the-block-gas-limit.md)
- The equality boundary is unasserted. src/node.ts claims a transaction that passes here passes there, resting on three separate comparisons agreeing: the node's gasLimit <= minedBlockGasLimit, runTx's block.header.gasLimit < tx.gasLimit, and revm's CallerGasLimitMoreThanBlock (revm receives tx.gasLimit raw in transact, with no intrinsic added, unlike the read path). The battery only exercises 40M vs 30M, 40M vs 60M and 60M+1 vs 60M. A transaction whose gas limit EQUALS the block limit is the only point where an off-by-one or a future intrinsic add in transact would reopen a cross-engine divergence of precisely the class this task exists to remove, and nothing pins it.
  (src/node.ts:616-628; src/revm.ts:451 (gasLimit: tx.gasLimit); test/helpers/conformance.ts step 15 fixtures)
