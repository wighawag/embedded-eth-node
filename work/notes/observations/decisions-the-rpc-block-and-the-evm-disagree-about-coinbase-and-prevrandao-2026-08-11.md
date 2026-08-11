---
title: Decisions taken while building 'the-rpc-block-and-the-evm-disagree-about-coinbase-and-prevrandao'
date: 2026-08-11
status: open
decisionsFor: the-rpc-block-and-the-evm-disagree-about-coinbase-and-prevrandao
---

# Decisions taken while building `the-rpc-block-and-the-evm-disagree-about-coinbase-and-prevrandao`

The done record's `## Decisions` block, kept here because the task body is moved byte-identical by the runner. Ratify or reverse.

## 1. REPORT the real values, do not document the omission

**Chosen:** `eth_getBlockByNumber` / `eth_getBlockByHash` now report the block's real `miner` and `mixHash`, and a real `logsBloom` (the OR of the block's receipt blooms). `SerializedBlock` carries all three, so they survive a `dumpState` / `loadState` round trip.

**Why:** the task offered either route and asked for the reporting one if the persistence change stayed small. It did: three optional fields on one interface, three lines in `storeBlock`, three in `blockToRpc` and a widened header in `loadState`. Nothing in the IndexedDB adapter, the worker proxy or the conformance battery had to change. The omission also turned out to be worse than the note recorded: `eth_call` executes against the STORED `Block` object, so after a reload the EVM itself handed contracts a zero `COINBASE` / `PREVRANDAO` on a node configured with both. Documenting that would have meant documenting a node that changes its own execution semantics across a page reload.

**Rejected:** stating the omission in the README (it leaves a `blockEnv.coinbase` option whose value nothing reports, and would not have fixed the post-reload `eth_call`); reading the values off `sb.block` in `blockToRpc` without persisting them (right before a reload, zero after it — the trap the task named).

**What it touches:** the RPC output of two methods (a consumer whose tooling read a constant zero `miner` now gets the configured one), the persisted format, and `packages/embedded-eth-node/README.md`'s RPC surface row. A `minor` changeset accompanies it.

## 2. The persisted format is BACKWARD-COMPATIBLE optional fields, `version` stays `1`

**Chosen:** `miner`, `mixHash` and `logsBloom` are optional on `SerializedBlock`; `SerializedState.version` is still `1`. Absent `miner` / `mixHash` read as the zero address / zero hash rather than as a missing RPC field, and an absent `logsBloom` is REBUILT on load from the receipts the dump already carries.

**Why:** the criterion is that a state dumped by the current version still loads, and it does, unchanged. A bump would have bought nothing a reader can act on (no code branches on `version`) while invalidating every IndexedDB record in the wild for a format they can still be read as. Recorded on `SerializedState` itself, with the rule for when to bump: when a dump stops being loadable by the code that wrote it.

**Rejected:** `version: 2` plus a migration (a migration for three optional fields); defaulting the old bloom to zero (that is exactly the silent-nothing pre-filter this change closes, and the receipts to rebuild it from are right there).

**What it touches:** any consumer that hand-writes a `SerializedState`, and `test/fixtures/dumpstate-flat-layout.json` (an old dump, which still loads and is asserted to).

## 3. Genesis honours `blockEnv`'s `coinbase` and `prevRandao` ONLY

**Chosen:** block 0 now takes `blockEnv.coinbase` and `blockEnv.prevRandao`. It does NOT take `number`, `timestamp` or `gasLimit`.

**Why:** the task asked for "the genesis block honours `blockEnv` too" in a paragraph about those two fields. Those two describe the environment the CHAIN runs under, so a block 0 reporting a zero miner while every later block reports the configured one is the same RPC-vs-EVM disagreement, one block wide. The other three place a block within a chain: `blockEnv.number` exists to put a MINED block at a chosen height, and applying it to genesis would renumber block 0 and break `eth_blockNumber`, the block store's keys and every GeneralStateTest fixture that sets it.

**Rejected:** honouring the whole of `blockEnv` at genesis (breaks block 0); leaving genesis alone (the note flagged it explicitly as part of the same defect).

**What it touches:** `NodeOptions.blockEnv`'s documentation (which used to say "not genesis") and the genesis block HASH for any node configured with either field. Nothing asserts a literal genesis hash.

## 4. The conformance block-environment oracle was NOT unwound; the `gasUsed` placeholder was NOT fixed

**Chosen:** step 16 of the conformance battery still diffs `COINBASE` / `PREVRANDAO` against the configuration, not against the now-honest RPC block. Only its explanatory comment (and the matching clause in `CONTEXT.md`) changed, from "the RPC block reports neither" to "it now does, and unwinding the split is its own change" — pointing at `work/notes/observations/conformance-block-env-oracle-can-now-diff-all-six.md`. Separately, the header's always-zero `gasUsed` was left as it is and captured in `work/notes/observations/rpc-block-gasused-is-always-zero.md`.

**Why:** the task forbade the first as a side effect, and swapping an oracle changes what a step can catch. The second is the same defect class but was not in scope; it is now at least STATED in the README's `eth_getBlockByNumber` row so a consumer meets it, which is the honest half that costs nothing.

**What it touches:** two follow-up notes, and the `conformance differential` glossary entry in `CONTEXT.md`.

## 5. The suite is NOT engine-parameterised

**Chosen:** `test/rpc-block.spec.ts` runs on the default engine only; there is no `revm-rpc-block.spec.ts` twin.

**Why:** block construction, the block list and the RPC layer are the node's on every engine (`CONTEXT.md`, *engine*), so a twin would re-measure the node's own serialisation. The one engine-sensitive reading here, what a contract is told the block environment is, is already diffed on BOTH engines by the conformance battery's `block environment through a contract` step.

**What it touches:** nothing else; `test/helpers/rpc-block.ts` is reached from `cut.ts` only, not from `cut-revm.ts`.
