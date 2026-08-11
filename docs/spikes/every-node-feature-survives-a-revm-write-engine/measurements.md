# The control run: what the state round trips report when the cheats are NOT applied

`test/helpers/state-roundtrip.ts` asserts that a cheat applied BETWEEN two transactions is seen by the next one, and that a `dumpState` taken AFTER a transaction reloads and keeps behaving. Both passed on both engines the first time they were run, with no production change anywhere, which is the whole claim of story 13 of `revm-engine-behind-runtx` — and also the reason a control is worth capturing: a suite that passes immediately is indistinguishable, from the outside, from a suite that measures nothing.

So this is the same suite with the two STATE-WRITING cheats (`evm_setStorageAt` on the Counter's slot 0, `evm_setCode` at `0x…c0de`) deliberately not applied, which is what an engine caching state across a transaction would produce: the transactions still run, but they run against the state as it was BEFORE the cheat. Measured 2026-08-11, Chromium, `revm-wasm@0.3.1`.

## What moves, and what does not

| reading | cheats applied (both engines) | cheats skipped (both engines) |
| --- | --- | --- |
| `counterSlot0AfterCheat` | `41` | `1` |
| `numberAfterSecondTx` | **`42`** | **`2`** |
| `cheatedCodeSlot7After` | **`99`** | **`0`** |
| `numberAfterFollowOn` (both nodes) | `43` | `3` |
| `secondTxStatus` / `thirdTxStatus` | `0x1` / `0x1` | `0x1` / `0x1` |
| `cheatSenderChargedExactly` | `true` | `true` |
| `mismatches` | `[]` | `[]` |
| `followOnReceiptsEqual` | `true` | `true` |
| `dumpStructurallyEqualAfterLoad` / `AfterFollowOn` | `true` / `true` | `true` / `true` |

**Nothing throws, and every STRUCTURAL check still passes.** The receipts are still successes, the reloaded node still agrees with the original field for field, the two dumps are still equal, `mismatches` is still empty. The only thing that moves is what the ABSOLUTE literals say — four readings in `test/state-roundtrip-expected.ts`.

That is the shape of the bug this suite exists to catch, and it is why the expectations are pinned as literals shared by both engines rather than left as a cross-engine diff: an engine that cached state across a transaction would be *self-consistent*, and consistent with a second node reloaded from its own dump, while quietly executing against stale state. A differential cannot see it. Only an absolute statement can.

## How to reproduce

In `test/helpers/state-roundtrip.ts`, delete the two `node.request({method: 'evm_setStorageAt' …})` and `evm_setCode` calls in the cheats block, then:

```sh
cd packages/embedded-eth-node
pnpm exec playwright test --project=chromium state-roundtrip.spec.ts
```

Both `state-roundtrip.spec.ts` (default `@ethereumjs/evm`) and `revm-state-roundtrip.spec.ts` (`embedded-eth-node/revm`) fail, and they fail on `numberAfterSecondTx` and `cheatedCodeSlot7After` only. Restore the two calls to go back to green.
