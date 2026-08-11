# The packed storage key, measured against the encoding it replaced

What this folder holds, and what it is answerable to:

- `probe-shipped-store-key-cost.mjs`: the cold-access cost of the SHIPPED `SimpleStateManagerStore` over a real `OverlayStorageStateManager`, packed keys against hex keys, through the real `revm-wasm` module. Re-runnable: `pnpm install` (which builds `dist/`), then `node docs/spikes/revm-state-store-packed-storage-keys/probe-shipped-store-key-cost.mjs`.

It is the AFTER measurement for `spike-storage-layout-cost-for-the-revm-write-half`'s Q4, which asked the same question against four PROTOTYPE stores because the node did not own its storage representation yet. It does now (ADR 0009), so this arm-for-arm comparison is against the code that ships, with one thing changed between the arms: the storage key.

## The answer

**A cold revm storage access went from 1.31-1.33 µs to 0.36-0.39 µs: 0.91-0.97 µs recovered, 70-73% of the access.** Q4 predicted 50% from a prototype; the shipped version does better, for two reasons given below. What remains is 0.17-0.18 µs of wasm crossing (the floor, measured by a store that answers without looking at the key) plus ~0.2 µs of key building and map walking.

Two runs on the same machine, transcribed rather than averaged, because these figures move a few percent between runs (node v24.13.1, linux x64, AMD Ryzen 7 PRO 6850U, `revm-wasm` 0.3.1, `@ethereumjs/statemanager` 10.1.2):

| store | µs per cold access, run 1 | run 2 |
| --- | --- | --- |
| **shipped (packed keys)** | **0.359** | **0.394** |
| hex keys (the encoding this replaced) | 1.326 | 1.305 |
| flat hex (pre-ADR-0009) | 1.147 | 1.219 |
| null store (crossing only) | 0.177 | 0.172 |

| quantity | µs (run 1) | share of the hex-key access |
| --- | --- | --- |
| hex-key access (before this change) | 1.326 | 100% |
| crossing alone (null store) | 0.177 | 13% |
| key handling (hex minus null) | 1.149 | 87% |
| **shipped packed access** | **0.359** | **27%** |
| **recovered by packing** | **0.967** | **73%** |

And the JS half alone, no wasm involved — build the key and walk the overlay stack for it:

| lookup | µs (run 1) | µs (run 2) |
| --- | --- | --- |
| hex keys (the encoding this replaced) | 1.123 | 1.113 |
| shipped (packed keys) | 0.223 | 0.222 |
| `slotBytes()` alone (the probe's own overhead, in both rows) | 0.059 | 0.057 |

The measurement is a difference of two runs of the same contract — 2,000 SLOADs of DISTINCT slots (2,000 cold accesses, so 2,000 host callbacks) minus the same contract reading ONE slot 2,000 times (one callback) — so the interpreter, the loop and the crossing cancel and what is left is the per-access key work. Both counts are asserted, not assumed, and the probe additionally asserts that **every arm reports the same gas**: an arm whose key format found NOTHING would be the fastest one on the table, since an unfound slot is `undefined`, i.e. zero, and just as quick to return.

### Why the shipped version beats the prototype's 50%

Q4's prototype was a `Map` lookup with a key built by `s += String.fromCharCode(...)` in a loop. Two differences in the shipped code, neither of them planned as an optimisation:

1. **The encoder is unrolled**: one `String.fromCharCode(c0, …, c15)` call per key rather than sixteen concatenations (`src/storage-keys.ts`).
2. **The per-account view is gone.** The store used to memoise an `AccountStorageView` per address and look it up on every access; it never saved anything (the address key had to be built first to find the view) and it cost a `Map.get` plus a closure call per access. `getStorage` now builds both keys and calls `storageAt` directly.

The hex arm is also slightly SLOWER than the pre-ADR-0009 flat map (1.31-1.33 against 1.15-1.22), which is Q4's finding restated on the shipped code: per-account nesting recovers nothing on reads and costs a second lookup, because the cost is building hex at all. The layout was worth 18-28x on the WRITE path (ADR 0009) and nothing on this one; the key encoding is the other way round.

## The correctness bar, and that it can go RED

The dangerous failure of this change is not slowness, it is **two key formats that both work**: `@ethereumjs/evm`, genesis, `loadState` and the `evm_set*` cheats write storage through the async `putStorage`, while revm reads it through the synchronous `storageAt`. A disagreement makes every cross-route read a MISS, and a miss is a ZERO at identical gas — invisible to the cross-backend gas gate, to the conformance differential's receipts and to any `dumpState` diff.

`test/revm-storage-keys.spec.ts` is the bar for it, and it was mutated to check it can fail:

**Mutation 1 — the READ half back to hex** (`getStorage` builds an `0x`-hex key, writes still packed). Every `.call` reading on the revm node — the `SLOAD` executed by the engine — drops to zero, while `eth_getStorageAt`, `dumpState` and the slot counts stay byte-identical to the reference node's:

```
"genesis.A.zero.call: reference 0x…2a vs underTest 0x…00",
"genesis.A.wide.call: reference 0xf0e1…1e0f vs underTest 0x…00",
"final.A.cheated.call: reference 0x…99 vs underTest 0x…00",
…12 mismatches, all of them `.call`, none of them `.rpc`
```

**Mutation 2 — the WRITE half back to hex** (`setStorage` builds an `0x`-hex key, reads still packed). The transaction's write lands beside the slot it meant to overwrite, and the dump grows a third "account" whose key is a hex string re-read as packed bytes:

```
"slotCounts": {
  "reference": {"0x…e0": 6, "0xe0…00": 1},
  "underTest": {"0x…e0": 5, "0xe0…00": 1,
                "0x0030007800300030…0065 0030": 2}
}
```

Both were reverted; they are recorded here because a battery that has never gone red is not known to be a battery.

## What did NOT change

- **`dumpState` / `loadState`.** The serialised format is persisted data and stays `{address: {slot: value}}` in `0x`-hex, key order included; `OverlayStorageStateManager.liveStorage()` converts on the way out. `test/storage-overlay.spec.ts` still asserts the dump byte-identical against `test/fixtures/dumpstate-flat-layout.json`, a dump captured before the layout ever changed, and that assertion was not touched.
- **Accounts and code.** Those stacks are `SimpleStateManager`'s, still keyed `address.toString()`; ADR 0005's "reproduce the key format byte for byte" still applies to them.
- **Gas, on either engine.** The conformance differential, the GeneralStateTests run and the cross-backend gate are unchanged, which is exactly why they could not have caught a key disagreement.
