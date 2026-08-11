---
title: The access-list request path loses a caller's list in one method and mis-prices it in another
slug: the-access-list-request-path-loses-and-mis-prices-what-a-caller-sends
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`eip-2930-access-lists-are-charged-and-warmed` made the MINED path right: a list is charged and warmed, proven absolutely and cross-engine. Gate 2 found three things still wrong about what happens to a list a CALLER sends to an RPC method.

**1. `eth_fillTransaction` silently drops a requested `accessList`.** It builds a type-0 or type-2 envelope and discards the field, so a caller who sent a list gets back a transaction without one, with no error. This is on viem's `prepareTransactionRequest` path, so it is reachable by ordinary client code doing the ordinary thing. Silent loss of caller-supplied data is the opposite of this repo's honest-edge convention: either carry the list into the envelope it belongs on, or refuse in the node's own words saying why.

**2. `eth_estimateGas` knowingly over-estimates for a list it charges.** It now adds the intrinsic per-address and per-key cost, which is right, but the read underneath carries no access list, so an entry the transaction really touches is priced COLD during execution. The estimate answers 26005 where the mined transaction pays 23505, up to 2,500 per touched address and 2,000 per touched key too high. The direction is safe and the skew is documented, but two things follow that are not merely cosmetic: geth does NOT have this gap, because its estimate pre-warms the list as well as charging it, and the README says the node charges it "as geth charges it", which is now true only of the charging half. Either widen the seam so the estimate's read carries the list, or correct the README claim so it does not overstate the parity.

**3. `accessListGas` tolerates a malformed list silently.** It never throws: a non-object entry is skipped, a non-array `storageKeys` is ignored, an array-shaped entry is still charged 2,400. So a malformed request produces a quietly different number rather than an error, on unvalidated JSON-RPC input. Charging duplicates per entry is correct and matches geth; the silent tolerance of shapes that are not access lists at all is the part to decide deliberately.

## Acceptance criteria

- [ ] A caller who sends an `accessList` to `eth_fillTransaction` either gets it back on the returned envelope, or gets the node's own error explaining why it cannot be carried. It is never silently dropped.
- [ ] The `eth_estimateGas` skew is resolved one of two honest ways: the estimate's read carries the access list so touched entries price warm, or the README stops claiming geth parity for a path where the node knowingly differs. If the skew is kept, its size and direction are stated where a consumer meets it.
- [ ] Whether a malformed access list is tolerated or refused is decided deliberately and recorded, and the behaviour matches the decision rather than falling out of the loop's shape.
- [ ] Asserted on BOTH engines, on the node's own answer, for whichever behaviours change.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] A changeset: items 1 and 2 change consumer-visible behaviour.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: an access list a caller sends survives the request path, and the node does not claim a parity it does not have.
>
> FIRST, check this task against current reality: it was written on 2026-08-11 and may have DRIFTED. Reproduce all three before changing anything, in particular the estimate skew, whose exact figures (26005 estimated versus 23505 mined) are pinned in `test/revm-access-list.spec.ts` and in `docs/spikes/eip-2930-access-lists-are-charged-and-warmed/measurements.md`.
>
> Read the `accessListGas` JSDoc and Decision 3 in that spike doc first: the over-estimate is KNOWN and was accepted deliberately, so this task is deciding whether to close it or to stop overstating it, not discovering it.
>
> On item 2, prefer widening the seam if it is clean. The estimate reading warm what the transaction will touch is what makes the number honest rather than merely safe, and the alternative leaves the node's own README describing a parity it does not have.
>
> On item 1, do not invent a third envelope shape. Either the list rides the type it belongs to, or the node refuses and says so.
