# `SimpleStateManager.clearStorage()` is a no-op, so a redeployed contract inherits storage

2026-07-31, spotted while running `revm-state-adapter-spike`.

`@ethereumjs/evm@10.1.2` calls `stateManager.clearStorage(message.to)` on every contract creation (`evm.js:555`), but `SimpleStateManager.clearStorage()` takes no argument and its body is empty, so in `stateMode:'none'` a contract deployed at an address that already holds storage keeps it. Probed against `packages/embedded-eth-node/src/node.ts`: `evm_setStorageAt(addr, 0x0, 99)` followed by a normal deploy landing on `addr` gives a fresh Counter whose `number()` returns 99. Unverified for `stateMode:'trie'` (the same probe fails earlier there, on `putStorage() called on non-existing account`). Out of scope for the spike; recorded because the revm write half (`revm-engine-behind-runtx`) must not assume ethereumjs clears anything.
