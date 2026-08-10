---
title: Upgrade to revm-wasm 0.4.0 and CLOSE the type-3 gap, execution and receipt, instead of documenting it
slug: document-the-type-3-receipt-gap-where-it-would-be-met
spec: revm-engine-behind-runtx
blockedBy: []
covers: [15]
---

## What to build

> **RE-SCOPED 2026-08-10, from "document the gap" to "close it", because the gap moved.** This task existed because the binding's result could not carry `blobGasUsed` / `blobGasPrice`, so a type-3 receipt could not be completed and the honest options were a refusal or a documented incompleteness. **`revm-wasm@0.4.0` is released and adds exactly those two fields**, so the receipt half is now closable in the ordinary way. The task's shape changes accordingly; story 15's requirement (a consumer must never receive a silently incomplete type-3 receipt) is unchanged and is now met by completing the receipt rather than by apologising for it.

Two halves, and both are now buildable.

**1. Execution.** `revm-executes-the-first-transaction-with-commit` mapped the node's transaction onto the binding's execute WITHOUT the blob fields, so a type-3 transaction on a revm-backed node currently executes as a 1559 one: `BLOBHASH` answers zero, and blob gas is neither charged nor validated, where the default engine charges and validates it. That is a live cross-engine divergence on a fork both engines admit. The binding accepts `blobVersionedHashes` and `maxFeePerBlobGas`, so map them and the divergence closes.

**2. The receipt.** Upgrade `revm-wasm` to `^0.4.0` in both packages and update the lockfile, then populate `blobGasUsed` and `blobGasPrice` on a type-3 receipt from the outcome. Verified against the published 0.4.0 tarball before this task was written: the change from `0.3.1` is purely ADDITIVE — `Outcome` gains those two `bigint` fields and the outcome format goes to version 4, while `instance.d.ts`, `host.d.ts`, `request.d.ts` and `spec.d.ts` are byte-identical. Nothing that exists today changes meaning, so the upgrade on its own is expected to be a version bump and a lockfile line.

Two details the binding's own documentation gives you, worth taking rather than re-deriving. The two fields are **unconditional** in the outcome, zero for a non-blob transaction, deliberately unlike the logs bloom whose conditionality it documents as the shape that bites a hand-rolled decoder. And both are revm's OWN numbers (`Transaction::total_blob_gas` and `Block::blob_gasprice`, the same `fake_exponential` rule the engine charges with), so use them rather than computing blob gas in JavaScript, for the same single-implementation reason `effectiveGasPrice` comes from the engine.

The node's own receipt type carries no blob fields on EITHER path, so this is node-wide work, not revm-specific: the default engine's type-3 receipts are equally incomplete today. Close both, or state plainly why one is left.

**What remains genuinely unimplemented is the blob FEE MARKET**, and it must not be papered over: the node has a constant fee market and does not track excess blob gas across blocks, so `blobGasPrice` will be whatever the block environment it passes implies. Decide and record whether the node sets a blob base fee at all, and if the honest answer is that a blob transaction is still not properly costed by THIS node, then story 15's stated limitation survives in a narrower and more accurate form: not "the receipt is incomplete" but "the node does not run a blob fee market". Say which, at the code site.

## Acceptance criteria

- [ ] `revm-wasm` is `^0.4.0` in `packages/embedded-eth-node` and `packages/benchmarks`, with the lockfile updated, and nothing else changes behaviour (the upgrade is additive; if anything moves, that is the finding).
- [ ] A type-3 transaction on a revm-backed node EXECUTES as a type-3 one: the versioned hashes are passed, `BLOBHASH` answers them, and blob gas is charged, matching `@ethereumjs/vm`.
- [ ] A type-3 receipt carries `blobGasUsed` and `blobGasPrice`, taken from the engine rather than computed in JavaScript, on both engine paths.
- [ ] A non-blob transaction is unaffected: the two fields are absent from its receipt (or zero, matching what the default engine reports), and its outcome decoding is unchanged.
- [ ] Whether the node runs a blob fee market is decided and recorded; if it does not, the remaining limitation is stated where a consumer meets it, in the honest-edge voice, and is about the FEE MARKET rather than about missing receipt fields.
- [ ] A changeset. This changes a published dependency range and what a type-3 receipt contains.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None. The upgrade is additive and the execution mapping is independent of the rest of the spec's spine.

## Prompt

> Goal: close the type-3 gap rather than document it. The binding gained the two fields that made it unclosable, so the reason for the old shape is gone.
>
> FIRST, check this task against current reality: it was re-scoped on 2026-08-10 when `revm-wasm@0.4.0` shipped, and may have DRIFTED again. Confirm the version the repo depends on, confirm `Outcome` really carries `blobGasUsed` and `blobGasPrice`, and confirm the execution mapping still omits the blob inputs. If any of that has moved, say so before building.
>
> Read the binding's outcome documentation (the two fields are UNCONDITIONAL and it says why), its execute options (`blobVersionedHashes`, `maxFeePerBlobGas`), the node's receipt assembly, and the node's own `SerializedReceipt`, which carries no blob fields on either path.
>
> TAKE THE ENGINE'S NUMBERS. Blob gas used and blob gas price are revm's own, computed by the same rule it charges with. Computing either in JavaScript would be a second implementation of protocol arithmetic, which is the drift `effectiveGasPrice` was already moved behind the engine to avoid.
>
> DO NOT PAPER OVER THE FEE MARKET. This node has a constant fee market and does not track excess blob gas across blocks. Populating two receipt fields does not make it a node that costs blob transactions correctly, so decide what it does about a blob base fee and record it. An honest narrow limitation is worth more than a receipt that looks complete.
>
> Done means: a blob transaction executes as one on both engines, its receipt carries the blob fields from the engine, and whatever is still not true about blob costing on this node is stated where someone meets it.
