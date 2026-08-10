---
title: Document the type-3 receipt gap on the path that would produce one
slug: document-the-type-3-receipt-gap-where-it-would-be-met
spec: revm-engine-behind-runtx
blockedBy: []
covers: [15]
---

## What to build

revm supports blob transactions fully: `BLOBHASH`, `BLOBBASEFEE`, the blob gas price and the versioned-hash checks all work, and the engine's own differential covers thousands of blob transactions. What is missing is an INTERFACE omission: the binding's outcome does not surface `blobGasUsed` or `blobGasPrice`, so a type-3 receipt cannot be fully reconstructed from it. Verified against `revm-wasm@0.3.1`: the outcome blob's documented layout carries gas used, total gas spent, refunded, return data, logs, the bloom, per-account changes and the effective gas price, and no blob gas fields.

**The gap is NODE-WIDE, not revm-specific, and that is the part to get right.** `SerializedReceipt` carries no `blobGasUsed` / `blobGasPrice` on EITHER path, so a consumer on the DEFAULT engine already meets the silently incomplete receipt today. Scoping the honest edge to the revm path alone would leave the reachable half of story 15 open while appearing to close it. Cover both paths: whatever shape is chosen must be met by a consumer sending a type-3 transaction to this node, whichever engine is installed.

Type-3 transactions are not an intended use of this node, so the gap is ACCEPTED rather than closed. What is not acceptable is a silently incomplete receipt: a consumer who does reach for a blob transaction must find a STATED limitation at the point they meet it, in the honest-edge style this repo uses everywhere else. Say what is missing, why (an omission in the binding's result, not an engine limitation), and what closing it would take (a small addition to the binding).

Decide and record which shape the honest edge takes here, because the two are meaningfully different and the choice is the substance of this task: REFUSE a type-3 transaction on the revm path with an error naming the missing fields, or ACCEPT it and document that those two receipt fields are absent. Refusing is more honest if a partially-populated receipt would be mistaken for a complete one; accepting is better if the transaction itself executes correctly and only two receipt fields are unavailable. Whichever is chosen, a consumer must not be able to receive a type-3 receipt that LOOKS complete and is not.

Keep it small. This task is independent of every other task in this spec and can be done at any time.

## Acceptance criteria

- [ ] A consumer sending a type-3 transaction meets a stated limitation at that point, on BOTH engine paths: either a refusal naming the missing fields, or a receipt whose incompleteness is documented where it is produced.
- [ ] The choice between refusing and accepting is made explicitly, with the reasoning recorded at the code site.
- [ ] No type-3 receipt can be received that appears complete while `blobGasUsed` / `blobGasPrice` are missing.
- [ ] The documentation says what is missing, that it is an omission in the binding's RESULT rather than an engine limitation, and what closing it would take.
- [ ] The default `@ethereumjs/evm` path is covered too, since the receipt type omits the blob fields regardless of engine; if the two paths are handled differently, the difference is deliberate and its reason is recorded.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None — can start immediately, and is independent of the rest of this spec.

## Prompt

> Goal: make a consumer who reaches for a blob transaction find a stated limitation rather than a quietly incomplete receipt.
>
> FIRST, check this task against current reality: it was written on 2026-08-09 against `revm-wasm@0.3.1` and may have DRIFTED. Re-read the binding's outcome format at the version the repo actually depends on: if it now surfaces the blob gas fields, the gap is CLOSED and this task becomes closing it rather than documenting it, which is a better outcome and should be said plainly.
>
> Read the binding's outcome format documentation (it lists every field the result carries; there are no blob gas fields), the node's receipt assembly, and the repo's honest-edge convention plus the refusals that already follow it, so this one matches their voice.
>
> DECIDE, do not hedge. Refuse the transaction, or accept it and document the two absent fields. A middle state where a receipt is returned that looks complete is the one outcome this task exists to prevent.
>
> Check the DEFAULT path too before you scope this to revm. The receipt type omits those fields whichever engine ran the transaction, so the reachable half of this gap exists today and closing only the revm half would look like a fix while leaving it open.
>
> This is an interface omission upstream, not an engine limitation, and saying so precisely is part of the deliverable: a future reader should be able to tell that closing it is a small addition to the binding rather than a redesign.
>
> Keep it small and independent. It touches nothing the other tasks in this spec touch.
