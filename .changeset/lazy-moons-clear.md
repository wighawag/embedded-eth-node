---
'embedded-eth-node': patch
---

Fix: a contract created at an address that already held storage no longer inherits it (`stateMode:'none'`).

`@ethereumjs/statemanager@10.1.2` ships `SimpleStateManager.clearStorage` as an empty no-op that also drops its `address` argument, while `@ethereumjs/evm` calls it on every contract creation precisely to guarantee a fresh contract starts with empty storage. In `stateMode:'none'` (the default) that meant a create landing on an address with pre-existing storage kept it: seed slot 0, deploy a `Counter` onto that address, and `number()` returned the seeded value instead of `0`, with a success receipt and no warning.

The node now uses its own `SimpleStateManager` subclass which implements `clearStorage(address)`. Reported upstream with a reproduction; this override is what protects consumers meanwhile. It is a subclass rather than a dependency patch because a patch would fix only this repo's tests and leave every installed consumer exposed.

`stateMode:'trie'` was already correct (its real `storageRoot` makes the EIP-7610 collision guard fire, so the creation is rejected rather than cleared). The two modes therefore differ on this case, deliberately and now asserted in the test suite: `'none'` clears and succeeds, `'trie'` rejects. Neither inherits. See ADR 0007 and the state-mode section of the README.

Also in this release: `senderMode` is now forwarded across the comlink Worker boundary (`createWorkerNode(...).senderMode` previously read `undefined` on a property typed `'recover' | 'trusted'`), and two wall-clock test assertions that could flip on a loaded machine were replaced with load-invariant ones.
