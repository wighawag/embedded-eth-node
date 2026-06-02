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
| `eth_call` | pure (checkpoint/revert, never mutates); reverts throw `RpcError(3, 'execution reverted')` |
| `eth_estimateGas` | honest run-and-measure (`executionGasUsed` + intrinsic incl. EIP-3860); verified == `runTx` `totalGasSpent` |
| `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount` | state reads at a block tag |
| `eth_gasPrice`, `eth_maxPriorityFeePerGas` | **constant** (faked fee market — local chain) |
| `eth_feeHistory` | correct response **shape**, but **constant/faked values** — not for real fee prediction |
| `eth_fillTransaction` | fills missing nonce/gas/fees of a tx request and returns `{tx, raw}` (the `raw` is **unsigned** — sign client-side); viem's `prepareTransactionRequest` uses it |
| **`eth_sendRawTransaction`** | accepts a **signed** raw tx; mines per `miningConfig` |
| **`eth_sendRawTransactionSync`** | the fast path: send + mine + return receipt in one call |
| `eth_getTransactionReceipt`, `eth_getTransactionByHash` | from the in-memory store |
| `eth_getLogs` | address + topic filtering over mined logs. **Perf note:** a full linear scan over all logs per call (O(total_logs), no index/cache) — fine for a local chain |
| `eth_subscribe`/`eth_unsubscribe` | **`newHeads` only**; prefer `onNewHead()` over comlink |
| `evm_setBalance` / `evm_setNonce` / `evm_setCode` / `evm_setStorageAt` / `evm_setAccount` | anvil/hardhat-style runtime state cheats (mutate live state with no tx); commit into the trie in `'trie'` mode |

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
equality of receipts/logs/return-data/gas/post-state in both state modes.

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
