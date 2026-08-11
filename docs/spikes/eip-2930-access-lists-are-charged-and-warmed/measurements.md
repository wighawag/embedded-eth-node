# EIP-2930 access lists: charged, warmed, and what each mutation does to the numbers

Task: `eip-2930-access-lists-are-charged-and-warmed` (spec `revm-engine-behind-runtx`, story 7). Measured 2026-08-11 on `revm-wasm@0.3.1` + `@ethereumjs/vm@10.1.2`, Cancun, chromium, by `packages/embedded-eth-node/test/revm-access-list.spec.ts` and its battery `test/helpers/access-list.ts`.

Everything below is a run of that battery. It is kept because the interesting part of this task is not the code, it is WHICH ASSERTION FAILS WHEN THE LIST GOES MISSING, and that is only credible as a measurement.

## 1. The numbers, both engines, unmutated

Every arm is a type-1 (EIP-2930) transaction; the "without" arms carry an EMPTY list rather than a different transaction type, so the only difference within a case is the list itself. `BALANCE_PROBE` is `PUSH20 <addr>, BALANCE, POP, STOP` (3 + access + 2); `SLOAD_PROBE` is `PUSH1 07, SLOAD, POP, STOP` (3 + access + 2).

| arm | list | gasUsed (both engines) | arithmetic |
|---|---|---|---|
| `addressTouched.cold` | empty | 23605 | 21000 + 3 + **2600 cold account** + 2 |
| `addressTouched.listed` | 1 address (touched) | 23505 | 21000 + **2400** + 3 + **100 warm** + 2 |
| `keyTouched.none` | empty | 23105 | 21000 + 3 + **2100 cold storage** + 2 |
| `keyTouched.addressOnly` | callee, no keys | 25505 | 21000 + **2400** + 3 + 2100 + 2 |
| `keyTouched.addressAndKey` | callee + its slot | 25405 | 21000 + **2400 + 1900** + 3 + **100 warm** + 2 |
| `untouched.none` | empty | 21000 | a bare transfer |
| `untouched.listed` | 1 address + 2 keys, never touched | 27200 | 21000 + **2400 + 2 * 1900** |

The differences are what identify a failure rather than merely reporting one:

| difference | value | what it means |
|---|---|---|
| `addressTouched.listed - addressTouched.cold` | **-100** | charged 2400 AND warmed (saved 2500) |
| `keyTouched.addressOnly - keyTouched.none` | **+2400** | charged, bought nothing: the callee was already warm |
| `keyTouched.addressAndKey - keyTouched.addressOnly` | **-100** | the key charged 1900 AND warmed (saved 2000) |
| `untouched.listed - untouched.none` | **+6200** | charged in full, buys nothing at all |
| any of the above | **0** | the list was DROPPED |

`eth_estimateGas`, identical on both engines: 21000 for the `untouched` request without its list, **27200 with it**, and 26005 for the `addressTouched` request (21000 + 2400 + 3 + 2600 + 2), which is 2500 ABOVE the 23505 the mined transaction pays because the read underneath carries no access list and prices the `BALANCE` cold. Over-estimating is the safe direction; see the `accessListGas` JSDoc in `packages/embedded-eth-node/src/intrinsic-gas.ts`.

## 2. THE MEASUREMENT THIS TASK EXISTS FOR: a dropped list is INVISIBLE to the cross-engine differential

Mutation: the battery signs every "listed" arm with an EMPTY access list, which is what a node that dropped `tx.accessList` on the way to BOTH engines looks like from outside.

```
mismatches: []
underTest gas: addressTouched.cold 23605, addressTouched.listed 23605,
               keyTouched.none 23105, keyTouched.addressOnly 23105,
               keyTouched.addressAndKey 23105,
               untouched.none 21000, untouched.listed 21000
reference gas: (identical, field for field)
```

`mismatches` is EMPTY. The two engines agree perfectly, every receipt matches field for field and the post-state is identical, and a protocol charge has silently disappeared. Every differential in this repo (the conformance battery, the post-state battery, the fees battery's cross-engine half, the cross-backend gate in `packages/benchmarks`) stays green through this. What goes red is only the ABSOLUTE pin and the four differences above, which is why they are the assertions this battery leads with.

## 3. The mapping is load-bearing: `src/revm.ts` drops the list

Mutation: delete the `accessList` mapping from `ExecuteOptions` in `createRevmEngine().transact` (the block that names this task in its comment).

```
mismatches: [
  "addressTouched.listed.gasUsed:    reference=23505 underTest=23605",
  "keyTouched.addressOnly.gasUsed:   reference=25505 underTest=23105",
  "keyTouched.addressAndKey.gasUsed: reference=25405 underTest=23105",
  "untouched.listed.gasUsed:         reference=27200 underTest=21000"
]
```

Every arm that names an entry loses exactly the charge, and the warming with it: `keyTouched.addressAndKey` falls to 23105, the price of the no-list arm, so the 1900 was not paid and the SLOAD went back to costing 2100. This one IS caught by the cross-engine diff (only one engine was mutated), which is the case section 2 says nothing can be relied on to catch.

## 4. `eth_estimateGas` before the fix: the node refused its own advice

The battery run BEFORE `accessListGas` was added to the `eth_estimateGas` case of `src/node.ts`, verbatim:

```
estimates (both engines): untouched.none 21000, untouched.listed 21000,
                          addressTouched.listed 23605
atEstimatedGas (both engines):
  gasLimit 21000
  outcome  "refused: intrinsic gas too low: have 21000, want 27200. A transaction
            pays a 21000 base plus its calldata (and its access list, and 32000
            more to create a contract) before its first opcode runs, so this gas
            limit could not start it and no block this node builds could contain
            it. Raise the gas limit to at least 27200 - eth_estimateGas reports
            what a transaction needs."
```

The refusal names the floor (27200), tells the caller that `eth_estimateGas` reports what a transaction needs, and `eth_estimateGas` then answers 21000: the node refuses the number it has just recommended, on BOTH engines. After the fix the same run reads `gasLimit 27200, outcome "mined 0x1"`.

## Decisions

Recorded here because each is a user-visible choice this task had to make, not a factual gap (linked from the task's done record; see also the JSDoc at each choice site).

**1. `eth_estimateGas` CHARGES a request's access list; `eth_fillTransaction` does not.** The acceptance criterion allowed either charging it or qualifying the refusal's guidance. Charging it was chosen because the estimate is what a client turns into a gas limit, and an estimate below the node's own intrinsic floor is a number the node will refuse (section 4). It is also what geth does: `eth_estimateGas` honours the request's `accessList` field. `eth_fillTransaction` deliberately does NOT charge it, because the transaction it fills and returns builds a type-0 or type-2 envelope and drops the field, so charging for a list its own answer does not contain would hand back a gas limit for a different transaction. Alternative considered and rejected: leave the estimate alone and qualify the refusal message to say "add the access list yourself". That keeps a known-wrong number on a method viem calls automatically. Touches: `eth_estimateGas`, the intrinsic-gas refusal's wording, and any later task that widens the read seam.

**2. The charge lives BESIDE the shared intrinsic formula (`accessListGas`), not inside it.** `intrinsicGas()` has two callers that must not drift: `node.ts` ADDS it to an engine's execution gas, and `embedded-eth-node/revm` SUBTRACTS it from revm's total. The engine seam's read request carries no access list on either engine, so a term inside the shared formula would be subtracted from a figure that never contained it and `eth_estimateGas` would come out 6200 short on revm and 6200 long on `@ethereumjs/evm` for the same request. The header of `src/intrinsic-gas.ts` already forbade the "unification"; this keeps that intact and puts the new charge above the seam, where the request is. Touches: `src/intrinsic-gas.ts`, `src/node.ts`, and anyone tempted to reuse `intrinsicGas()` for a transaction's validity floor (which is `tx.getIntrinsicGas()`, a third figure, and stays that way).

**3. The estimate is knowingly an OVER-estimate for a list whose entries are touched.** The charge is added but the WARMING is not modelled, because the read underneath was executed without the list: 26005 estimated against 23505 actually paid, above. Buying the exact figure means widening `ReadCallRequest` to carry an access list and pre-warming it on both engines, which is a change to the ENGINE SEAM and belongs to a task that scopes it. Over-estimating is the safe direction (unused gas is not charged; an under-estimate is an out-of-gas transaction), and the figure is pinned in the spec so it is a stated property rather than a surprise.
