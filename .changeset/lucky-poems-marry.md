---
'embedded-eth-node': minor
---

Add `embedded-eth-node/revm`: a revm-wasm engine behind the node's READ path.

```ts
import {createNode} from 'embedded-eth-node';
import {createRevmEngine} from 'embedded-eth-node/revm';

const node = await createNode({engine: await createRevmEngine({wasm})});
```

`eth_call`, `eth_estimateGas` and `eth_fillTransaction`'s estimation then run on
revm, returning the SAME results and the SAME gas as the default
`@ethereumjs/evm` engine (`number()` 2446 execution gas, `sumTo(2000)` 498689,
`keccakLoop(2000)` 1107052 — asserted, not asserted-about). Transactions are
unchanged: they still run on `@ethereumjs/vm`, so a node with this engine runs
two EVMs and `node.readEngine` says which one produced a read.

The engine reads the node's OWN state, which stays authoritative — nothing is
copied across, and a value written by a transaction is visible to the next
`eth_call` with no sync step. It does that through `SimpleStateManager`'s public
checkpoint stacks, the only synchronous view of the node's state that exists, so
it serves `stateMode:'none'` ONLY and REFUSES `stateMode:'trie'` at construction
with an error naming the reason (see
`docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md`).
An `eth_call` on it cannot mutate state: `Revm#call` cannot commit, and every
write method on the state adapter throws.

The wasm is whatever you have — bytes, a `URL`, a `Response` or a compiled
`WebAssembly.Module` — passed straight through to `revm-wasm`, so a
bundler-resolved asset and a runtime-fetched URL are the same code path. In
Node, note that `revm-wasm/wasm-url` is a `file:` URL and Node's `fetch` cannot
resolve that scheme: read the bytes and pass those.

One engine instance serves ONE node. Handing an already-connected engine to a
second `createNode()` is refused, because rebinding it would silently re-point
the FIRST node's reads at the second node's state. Running several nodes means
calling `createRevmEngine()` per node — pass each the same compiled
`WebAssembly.Module` to compile the wasm only once.

`revm-wasm` is a plain `dependency` rather than an optional peer, because a
missing optional peer fails worse than the install costs. **A JS-only consumer
pays install bytes and ZERO bundle bytes**: the core entry point never imports
the subpath, and `packages/benchmarks` now ASSERTS the default entry's bundle
size against a pinned baseline and that `revm-wasm` is absent from its dependency
graph. (The default entry moved 412.3 KB -> 412.4 KB raw: that 0.1 KB is the new
`getBlockHash` accessor in the node itself, not revm.)

`ReadEngineContext` gains a `getBlockHash(blockNumber)` accessor (additive), so
an engine can answer `BLOCKHASH` from the node's real blocks instead of
silently answering zero.
