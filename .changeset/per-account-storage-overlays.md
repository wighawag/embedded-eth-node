---
'embedded-eth-node': patch
---

`stateMode:'none'` storage is now per-account with per-checkpoint OVERLAYS, so a checkpoint stops copying all of state — 18-28x faster on four transactions at 100,000 slots, and FLAT in state size.

`SimpleStateManager` keeps storage in one flat `${address}_${slot}` map and copies
it WHOLE on every `checkpointSync()`. `@ethereumjs/evm` checkpoints once per
message frame, so every transaction paid `frames + 1` copies of all of state, and
`clearStorage(address)` — which the EVM calls on every contract creation — could
only be a prefix scan of the whole map.

Storage is now `Map<address, Map<slot, value>>`, and a checkpoint pushes an
**overlay**: only what that checkpoint changed, plus a tombstone set of the
accounts it cleared. A commit merges the top overlay down, a revert drops it, and
a read walks the stack.

Measured on the shipped class against the layout it replaces
(`docs/spikes/re-layer-storage-as-per-account-maps-with-per-frame-diffs/measurements.md`,
re-runnable):

| | before | after |
| --- | --- | --- |
| one checkpoint, 100,000 slots | 20,213–22,901 µs | 0.34–0.37 µs |
| `clearStorage`, 100,000 slots | 15,647–17,458 µs | ~0.53 µs |
| four transactions, 1,000 slots | 14.3–15.8 ms | ~12.0 ms |
| four transactions, 100,000 slots | 301–336 ms | 11.9–16.8 ms (18–28x) |
| one transaction through the node, 100,000 slots | 38.9–94.0 ms | 2.4–3.0 ms |
| one `eth_call` through the node, 100,000 slots | 49.6 ms | ~0.33 ms |

~12 ms whether state holds 1,000 slots or 100,000: flat in state size rather than
merely faster, which is the property that matters — the old layout kept getting
worse as state grew. (Both figures per cell are two consecutive runs of the same
script; the 100,000-slot row is the allocation-heaviest and moves tens of percent,
so read the flatness rather than a single ratio.) This is a cost the DEFAULT engine paid, not a revm one:
swapping the interpreter could not have touched it, because the copying was in
the state manager.

**No API and no serialised format changed.** `dumpState` output is asserted
byte-identical against a dump captured from the previous version, and that dump
is asserted to load back — it is persisted data, and the internal layout moved
under it. `loadState`, IndexedDB persistence and the `evm_set*` cheats are
untouched, and the conformance differential, the GeneralStateTests run and the
cross-backend gas gate are unchanged.

One INTERNAL breaking change, for anyone who reached past
`StateManagerInterface`: the `'none'`-mode state manager is now
`OverlayStorageStateManager` (was `SimpleStateManagerWithClearStorage`) and its
inherited flat `storageStack` is no longer maintained — READING it throws an error
naming the replacement (`storageAt(addressKey, slotKey)` for one slot,
`liveStorage()` for all of them). That is deliberate: left present and empty, it
made three shipped readers answer "this slot is zero" for a slot holding a value,
with no error at all.

The default entry point grew 413.7 -> 416.3 KB raw / 124.6 -> 125.4 KB gzip, and
the benchmark's bundle baseline is re-pinned in this same change. The 2.6 KB is
the overlay walk, the commit merge, the two synchronous accessors and the retired
stack's error text; it is in the core graph because this is the default state
manager, and it is what buys that same default consumer that flatness. Still zero bytes
of `revm-wasm` in the default graph.

Correctness is asserted before speed, in `test/storage-overlay.spec.ts`: six
checkpoint/commit/revert semantics, a 20,000-operation randomised differential
against the previous flat layout comparing every read and periodic full
snapshots, and the same battery run against a NAIVE per-account layout (shared
inner maps) which must FAIL it — 4 of the 6 — so the assertions are known to have
teeth.
