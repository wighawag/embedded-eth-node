---
title: The type-3 comments describe a path that cannot be reached, in three places now
slug: the-type-3-comments-describe-a-path-that-cannot-be-reached
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

Three comments in `packages/webevm/src` describe a blob (type-3) transaction as something the node ADMITS and an engine then refuses. It cannot happen: the node cannot PARSE a type-3 transaction at all. `parseTx` hands raw bytes to `@ethereumjs/tx`, whose 4844 constructor throws unless `common.customCrypto.kzg` is set, and the node's `Common` sets only `keccak256`. The throw is above the engine seam, so it is identical on both engines and nothing downstream is reached. This is verified and recorded in `work/notes/observations/the-node-cannot-parse-a-type-3-transaction-at-all.md`.

The three sites:

- `src/revm.ts`, in the `transact` request mapping, says the type-3 receipt is incomplete on BOTH engines because the seam's result carries no `blobGasUsed` / `blobGasPrice`. The absent fields are real; the framing is not, because no consumer ever gets that far.
- `src/node.ts`, the `upfrontCost` JSDoc, says a type-3 transaction is admitted by the node and refused by the engine as the backstop.
- `src/revm.ts` again, in the newer `transact` comment enumerating what still reaches the validation-error line, listing a blob transaction's blob fee as one such cause.

This is worth its own task because it is drifting in the wrong direction: the first sentence was already flagged as false, and two more were then written in the same shape by a later task that read them. A comment that describes an unreachable path is worse than no comment, because the next author reasons from it, as has now happened twice.

**Do NOT decide the type-3 question here.** Whether this node should carry a KZG implementation, shim one, or refuse type-3 in its own words is a published-dependency and wire-format decision parked for the maintainer in `work/questions/task-document-the-type-3-receipt-gap-where-it-would-be-met.md`. This task only makes the COMMENTS true about the node as it is today. If that decision has landed before you start, say so and stop, because the comments should then describe the new behaviour rather than this one.

## Acceptance criteria

- [ ] No comment in `packages/webevm/src` describes a type-3 transaction reaching an engine, a receipt, or a validation backstop.
- [ ] Each of the three sites instead states what is actually true: a type-3 transaction is rejected during parsing, above the engine seam, identically on both engines, and the rejection is an internal `@ethereumjs/tx` error rather than one of the node's own.
- [ ] The absent `blobGasUsed` / `blobGasPrice` fields are still recorded as a real gap where that is useful, without implying a consumer can observe them missing.
- [ ] No behaviour change and no changeset: comments only. If you find yourself editing executable code, the scope is wrong.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: three comments stop describing a code path no transaction can reach.
>
> FIRST, check this task against current reality: it was written on 2026-08-10 and may have DRIFTED. Re-verify the parse failure yourself before rewording anything: construct a signed canonical type-3 transaction, send it, and observe where it dies. Do not take this task's word for it, and do not take the existing comments' word for it either, since being wrong is exactly what they are accused of.
>
> Read `work/notes/observations/the-node-cannot-parse-a-type-3-transaction-at-all.md` first; it carries the mechanism and the file positions.
>
> Keep this repo's honest-edge voice: say what is true, where a reader meets it, without apologising and without overclaiming. An unreachable path described as reachable is the specific defect being removed.
