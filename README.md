# embedded-eth-node

A **slim, execution-only** in-browser EIP-1193 Ethereum node on
[`@ethereumjs/vm`](https://github.com/ethereumjs/ethereumjs-monorepo).

It sits BETWEEN bare `EVM.runCall` (too low-level: no blocks/receipts/logs) and a
full in-browser node (heavy): it uses `@ethereumjs/vm`'s `runTx` + a minimal mock
blockchain with `SimpleStateManager` (plain Maps, **no trie, no state-root** by
default) and **none** of the node / RPC / mempool / signing bloat. It exposes only
the read + signed-raw-tx methods a viem/wagmi client actually uses — signing stays
client-side — and **fails loudly** (`-32601`) at its intentional edges instead of
faking success.

- **Transport-agnostic core:** a node is just `{ request, mine, dumpState,
  loadState, onNewHead, getStateRoot, dispose }` where `request()` is an **async**
  EIP-1193 method. Because it's async, the SAME object works unchanged on the main
  thread or across a Worker boundary.
- **Optional Web-Worker hosting** via comlink helpers (`worker-entry` +
  `createWorkerNode()`), so `createNode()` (main thread) and `createWorkerNode()`
  (Worker) are interchangeable one-liners — the consumer never hand-rolls comlink.
- **IndexedDB persistence** (`createIndexedDBPersistence()`), verified to survive a
  real page reload (state + balances + `eth_getLogs`).
- **Swappable ENGINE:** reads (`eth_call`/`eth_estimateGas`) and transactions both
  run on an injected engine — `@ethereumjs/evm` by default, or
  [revm-wasm](#engine-ethereumjsevm-default-vs-revm-wasm-opt-in) via the
  optional `embedded-eth-node/revm` subpath (measured **2.7× on Chromium /
  3.3× on WebKit** for a 100-read frame, byte-identical gas). One engine answers
  BOTH halves, so `node.engine` names the EVM that ran your reads and executed
  your transactions.
- **Simple by design:** account/signing methods are NOT implemented; legacy
  (type-0) receipts work (legacy-safe `effectiveGasPrice`); `eth_estimateGas` is a
  real run-and-measure (no fudge), verified equal to `runTx`'s `totalGasSpent`.

## Install

```sh
npm install embedded-eth-node
# optional, only if you use the Worker helpers:
npm install comlink
```

(`@ethereumjs/*` and `@noble/hashes` are declared as direct dependencies and are
installed automatically; `comlink` is an optional peer used only by the Worker
entry/client.)

## Usage (main thread)

```ts
import {createNode, createIndexedDBPersistence} from 'embedded-eth-node';
import {createPublicClient, createWalletClient, custom} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';

const node = await createNode({
  chainId: 31337,
  miningConfig: {type: 'auto'}, // mine one block per raw tx (pairs with sync)
  persistence: createIndexedDBPersistence(), // optional; survives reload
  initialBalances: {'0xf39…2266': 10n ** 24n},
});

const account = privateKeyToAccount('0x…');
const transport = custom(
  {request: ({method, params}) => node.request({method, params})},
  {retryCount: 0},
);
const wallet = createWalletClient({account, chain, transport}); // signs locally
const pub = createPublicClient({chain, transport});
// writes via signed raw txs only; reads via eth_call.
```

### `eth_sendRawTransactionSync` (the fast path)

Send + mine + return the receipt in ONE call (no receipt polling = the latency
win). With `miningConfig: {type:'auto'}` this is the default behaviour.

## Usage (Worker — same API)

```ts
// worker.ts
import 'embedded-eth-node/worker-entry'; // calls comlink expose()

// main thread
import {createWorkerNode} from 'embedded-eth-node/worker-client';
const worker = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'});
const node = await createWorkerNode({worker, chainId: 31337, miningConfig: {type: 'auto'}});
// node is the SAME { request, mine, dumpState, loadState, ... } shape — drive it
// with the SAME viem client code as the main-thread node.
```

## RPC surface (the contract)

This is a **curated, execution-only** method set — NOT a full EIP-1193 provider.
Anything not in the **supported** list below throws a real JSON-RPC
method-not-found (`-32601`) — it never fakes a result.

### Supported

| method | notes |
|---|---|
| `eth_chainId`, `net_version` | from `chainId` option |
| `eth_blockNumber` | latest mined block number |
| `eth_getBlockByNumber`, `eth_getBlockByHash` | header + (optional) full txs; roots are zero in `'none'` mode |
| `eth_call` | **runs on the [engine](#engine-ethereumjsevm-default-vs-revm-wasm-opt-in)**; pure (never mutates); reverts throw `RpcError(3, 'execution reverted')` |
| `eth_estimateGas` | **runs on the [engine](#engine-ethereumjsevm-default-vs-revm-wasm-opt-in)**; honest run-and-measure (`executionGasUsed` + intrinsic incl. EIP-3860); verified == `runTx` `totalGasSpent` |
| `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount` | state reads at a block tag |
| `eth_gasPrice`, `eth_maxPriorityFeePerGas` | **constant** (faked fee market — local chain) |
| `eth_feeHistory` | correct response **shape**, but **constant/faked values** — not for real fee prediction |
| `eth_fillTransaction` | fills missing nonce/gas/fees of a tx request and returns `{tx, raw}` (the `raw` is **unsigned** — sign client-side); viem's `prepareTransactionRequest` uses it. Its gas estimate **runs on the [engine](#engine-ethereumjsevm-default-vs-revm-wasm-opt-in)** |
| **`eth_sendRawTransaction`** | accepts a **signed** raw tx; mines per `miningConfig`. **Executes and commits on the [engine](#engine-ethereumjsevm-default-vs-revm-wasm-opt-in)**, through its transaction operation |
| **`eth_sendRawTransactionSync`** | the fast path: send + mine + return receipt in one call |
| `eth_getTransactionReceipt`, `eth_getTransactionByHash` | from the in-memory store |
| `eth_getLogs` | address + topic filtering over mined logs. **Perf note:** a full linear scan over all logs per call (O(total_logs), no index/cache) — fine for a local chain |
| `eth_subscribe`/`eth_unsubscribe` | **`newHeads` only**; prefer `onNewHead()` over comlink |
| `evm_setBalance` / `evm_setNonce` / `evm_setCode` / `evm_setStorageAt` / `evm_setAccount` | anvil/hardhat-style runtime state cheats (mutate live state with no tx); commit into the trie in `'trie'` mode |
| `evm_sendRawTransactionAs` / `evm_sendRawTransactionSyncAs` | `[raw, from]` — execute as `from`, **skipping ecrecover**. Only exist when `senderMode: 'trusted'`; otherwise a loud `-32601`. See [Sender mode](#sender-mode-recover-authenticated-default-vs-trusted-no-ecrecover) |

### Intentionally NOT supported (loud `-32601`)

- **Account/signing** (the point — sign client-side, send raw):
  `eth_sendTransaction`, `eth_accounts`, `eth_sign`, `eth_signTransaction`,
  `personal_*`, `wallet_addEthereumChain`, `wallet_switchEthereumChain`.

### Not implemented yet (would `-32601` today)

- JSON-RPC batch requests (array payloads); filter polling (`eth_newFilter` etc.);
  `eth_getBlockReceipts`; `eth_getProof`; `eth_createAccessList`; `eth_simulateV1`;
  `web3_clientVersion`/`eth_syncing`/`eth_coinbase`/…

## Correctness baked in from day one

- **Legacy-safe `effectiveGasPrice`**:
  `tx.maxFeePerGas ? min(maxPriorityFeePerGas, maxFeePerGas - baseFee) + baseFee :
  tx.gasPrice` — reading `maxFeePerGas` unconditionally throws on legacy (type-0)
  txs. Tested for BOTH legacy and 1559 receipts (verified in-browser).
- **`eth_call` / `eth_estimateGas` never mutate state** — they run on a state
  checkpoint that is reverted, and reset the EVM journal's warm/access tracking +
  the EIP-2200 original-storage cache per call (so a repeated warm-SSTORE estimate
  doesn't under-report and cause out-of-gas reverts). estimateGas returns the
  **real** number (executionGasUsed + intrinsic incl. EIP-3860 initcode word cost),
  verified equal to `runTx`'s `totalGasSpent`.

## State mode: `'none'` (fast, default) vs `'trie'` (real state root, opt-in)

```ts
const fast = await createNode({stateMode: 'none'});       // default — SimpleStateManager
const conformant = await createNode({stateMode: 'trie'});  // MerkleStateManager
```

- **`'none'`** (default): `SimpleStateManager`, no trie, no state root. The fast
  path; measured only **~1.4× faster per signed call / ~1.35× on deploy** than trie
  for typical workloads (so the cost of turning the root on is small). Block
  `stateRoot`/`receiptsRoot`/`transactionsRoot` are zero placeholders and
  `node.getStateRoot()` throws (there is no root). **Full-storage
  persistence is a `'none'`-mode feature.**
- **`'trie'`** (opt-in): `MerkleStateManager` — a real Merkle-Patricia trie.
  `node.getStateRoot()` returns the **real** root and block headers carry it. This
  is what lets the node be **conformance-tested against `ethereum/tests`
  GeneralStateTests** (they verify exactly that post-state root). Bundle cost ~0
  (the trie code is already pulled in transitively by `@ethereumjs/vm`).
  Caveat: trie-mode `dumpState` carries accounts + code but **not** contract
  storage — use `'none'` for IndexedDB persistence, `'trie'` for the state root /
  conformance.

One behaviour genuinely differs between the modes, when a contract is created at
an address that **already holds storage** (reachable via `evm_setStorageAt`, a
`loadState`, or a re-deploy after `SELFDESTRUCT`):

- **`'none'`** clears that storage and the creation **succeeds**, so the new
  contract starts empty. This is the pre-EIP-7610 behaviour, and it is what the
  EVM itself asks for on every create.
- **`'trie'`** has a real `storageRoot`, so the EIP-7610 collision check fires and
  the creation **fails** with a revert. This is the spec-current behaviour.

A DELETED account, by contrast, behaves the SAME in both modes: a `SELFDESTRUCT`
(or an EIP-161 empty-account clearing) takes the account's storage with it, so a
destroyed contract's slots read `0` and `dumpState` stops carrying them. That is
free in `'trie'` (the account's storage trie goes with the account) and is our
override in `'none'`, where upstream `SimpleStateManager.deleteAccount` leaves
storage where it was — the same gap as the `clearStorage` no-op below, and
recorded in the same ADR.

Neither mode lets the new contract *inherit* the old storage, which is the part
that would silently corrupt results. `'none'` cannot detect the collision at all,
because detecting it means reading a `storageRoot` that mode does not have. Note
that `@ethereumjs/statemanager@10.1.2` does not clear it either — its
`SimpleStateManager.clearStorage` is an empty no-op, so we override it and a fresh
contract does read `0`
([ADR 0007](docs/adr/0007-we-override-simplestatemanagers-no-op-clearstorage.md)).

## Sender mode: `'recover'` (authenticated, default) vs `'trusted'` (no ecrecover)

```ts
const authentic = await createNode({senderMode: 'recover'}); // default
const fast = await createNode({senderMode: 'trusted'}); // skips ecrecover
```

`ecrecover` is a **fixed ~2ms per transaction** and it dominates small ones: ~80%
of a 21k-gas transfer, with the crossover where EVM execution overtakes it at
only ~33k gas of execution. A client that signed a tx **already knows** the
sender, so re-deriving it on a local chain is pure waste.

- **`'recover'`** (default): derive the sender from the signature, exactly as a
  real node does. The tx is self-authenticating. This is the only mode that is
  safe when the node is reachable by a caller you do not control.
- **`'trusted'`**: enables `evm_sendRawTransactionAs` / `evm_sendRawTransactionSyncAs`,
  which take `[raw, from]` and **skip ecrecover**. Measured **~13× on `runTx` in
  isolation** (2.52ms → 0.19ms) and **~2.3× end-to-end** through a viem-style
  client (2.23ms → 0.97ms per tx — the residual is the *client's own* signing).
  Gas, status, logs, receipts and post-state are **byte-identical** to `'recover'`
  (asserted field-by-field in `test/trusted-sender.spec.ts`, and again with the
  revm engine installed in `test/revm-trusted-sender.spec.ts` — the same suite,
  parameterised by engine).

The sender you supply is the sender **on every engine**, including when the
signature on the wire recovers to somebody else (which is the case the mode exists
for). It is not a property an EVM works out: the node decides it once and passes it
across the [engine](#engine-ethereumjsevm-default-vs-revm-wasm-opt-in) seam as
`TransactionRequest.sender`, so the account charged, the nonce advanced and the
receipt's `from` are the same address whichever EVM executed the transaction. Both
engine specs assert that to the wei, from a transaction signed by one account and
submitted claiming another
([amendment 3](docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md#amendment-3-the-sender-crosses-the-seam-as-a-value-not-as-a-method-an-engine-calls)).

The primitive says exactly one thing: **execute this tx as this sender, do not
recover**. It is *not* an impersonation feature. Two different callers want it:

1. **An ordinary, genuinely-signed tx** that just wants to bypass a redundant
   recovery. The signature is real, merely unverified.
2. **A higher layer implementing impersonation** (anvil/hardhat style) on top: it
   holds no key, so it *fabricates* a signature, serialises the tx, and passes the
   claimed sender. This node never needs to know that happened.

Impersonation itself — an address registry plus unsigned `eth_sendTransaction` —
is account **policy**, and this package has no accounts by design. It belongs in a
layer above.

> **⚠️ `'trusted'` removes the only thing binding a tx to its sender.** Any caller
> can claim any address. Use it for a local, same-origin dev chain or an in-browser
> game. **Never** expose a `'trusted'` node over a transport an untrusted caller
> can reach.

### Caller contract (fabricated signatures only — case 2 above)

- **Make the tx bytes unique per sender.** `from` is *not* part of a transaction —
  it is the *output* of recovery — so the hash comes from the bytes alone. Two
  fabricated txs sharing a dummy signature, nonce, `to` and data hash **the same**
  even for different claimed senders, and would silently overwrite each other in
  the receipt/tx maps. Derive the dummy `r` from the sender address. (anvil hit
  exactly this: foundry #4210.)
- **Fabricated txs are not portable to a `'recover'` node.** `dumpState` stores raw
  tx bytes, so such a dump carries txs no authenticated node could validate. Fine
  for a local chain; do not treat it as replayable chain history.

Both caveats apply *only* to fabricated signatures. Genuinely-signed txs (case 1)
are unaffected: real signatures already differ per signer and validate anywhere.

## Engine: `@ethereumjs/evm` (default) vs revm-wasm (opt-in)

```ts
import {createNode} from 'embedded-eth-node';
import {createRevmEngine} from 'embedded-eth-node/revm';
import {wasmUrl} from 'revm-wasm/wasm-url';

const js = await createNode({}); // default — everything on @ethereumjs/evm
const fast = await createNode({engine: await createRevmEngine({wasm: wasmUrl})});

fast.engine.id; // 'revm-wasm' — which EVM this node was created with
```

The **engine** is the EVM behind the node, and the seam it plugs into has two
operations: a read-only **call** (`eth_call`, `eth_estimateGas` and
`eth_fillTransaction`'s estimation) and a committing **transaction** (the mining
path). It is an injected **object**, never a name the core resolves, so the core
imports no engine you did not
([ADR 0006](docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md)).
An engine implements BOTH operations: one that brings only `call` is refused at
`createNode()` rather than half-served, because the node has no second EVM to mine
on and would otherwise run two.

- **`@ethereumjs/evm`** (default): the node's own EVM, on both operations, exactly
  as it has always behaved — including the pure-read checkpoint/revert and the
  EIP-2929 warm/access reset for a read, and full validation for a transaction.
  Costs nothing: no option, no extra bytes, no wasm.
- **revm-wasm** (opt-in, `embedded-eth-node/revm`): the same reads AND the same
  transactions on [revm](https://github.com/bluealloy/revm) compiled to
  WebAssembly, charging **byte-identical gas**
  ([ADR 0003](docs/adr/0003-revm-wasm-is-the-engine-direction.md)). It reads and
  writes the node's own authoritative state through host callbacks — nothing is
  copied into wasm, a transaction writes back only the accounts it touched and
  the slots that changed, and a value it wrote is visible to the next `eth_call`
  with no sync step
  ([ADR 0010](docs/adr/0010-revm-reads-and-writes-through-host-callbacks-the-node-keeps-owning-state.md))
  — and runs both against the node's own
  **real block environment**: a contract reading `block.basefee`,
  `block.prevrandao`, `block.coinbase`, `block.number` or `block.timestamp`
  inside an `eth_call` gets the same answer from either engine. The differential
  conformance battery diffs exactly that, through a contract, because gas cannot
  see it: those opcodes are fee-independent, so an engine running your read
  against a block your node never had would still charge byte-identical gas.

**Measured, on the node — not on the raw engines.** The `frame` row is 100 small
view reads back to back against the 16.6 ms 60fps budget, median of 7 repeats,
one ordinary laptop
([conditions + raw samples](docs/spikes/revm-engine-under-conformance-and-gate/frame-measurements.md)):

| configuration | Chromium | WebKit |
|---|---|---|
| `createNode({})` — default `@ethereumjs/evm` engine | 10.2–10.4 ms (~62% of the frame) | 13.0 ms (~78%) |
| `createNode({engine: revm})` — **the node**, on revm | 3.5–3.9 ms (~22%) | 4.0 ms (~24%) |
| raw revm-wasm, no node, owning its own state (context only) | 2.9–4.2 ms | 4.0 ms |

So for this call shape the node itself gets **roughly 2.7× on Chromium and 3.3×
on WebKit**, and the node's per-call dispatch (the gap between rows 2 and 3) is
small — a fraction of a millisecond per 100 reads on Chromium, and below the
measurement floor on WebKit (which clamps `performance.now()` to 1 ms).
Do not quote the third row as what you get, and do not mix these with the
**raw-engine** figures elsewhere (11× compute / 19× keccak, and a 12.4 ms → 3.8 ms
frame): those compare interpreters with no node in the path, on a different, quiet
machine. Heavier calls (tight arithmetic, keccak loops) gain much more than this
frame row, which is dominated by per-call overhead rather than by execution.

**Scope of the revm engine: both halves, and state stays the node's.** It
implements the seam's read half AND its transaction half, so with it installed
your `eth_call`s, your `eth_estimateGas` and your mined transactions all run on
revm, against the node's own state. The node's own half never moves either way:
block construction, `cumulativeGasUsed`, receipt assembly, the RPC layer,
transaction parsing and sender derivation are the node's, on every engine — the
sender crosses the seam as a required value on the request, so an engine executes
on behalf of the address the node states rather than recovering one of its own (see
[Sender mode](#sender-mode-recover-authenticated-default-vs-trusted-no-ecrecover)).

**The block gas limit is a real limit, on both engines.** A transaction whose gas
limit exceeds the block's is REFUSED, with an error naming both numbers and the
knob, rather than mined against a limit the block does not have. If you want
enormous gas limits, say so: `createNode({blockGasLimit: 100_000_000n})`. The
block then really is that large, `GASLIMIT` reports it to a contract and
`eth_getBlockByNumber` reports it too, and both engines honour it by construction
because they are handed the same block.

This used to be the one place the two engines answered differently: the node told
`@ethereumjs/vm` to skip that check (`skipBlockGasLimitValidation`), while
`revm-wasm` expresses the same relaxation as a simulation switch it refuses to
combine with committing, so the same transaction was mined on the default engine
and rejected on revm. The flag is gone. A per-transaction exemption one engine
could not honour became a configured property of the block that both can, and the
node's default read budget for an `eth_call` that names no `gas` is deliberately
NOT tied to it (a bigger block should not silently buy every unbudgeted read a
longer runaway; pass `gas` on the call instead).

```ts
// both wasm delivery shapes are the SAME code path — `wasm` takes bytes, a URL,
// a string, a Response, or an already-compiled WebAssembly.Module.
import {wasmUrl} from 'revm-wasm/wasm-url';         // bundler-resolved asset
await createRevmEngine({wasm: wasmUrl});
await createRevmEngine({wasm: '/assets/revm.wasm'}); // fetched at runtime, so you
                                                     // can paint UI first
```

**`eth_call` semantics, not transaction semantics.** A read is not a
transaction, so the engine runs it with revm's simulation switches
(`disableBaseFee`, `disableBlockGasLimit`, `disableEip3607`), the same validity
rules every real client turns off to serve `eth_call`. That is what keeps a read
from an address holding **no ether** (including the zero address, which is what
`from` defaults to) working against a block with a real base fee, and a read from
an address that holds **code** (smart accounts, ERC-4337, multicall aggregators)
working at all: EIP-3607 is a rule about *sending* a transaction, and
`@ethereumjs/evm`'s `runCall` never enforced it either. The switches belong to
reads only: they are never combined with committing, which `revm-wasm` refuses
outright. **Your transactions get none of them** — the same engine's transaction
operation relaxes nothing, checks the nonce, and charges real fees, because a
transaction that runs with relaxed validity is not a transaction.

What is relaxed is a transaction's **validity**, never the **value transfer**:
revm's `disableBalanceCheck` is deliberately left off, so an `eth_call` carrying
more ether than the sender holds fails on either engine, exactly as it does on
geth (`ErrInsufficientBalance`). A read never invents funds it can then report.

Caveats, all of them real:

- **`stateMode:'none'` only.** revm reads the node's state SYNCHRONOUSLY (an
  interpreter has no suspension point mid-opcode) through `SimpleStateManager`'s
  checkpoint stacks, and `MerkleStateManager` has no synchronous view at any
  depth ([ADR 0005](docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md)).
  `createNode({stateMode:'trie', engine: revm})` **throws at construction**,
  naming the reason.
- **Only the hardforks it can COST.** The engine serves `berlin`, `london`,
  `paris`, `shanghai` and `cancun` (the node runs Cancun) and refuses `prague`
  and `osaka` at construction, naming the EIP: revm enforces EIP-7623's calldata
  floor from Prague on and the node's shared intrinsic-gas arithmetic does not
  compute it, so `eth_estimateGas` could hand you a gas limit revm itself would
  reject (`GasFloorMoreThanGasLimit`) — and a client uses an estimate as the
  transaction's gas limit; Osaka additionally caps a transaction's gas limit
  (EIP-7825) below this node's default read budget. The pre-Shanghai forks were
  refused too until `revm-wasm@0.3.1`, because both this node and revm charged
  EIP-3860's initcode word cost on forks that predate it; the node now charges
  that term only where `@ethereumjs/common` says the protocol does, and the
  three are back. The admitted range has an end at the BOTTOM too: the shared
  formula hardcodes EIP-2028's 16 gas per non-zero calldata byte, which was 68
  before Istanbul, so nothing below Istanbul is admissible without gating that
  term as well (anything in neither table is refused outright). Measurements:
  [`docs/spikes/prague-intrinsic-gas-floor-or-refuse/`](docs/spikes/prague-intrinsic-gas-floor-or-refuse/measurements.md),
  [`docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`](docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md)
  and [`docs/spikes/clause-b-covers-only-eip-3860-not-the-rest-of-the-formula/`](docs/spikes/clause-b-covers-only-eip-3860-not-the-rest-of-the-formula/measurements.md);
  reasoning: [ADR 0008](docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md).
  `REVM_SPEC_BY_HARDFORK` and `REVM_REFUSED_HARDFORKS` are exported if you want
  to ask in code. They are frozen: a reading surface, not an editing one, so
  re-admitting a fork by assigning to one of them fails at your assignment
  rather than quietly removing the guard.
- **One engine instance serves one node.** `connect` binds it; handing a
  connected engine to a second `createNode()` throws (it would otherwise
  re-point the FIRST node's reads at the second node's state). Call
  `createRevmEngine()` per node, passing the same compiled `WebAssembly.Module`
  to skip recompiling.
- **Not on the Worker path.** `createWorkerNode({engine})` is refused with a real
  error (an engine is a function-bearing object; comlink structured-clones the
  options, which would otherwise give you an opaque `DataCloneError`). To run
  revm in a Worker, build the engine INSIDE your own worker module —
  `createNode({engine: await createRevmEngine({wasm})})` there, then
  comlink-expose the node.
- **In Node.js**, `revm-wasm/wasm-url` is a `file:` URL and Node's `fetch` cannot
  resolve that scheme: read the bytes yourself
  (`readFileSync(fileURLToPath(wasmUrl))`) and pass those. In a browser the URL
  works as-is.
- **What you pay if you never opt in: nothing you ship.** `revm-wasm` is a plain
  dependency, so a JS-only consumer downloads its install bytes but bundles
  **zero** of them — the default entry point is 413.5 KB raw / 124.6 KB gzip and
  the benchmark suite asserts both that bound and that `revm-wasm` is absent from
  the default entry's module graph. Opting in adds the `.wasm` itself: 1.17 MB
  raw, 413 KB gzipped, fetched or bundled only by
  `import 'embedded-eth-node/revm'`.

**An engine that cannot come up takes the node down with it.** There is no
fallback path anywhere: if an engine fails to initialise, or refuses this node's
configuration, `createNode()` throws an error naming the engine and the cause. A
node quietly running `@ethereumjs/evm` when you asked for revm would work, return
correct results, and be an order of magnitude slower than you believe — you would
measure it, be confused, and have no signal. Pinned in
`test/slim-node-checks.spec.ts` beside the other honest-edge checks.

The revm engine faces the same bars as the default one: the differential
conformance battery (`test/revm-conformance.spec.ts`) and the cross-backend
execution-gas gate in `packages/benchmarks`, which asserts every backend charges
the same gas — two EVMs that agree on every return value can still disagree on
where execution runs OUT of gas.

## Genesis pre-state + block env

- **`initialState`** — full genesis pre-state (`address -> {balance, nonce, code,
  storage}`), richer than `initialBalances`. Load arbitrary starting state (funded
  EOAs, pre-deployed contracts with storage).
- **`blockEnv`** — override mined-block header (`coinbase`, `baseFeePerGas`,
  `number`, `timestamp`, `gasLimit`, `prevRandao`). Required to reproduce a
  GeneralStateTest `env`.

## Persistence (IndexedDB)

`createIndexedDBPersistence()` writes the dumped state as a single IndexedDB record
and rehydrates on `createNode()`. No trie, no RLP state-root walk — live-set-sized.
Verified to round-trip across a real page reload, including `eth_getLogs`.

## Mining

`{type:'auto'}` (mine per raw tx — pairs with `eth_sendRawTransactionSync`),
`{type:'manual'}` (only on `node.mine()`), or `{type:'interval', intervalMs}`.

## On comprehensive EVM test fixtures (`ethereum/tests`)

`GeneralStateTests` / `execution-spec-tests` verify a tx by comparing the
post-state **Merkle-Patricia trie root** (`hash`) + a `keccak(RLP(logs))` hash. The
default `stateMode:'none'` has no trie/root by design, so it can't consume those
fixtures — but the opt-in `stateMode:'trie'` **can**, and the test suite does
exactly that (see `test/statetest.spec.ts`, 5/5 vendored cases pass). `VMTests`
(the one trie-free format) is frozen at Homestead and useless for a Cancun node.
Beyond that, the test suite also runs a **differential** conformance check
(`test/conformance.spec.ts`): a battery of signed txs through BOTH the node and a
hand-wired trie-backed `@ethereumjs/vm` `runTx` reference, asserting field-by-field
equality of receipts/logs/return-data/gas/post-state in both state modes. That
reference is the oracle for the receipt and post-state steps but deliberately not
for all of them: the block-environment and value-bearing steps are diffed instead
against the node's OWN block plus the `blockEnv` it was configured with, and
against an absolute succeed/fail statement per sender and per value, because the
reference is a separate hand-built chain (its own timestamps, a zero coinbase, and
no receipt at all for a refused read) and those two classes of bug are structurally
invisible to it (see *conformance differential* in [`CONTEXT.md`](CONTEXT.md), and
the `THE ORACLE IS ...` comments in `test/helpers/conformance.ts`).

That same battery runs once more with the optional revm engine installed
(`test/revm-conformance.spec.ts`), in the one state mode that engine serves
(`'none'` — it refuses `'trie'` at construction), so the alternative EVM faces
the repo's strongest correctness bar rather than a softer one of its own. Nothing
is relaxed for it: `test/conformance.spec.ts` still runs both modes on the
default engine, unchanged.

## Development

```sh
pnpm install
pnpm build        # tsc -> dist/
pnpm test         # full browser test suite (Playwright + real Chromium)
pnpm format       # prettier
```

The browser tests run in real Chromium via
[`playwright-browser-harness`](https://www.npmjs.com/package/playwright-browser-harness)
and live under `test/` (specs + the in-browser code-under-test in `test/helpers/`,
vendored fixtures in `test/fixtures/`). They are dev-only and not published (`files`
ships `dist` + `src`). The library's devDependencies are deliberately minimal
(viem + the Playwright harness toolchain) — they do **not** include `tevm`.

The cross-backend **performance/bundle-size benchmark** (embedded-eth-node vs raw
`@ethereumjs/*` and `tevm`) lives in a separate, private, never-published package
(`packages/embedded-eth-node-benchmarks`) so that `tevm` and the benchmark
toolchain stay out of this library's dependency tree. Run it with
`pnpm --filter embedded-eth-node-benchmarks test`.

## License

MIT
