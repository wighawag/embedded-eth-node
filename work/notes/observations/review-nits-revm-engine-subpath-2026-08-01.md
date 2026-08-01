---
title: review-gate non-blocking nits for 'revm-engine-subpath' (Gate 2 approve)
date: 2026-08-01
status: open
reviewOf: revm-engine-subpath
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'revm-engine-subpath' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the block-environment divergences a revm read introduces: baseFeePerGas is forced to 0n on every read (so BASEFEE reads 0 on revm and the block's real 1 gwei on @ethereumjs/evm), and revm-wasm 0.1.0's BlockEnv has no prevrandao field (so PREVRANDAO cannot be given NodeOptions.blockEnv.prevRandao). Both are forced by the package (verified: ExecuteOptions/BlockEnv expose no disable-base-fee or prevrandao knob) and neither affects gas, so the cross-backend gate cannot see them. Forward-note for revm-engine-under-conformance-and-gate: its read battery will diverge if it ever reads block.basefee or PREVRANDAO.
  (src/revm.ts call(); decisions note items 1 and 2; revm-wasm dist/types.d.ts BlockEnv)
- Ratify two NEW loud refusals this task introduces beyond the one the task specified (stateMode trie): (a) one engine instance serves ONE node, so handing an already-connected engine to a second createNode() throws; (b) an unknown hardfork throws rather than silently running Cancun rules. Both are user-visible and (a) constrains the write half in revm-engine-behind-runtx to keep one store per node.
  (src/revm-state-store.ts bind(); src/revm.ts SPEC_BY_HARDFORK + connect(); decisions items 4 and 11)
- SPEC_BY_HARDFORK admits PRAGUE and OSAKA, but the shared src/intrinsic-gas.ts implements only the pre-Prague formula (no EIP-7623 calldata floor, which revm does enforce: GasFloorMoreThanGasLimit is in the wasm's error set). So a future hardfork move would PASS the guard that exists to stop silent divergence, then diverge on gas for calldata-heavy calls. Worth either narrowing the table to the forks whose intrinsic gas the helper models, or noting the coupling at the code site.
  (src/revm.ts SPEC_BY_HARDFORK; src/intrinsic-gas.ts)
- The documented gas-limit divergence window understates itself. The code comment says the cap only bites for a call within intrinsic gas of the whole block limit, on the premise that the node's default read budget IS the block gas limit. But node.ts evmCall hardcodes a 30M default read budget while blockGasLimit is configurable, so a consumer calling createNode({blockGasLimit: 10n**7n}) gets a revm read capped at 10M where the default engine gives execution the full 30M: the two engines then disagree about where a heavy eth_call runs out of gas. Narrow, but it is exactly the class the gate cares about.
  (src/revm.ts call() gasLimit cap vs node.ts:674 (gasLimit default 30_000_000n) and node.ts:113 (blockGasLimit option))
- EIP-3607 looks unexamined. revm's error set includes RejectCallerWithCode and revm-wasm 0.1.0 exposes no cfg flag to disable it, so an eth_call with from set to a CONTRACT address (smart-account / multicall simulation) may fail validation on revm while succeeding on @ethereumjs/evm, surfacing as execution reverted with empty data. This is the third member of the family the agent already handled twice (base fee, balance); has it been checked?
  (strings in revm-wasm/wasm/revm.wasm include RejectCallerWithCode; src/revm.ts sets no such option)
- Bucket polarity: the decisions record lives in work/notes/observations/, whose contract meaning is spotted/unverified/append-only, but its content is decisions WE made plus why, which the contract routes to docs/adr/. Items 1 and 11 in particular (the zero-base-fee read environment; one-engine-one-node) are durable and hard to reverse. Should they be promoted to an ADR or appended to ADR 0005/0006 rather than left in an observation with status open?
  (work/notes/observations/decisions-revm-engine-subpath-2026-08-01.md; WORK-CONTRACT bucket polarity)
- Two acceptance criteria are met by intent rather than literally, both recorded: the bundle criterion says the default entry has NOT grown, yet the pinned baseline is the POST-change 412.4 KB (it was 412.3), the 0.1 KB being the core-side getBlockHash accessor another criterion of this same task mandates; and the comlink criterion is asserted with the DEFAULT engine's id round-tripping, not a revm engine (an engine cannot be structured-cloned into a worker, which engine-seam-docs-and-honest-edges owns). Both readings look right; confirm.
  (packages/benchmarks/test/evm.spec.ts DEFAULT_ENTRY_BASELINE + metafile revm check; test/worker.spec.ts readEngineId; decisions items 7, 9, 12)
