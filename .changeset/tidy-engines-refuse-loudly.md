---
'embedded-eth-node': minor
---

Document the read-engine seam, and fail LOUDLY at its new edges.

The engine seam is now a documented public feature: the README has a **Read
engine** section beside the `stateMode` / `senderMode` ones (what an engine is,
the default, how to opt into `embedded-eth-node/revm`, both wasm delivery shapes,
which `stateMode` the revm engine serves, and the measured reason it exists), and
the RPC-surface table says which methods route through the engine.

The number published there is measured on **the node with the revm engine
installed** (frame of 100 small view reads, 16.6 ms budget: 10.3 → 3.8 ms on
Chromium, 13.0 → 4.0 ms on WebKit), not on the raw interpreters, because the
node's own dispatch sits on top of the engine and a raw-engine figure would
overstate what a consumer gets. Scope is stated plainly: reads only, transactions
unchanged on `@ethereumjs/vm`.

Three new loud failures, all at construction, none of which existed before:

- An engine whose `connect()` throws — because it cannot initialise, or because
  it refuses this node's configuration — now fails `createNode()` with an error
  naming the engine and carrying the engine's own cause. There is deliberately NO
  fallback to the default `@ethereumjs/evm` engine: a node quietly running an
  engine you did not ask for works, returns correct results, and is an order of
  magnitude slower than you believe, with no signal at all.
- A value passed as `engine` that is not a `ReadEngine` (missing `call`/`id`, or
  an un-awaited `createRevmEngine()` promise) is refused at construction, instead
  of surfacing as a `not a function` TypeError at the first `eth_call`.
- `createWorkerNode({engine})` is refused with a real error explaining that the
  options are structured-cloned into the Worker and an engine is a
  function-bearing object, and pointing at the supported shape (build the engine
  inside your own worker module). Previously this produced an opaque
  `DataCloneError` from inside comlink. `WorkerNodeOptions['engine']` is now typed
  `never`, so TypeScript catches it at compile time too.
