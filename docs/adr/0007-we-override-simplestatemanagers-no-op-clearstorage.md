# We override `SimpleStateManager`'s no-op `clearStorage`, in our own code rather than a patch

`@ethereumjs/statemanager@10.1.2` ships `SimpleStateManager.clearStorage` as `async clearStorage() { }`: an empty body taking NO parameter, while the `StateManagerInterface` it implements declares `clearStorage(address: Address): Promise<void>`. `@ethereumjs/evm` calls it on every contract creation (`evm.js:555`, immediately after `journal.putAccount`) precisely to guarantee a fresh contract starts with empty storage. With the no-op, a contract created at an address that already holds storage INHERITS that storage, with a success receipt and no warning. `stateMode:'none'` is our default, so this was reachable by default: seed slot 0 with `evm_setStorageAt`, deploy a Counter that lands on that address, and `number()` returned 99 instead of 0.

We therefore ship a subclass that implements it (`src/state-manager.ts`) and use it for `stateMode:'none'`. *(That class is now called `OverlayStorageStateManager`, because it also re-layers storage — [ADR 0009](0009-none-mode-storage-is-per-account-with-per-checkpoint-overlays.md). The `clearStorage` fix below is unchanged; only its cost is.)*

Reported upstream with a reproduction and a fix: issue [ethereumjs/ethereumjs-monorepo#4357](https://github.com/ethereumjs/ethereumjs-monorepo/issues/4357), PR [#4358](https://github.com/ethereumjs/ethereumjs-monorepo/pull/4358). This subclass is what protects consumers until that lands and we bump past it.

## Why a subclass and not a `pnpm patch`

A patch was the first instinct and it is the wrong tool here: it would fix only THIS repo's own test runs. `embedded-eth-node` is a LIBRARY, so a consumer installs `@ethereumjs/statemanager` through their own dependency resolution and would never see our patch. Every consumer would keep the bug while our CI went green, which is the worst combination available. The fix has to live in code we publish.

The subclass was also cheaper than it looked: `topStorageStack()` is `protected`, so a subclass reached the live frame through the API the base class already offers, with no cast and no reach past the type. *(2026-08-09: no longer how it works. ADR 0009 replaced the flat storage map itself, so the subclass owns the representation rather than reaching into upstream's, and `clearStorage` is one `delete` plus a tombstone on the top overlay.)*

One irritation worth recording, because it will confuse the next person: the override's `address` parameter is OPTIONAL. TypeScript refuses an override that adds a REQUIRED parameter the base does not declare (TS2416), and the base declares zero. So the signature is `clearStorage(address?: Address)` and a no-argument call keeps the base's do-nothing behaviour rather than guessing an account. The bug's own signature is what prevents typing the fix properly.

## What this does NOT fix, and the mode asymmetry it leaves

The EIP-7610 collision guard directly above that call rejects creation outright when the target account has non-empty storage, and it decides by reading `account.storageRoot`. `SimpleStateManager` implements no state-root logic at all, so `storageRoot` never reflects its flat storage map and that guard CANNOT fire in `'none'` mode. Clearing is therefore the most we can do there.

The two state modes consequently differ on this case, and the difference is asserted in `test/slim-node-checks.spec.ts` so it cannot drift unnoticed:

- **`stateMode:'none'`** clears the storage and the creation SUCCEEDS. That is pre-EIP-7610 semantics, and exactly what the EVM's own call asks for.
- **`stateMode:'trie'`** computes a real `storageRoot`, so the guard fires and the creation is REJECTED with `CREATE_COLLISION`. That is the spec-current behaviour, and it needs no fix from us.

Neither mode inherits storage, which is the property that matters. They are not identical to each other, and we accept that rather than fake a `storageRoot` on accounts in `'none'` mode: a sentinel non-empty root would make the guard fire, but it would also lie to `dumpState`, to persistence, and to anything else that reads the field, in a mode whose whole premise (ADR 0001) is that there is no root. A documented asymmetry in a trie-less mode is a smaller cost than a fabricated hash.

`stateMode:'trie'` remains the conformance-testable mode, and this is one more instance of the general rule already stated in ADR 0001: `'none'` is fast and non-conformant in specified, documented ways.

## Cost

> **No longer applies, as of 2026-08-09 — [ADR 0009](0009-none-mode-storage-is-per-account-with-per-checkpoint-overlays.md).** Storage is per-account with per-checkpoint overlays, so `clearStorage` is O(that account): one `delete` plus a tombstone, measured at 0.55 microseconds at every state size, against 17,458 microseconds at 100,000 slots for the prefix scan described below. The paragraph is kept because it is the reasoning that pointed at the fix.

`clearStorage` here is O(total storage), because `SimpleStateManager` keys storage in ONE flat map as `${address}_${slot}` with no per-account index. A create or a `SELFDESTRUCT` is rare next to a read, so this is acceptable, but it is the same flat-layout cost ADR 0005 records for revm's `clearStorage` requirement (which must be O(that account)). Both point at the same eventual fix, a per-account storage layout, which `revm-engine-behind-runtx` will have to decide on for its write half.

## Removing this later

When upstream fixes it and we bump past the fixed version, this PART of the subclass can go — but the subclass itself stays, because ADR 0009 gave it a second job (the storage representation) that upstream has no equivalent for.

The original wording, for the record: when upstream fixes it and we bump past the fixed version, this subclass can go, and the `'none'` branch can construct `SimpleStateManager` directly again. The test in `slim-node-checks` is what tells you it is safe: it asserts the BEHAVIOUR through the node's public surface, not our class, so it keeps passing if upstream's own implementation is correct. Do not delete the test with the subclass.
