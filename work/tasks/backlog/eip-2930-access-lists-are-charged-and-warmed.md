---
title: EIP-2930 access lists are charged and warmed on the revm transaction path
slug: eip-2930-access-lists-are-charged-and-warmed
spec: revm-engine-behind-runtx
blockedBy: [logs-and-the-logs-bloom-come-from-the-engine]
covers: [7]
---

## What to build

> **RE-SCOPED 2026-08-10 by the conductor, after `fees-refunds-and-effective-gas-price-come-from-the-engine` landed. The MAPPING half and part of its proof are already DONE; do not rebuild them.** `packages/embedded-eth-node/src/revm.ts` already maps `tx.accessList` onto the binding's execute options (and names this task in a comment while doing it), and the new fees battery pins an `access2930` case at `gasUsed` 25300 absolutely (21000 + 2400 + 1900) on BOTH engines, so the revm path is now MEASURED to charge an access list rather than merely assumed to. Verify both of those still hold, then spend this task on what is genuinely outstanding: the WARMING half (that a charged entry actually makes the access inside execution cost warm rather than cold), the entries-never-touched shape, and the addresses-only shape. If the mapping has regressed, that is the finding; say so rather than quietly re-adding it.

A type-1 transaction carries an access list, and the list is not decoration: it is charged up front (per address and per storage key) and it pre-warms those entries so the accesses inside execution cost warm rather than cold. Get both halves right on the revm path, and prove it by the only means that cannot be faked: the gas.

The binding takes the access list directly on its execute options, so the work is the mapping from the node's parsed transaction into it, plus the proof. The proof is a differential AND an absolute: the same type-1 transaction must cost the same gas on both engines, AND the gas must actually differ from the same transaction sent without the list, in the direction and by the amount EIP-2930 specifies. Without that second half a mapping that silently drops the list passes, because both engines would then be charging the same wrong number.

Cover an access list that names addresses only, one that names storage keys, and one whose entries are never actually touched during execution (which is a real shape: it is charged and buys nothing, and it is the case where "we dropped the list" is otherwise invisible).

## Acceptance criteria

- [ ] A type-1 transaction's access list is passed to the engine and reflected in the gas charged on the revm path.
- [ ] The same type-1 transaction costs identical gas on both engines, and produces identical receipts and post-state.
- [ ] The list is proven LOAD-BEARING: the same transaction with and without the list differs in gas by the EIP-2930 amount, so a dropped list fails the build rather than passing as agreement.
- [ ] Address-only entries, storage-key entries, and entries never touched during execution are all covered.
- [ ] The transaction type on the resulting receipt is correct for a type-1 transaction on both engines.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- `logs-and-the-logs-bloom-come-from-the-engine` — same files; deliberately serialized.

## Prompt

> Goal: honour EIP-2930 access lists on the revm transaction path, and prove they are actually doing something.
>
> FIRST, check this task against current reality: it was written on 2026-08-09 and may have DRIFTED. Confirm the conformance battery still sends a type-1 transaction with a real access list (it did at tasking time) and that the seam carries one, so you extend the existing coverage rather than duplicating it.
>
> Read how the node parses a type-1 transaction, the engine seam's transaction request, and the binding's access-list option.
>
> A CROSS-ENGINE DIFF IS NOT ENOUGH HERE. If the mapping drops the list, both engines charge the same number and agree perfectly. The assertion that catches it is absolute: with the list versus without it, the gas must differ by what EIP-2930 says. Write that one first.
>
> Include an access list whose entries are never touched. It is charged and buys nothing, which is exactly why a dropped list is invisible on it by any other measure.
>
> Do not derive the transaction type by hand if the binding can derive it from the fields; its own documentation says the derivation is the part most easily got wrong by hand.
