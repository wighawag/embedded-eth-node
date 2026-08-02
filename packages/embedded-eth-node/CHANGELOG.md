# embedded-eth-node

## 0.2.0

### Minor Changes

- 654bb91: `intrinsicGas()` gates EIP-3860 by fork, and the revm read engine admits `berlin`, `london` and `paris` again.

  `revm-wasm@0.3.1` fixes the upstream bug this repo filed as
  `wighawag/revm-wasm#4`: `CallExecutor::new` now rebuilds the gas-parameter table
  for the requested spec instead of leaving it pinned at the `Context::mainnet()`
  default, so revm no longer charges EIP-3860's initcode word cost on forks that
  predate Shanghai. That INVERTS the previous release's remedy. The two engines
  used to agree on a wrong number there; with revm fixed, the node was the only
  party still charging the term, and a CREATE-shaped `eth_estimateGas` differed by
  engine (default 53302 vs revm 53298 for a 64-byte initcode, where the protocol
  charges 53298). The fork gate that was the wrong fix against `0.3.0` is the
  required one against `0.3.1`.

  So `src/intrinsic-gas.ts` now takes the node's `Common` and charges the initcode
  word cost only where `common.isActivatedEIP(3860)` says the protocol does. The
  parameter is that `Common` ITSELF, not a hardfork name: `node.ts` hands the
  engine the very same instance through `ReadEngineContext.common`, so the caller
  that ADDS the intrinsic gas and the caller that SUBTRACTS it cannot name
  different forks — which is the drift that shared file exists to prevent. It is
  also the table `@ethereumjs/vm`'s `runTx` consults, so a deployment estimated on
  the read path is charged what this node's own transaction path spends on it.

  **Observable changes.** `eth_estimateGas` for a CREATE is unchanged on the fork
  the node runs (Cancun) and on Shanghai. `REVM_SPEC_BY_HARDFORK` is now
  `{berlin, london, paris, shanghai, cancun}` and `REVM_REFUSED_HARDFORKS` is
  `{prague, osaka}`; code reading either table sees the new contents, and the
  `PRE_EIP_3860` refusal text is gone. `revm-wasm` moves to `^0.3.1`. The revm
  engine now throws if `call()` is reached before `connect()` bound it to a node
  (it has no hardfork to cost against) — unreachable through `createNode()`.

  **Still refused, unchanged:** `prague` and `osaka`. Their refusal never depended
  on the upstream bug — revm enforces EIP-7623's calldata floor and EIP-7825's gas
  limit cap, neither of which this node's arithmetic implements — and both were
  re-measured on `0.3.1` rejecting the node's estimate and read budget exactly as
  before.

  ADR 0008 gains a second amendment recording the reversal, the evidence it rests
  on, and that `prague`/`osaka` are untouched. See
  `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` and §6-§7
  of `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md`.

## 0.1.0

### Minor Changes

- 6694ffc: Make the EVM behind the READ path swappable: `createNode({engine})`.

  `eth_call`, `eth_estimateGas` and `eth_fillTransaction`'s gas estimation now run
  on an ENGINE rather than reaching `@ethereumjs/evm` directly. Supplying none
  keeps exactly today's behaviour — the default engine wraps the node's own
  `@ethereumjs/evm`, including the pure-read checkpoint/revert and the EIP-2929
  warm/access reset that keeps a repeated estimate for a warm SSTORE from coming
  back ~2000 gas too low.

  An engine is an INJECTED OBJECT (`ReadEngine`), never a name the core resolves,
  so the core imports no engine a consumer did not and a JS-only consumer pays
  nothing for one they never use. See
  `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md`.

  Everything an engine needs to keep a read pure is the ENGINE's business: the
  default engine checkpoints and resets warmth because `@ethereumjs/evm` requires
  it, and an engine that is structurally incapable of committing pays for neither.

  Scope, deliberately narrow: only READS are routed through the engine.
  Transactions still run on `@ethereumjs/vm`, which is why the active engine reads
  as `node.readEngine` (`{id: '@ethereumjs/evm'}` by default) rather than
  `node.engine` — a receipt can never be attributed to it.

  New exported types: `ReadEngine`, `ReadEngineContext`, `ReadEngineInfo`,
  `ReadCallRequest`, `ReadCallResult`. No new runtime dependency.

- 172d1ad: The revm read engine now runs reads against the node's REAL block environment,
  on `revm-wasm@^0.3.0`.

  `BASEFEE` inside an `eth_call` used to read `0` on `embedded-eth-node/revm` and
  the block's real value on the default `@ethereumjs/evm` engine: the zeroed base
  fee was the only way to keep a read from an unfunded address (`from` defaults to
  the zero address) from failing revm's transaction validation. `revm-wasm` now
  exposes the switches every real client uses to serve `eth_call`, so the engine
  passes the node's own base fee and `prevRandao` and turns the VALIDITY RULES off
  instead: `disableBaseFee`, `disableBlockGasLimit`, `disableEip3607`.

  Observable consequences, all of them removing a divergence between the two
  engines:
  - `BASEFEE` and `PREVRANDAO` inside a read now report the node's block on revm,
    as they always did on the default engine (`COINBASE`, `NUMBER`, `TIMESTAMP`
    and `GASLIMIT` already did).
  - `eth_call` / `eth_estimateGas` with `from` set to an address that HOLDS CODE
    now succeeds on revm (EIP-3607 is a rule about sending a transaction;
    `@ethereumjs/evm`'s `runCall` never enforced it). Smart-account, ERC-4337 and
    multicall-aggregator previews work on either engine.
  - A read's gas budget is no longer capped at the block gas limit on revm, so a
    call needing within intrinsic gas of the whole block limit no longer runs out
    of gas on one engine and completes on the other.
  - A read from an address holding no ether keeps working, which is what the
    zeroed base fee was buying.

  What is relaxed is a transaction's VALIDITY, never the VALUE TRANSFER: revm's
  `disableBalanceCheck` is deliberately left off, so an `eth_call` carrying more
  ether than the sender holds still fails on either engine, as it does on geth
  (`ErrInsufficientBalance`). A read never invents funds it can then report.

  The differential conformance battery grew two steps for the two divergences no
  gas bar can see: one that reads the block-environment opcodes THROUGH A CONTRACT
  and diffs them (gas is identical either way), and one that pins whether a
  value-bearing read succeeds or fails per sender (a rejected read charges no gas
  at all). Both run on both engines: in both state modes on the default engine, and
  in `stateMode:'none'` on revm, which refuses `'trie'` at construction.

- 52d03c6: The revm read engine refuses `berlin`, `london` and `paris` too: it now admits `shanghai` and `cancun` only.

  `src/intrinsic-gas.ts` adds EIP-3860's initcode word cost (`ceil(len/32) * 2`)
  to every CREATE with no hardfork gate, and EIP-3860 arrived in Shanghai. That
  was previously judged harmless because `revm-wasm` over-charges identically on
  the earlier forks, so the two engines agree and no cross-engine divergence
  reaches an estimate. Measured against the shipped artifact, the agreement is
  real and the conclusion was not: for a 64-byte initcode both sides charge 53296
  where the protocol charges 53292, so `eth_estimateGas` for a deployment on those
  forks over-charges by 2 gas per initcode word (3072 for a maximum-size initcode)
  against what this node's own `@ethereumjs/vm` transaction path spends. The node
  disagreed with itself, and an invariant that compares the node with revm could
  not see it.

  Gating the term would not have fixed it: the engine subtracts the node's
  intrinsic gas from what revm spent and the node adds the same number back, so a
  gate moves the default engine's estimate and cannot move revm's, turning an
  agreed wrong number into a cross-backend gas divergence. So the three forks are
  refused at construction instead, naming EIP-3860 and where the measurements are,
  and `intrinsicGas()` keeps its unconditional term — now true at every fork any
  part of this node can run.

  Nothing a consumer can reach changes: the node runs Cancun and exposes no
  hardfork option, so this is a guard that fires the day that moves.
  `REVM_SPEC_BY_HARDFORK` is now `{shanghai, cancun}` and `REVM_REFUSED_HARDFORKS`
  gains `berlin`, `london` and `paris`; code that reads either table sees the new
  contents.

  ADR 0008's admission rule is amended with it: agreement between the node and
  revm is necessary and NOT sufficient, because they share one intrinsic-gas
  answer by construction, so admission now also requires the protocol's agreement,
  judged by a witness that is neither of them (`@ethereumjs/common`'s EIP
  activation table, asserted per admitted fork in the test suite).

  See `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` and the
  measurements in
  `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`.

- f145bb5: Add `embedded-eth-node/revm`: a revm-wasm engine behind the node's READ path.

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

- 322097e: Add `senderMode: 'recover' | 'trusted'` to skip ecrecover on a local chain.

  `ecrecover` is a fixed ~2ms per transaction and dominates small ones (~80% of a
  21k-gas transfer; EVM execution only overtakes it at ~33k gas of execution). A
  client that signed a tx already knows the sender, so re-deriving it on a local
  chain is pure waste.

  `senderMode: 'trusted'` (opt-in; default stays `'recover'`) enables
  `evm_sendRawTransactionAs` / `evm_sendRawTransactionSyncAs`, which take
  `[raw, from]` and pin the sender instead of recovering it. Measured ~13x on
  `runTx` in isolation, ~2.3x end-to-end through a viem-style client, and ~3.9x
  when the caller also skips signing (fabricated signature). Gas, status, logs,
  receipts and post-state are byte-identical to `'recover'`, asserted field by
  field in a new differential test.

  The primitive is just "execute as this sender, do not recover". It serves both an
  ordinary signed tx bypassing a redundant recovery and a higher layer implementing
  anvil-style impersonation on top with a fabricated signature. Impersonation
  itself is account policy and remains out of scope for this package.

  **`'trusted'` removes the only thing binding a tx to its sender**, so any caller
  can claim any address. It is gated behind an explicit option, the cheat methods
  throw `-32601` in the default mode, and it must never be exposed to untrusted
  callers. See the README section "Sender mode" for the full caller contract.

- f3dcc2d: The revm read engine admits only the hardforks it can COST: `prague` and `osaka` are now refused.

  `embedded-eth-node/revm` mapped seven hardfork names onto revm specs, but the
  node's shared intrinsic-gas arithmetic (`src/intrinsic-gas.ts`) implements the
  pre-Prague formula only, and revm enforces more than that from Prague onwards.
  Measured against `revm-wasm@0.3.0`, a call carrying 100 non-zero calldata bytes
  costs the node's arithmetic 22600 while revm demands EIP-7623's floor of 25000
  and rejects the difference outright with `GasFloorMoreThanGasLimit`. That is the
  `eth_estimateGas` failure this node exists to prevent: a client uses an estimate
  as the transaction's gas LIMIT, so an under-estimate is not a warning, it is an
  out-of-gas transaction.

  Osaka fails a second, independent way — EIP-7825 caps a transaction's gas limit
  at 16777216, below the node's default read budget of 30000000, so every ordinary
  `eth_call` there is rejected before the first opcode.

  So `createRevmEngine()` now refuses those two forks at construction, naming the
  EIP, the file that would have to change, and the ADR, exactly as it already
  refuses `stateMode:'trie'`. Nothing a consumer can reach changes today: the node
  runs Cancun and exposes no hardfork option, so this is a guard that fires the day
  that moves rather than letting an estimate go out that the engine which produced
  it would reject.

  Two new exports on the `embedded-eth-node/revm` subpath say which forks are
  served, in code rather than by triggering the refusal:
  `REVM_SPEC_BY_HARDFORK` (admitted) and `REVM_REFUSED_HARDFORKS` (refused, with
  the reason). The `eth_estimateGas` for a calldata-heavy call is now fed back to
  revm AS a gas limit under every admitted spec in the test suite, so re-admitting
  a fork without doing the costing work fails the build.

  See `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` and the
  measurements in `docs/spikes/prague-intrinsic-gas-floor-or-refuse/`.

- 7325bf1: Document the read-engine seam, and fail LOUDLY at its new edges.

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

### Patch Changes

- 80d0954: Fix: a contract created at an address that already held storage no longer inherits it (`stateMode:'none'`).

  `@ethereumjs/statemanager@10.1.2` ships `SimpleStateManager.clearStorage` as an empty no-op that also drops its `address` argument, while `@ethereumjs/evm` calls it on every contract creation precisely to guarantee a fresh contract starts with empty storage. In `stateMode:'none'` (the default) that meant a create landing on an address with pre-existing storage kept it: seed slot 0, deploy a `Counter` onto that address, and `number()` returned the seeded value instead of `0`, with a success receipt and no warning.

  The node now uses its own `SimpleStateManager` subclass which implements `clearStorage(address)`. Reported upstream with a reproduction; this override is what protects consumers meanwhile. It is a subclass rather than a dependency patch because a patch would fix only this repo's tests and leave every installed consumer exposed.

  `stateMode:'trie'` was already correct (its real `storageRoot` makes the EIP-7610 collision guard fire, so the creation is rejected rather than cleared). The two modes therefore differ on this case, deliberately and now asserted in the test suite: `'none'` clears and succeeds, `'trie'` rejects. Neither inherits. See ADR 0007 and the state-mode section of the README.

  Also in this release: `senderMode` is now forwarded across the comlink Worker boundary (`createWorkerNode(...).senderMode` previously read `undefined` on a property typed `'recover' | 'trusted'`), and two wall-clock test assertions that could flip on a loaded machine were replaced with load-invariant ones.

## 0.0.2

### Patch Changes

- f7fe263: Fix contradictory install instructions in README: `@ethereumjs/*` and `@noble/hashes` are direct dependencies (installed automatically), not peer deps. Only `comlink` is an optional peer dependency.

## 0.0.1

### Patch Changes

- first
