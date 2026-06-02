/**
 * types.ts — the public shape of the slim node. Deliberately tiny and
 * transport-agnostic: a node is just an object with an async EIP-1193 `request()`
 * plus a few node-owned controls (`mine`/`dumpState`/`loadState`). It knows
 * NOTHING about Workers — because `request()` is already async, the exact same
 * object works unchanged whether called on the main thread or across a thread
 * boundary (see ../worker.ts for the optional comlink wrapper).
 */

/** Minimal EIP-1193 request args. */
export interface RequestArguments {
	readonly method: string;
	readonly params?: readonly unknown[] | object;
}

/** EIP-1193-style JSON-RPC error (what we throw for honest gaps). */
export class RpcError extends Error {
	readonly code: number;
	readonly data?: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = 'RpcError';
		this.code = code;
		this.data = data;
	}
}

export type MiningConfig =
	| {type: 'auto'} // mine one block per raw tx (pairs with eth_sendRawTransactionSync)
	| {type: 'manual'} // only mine on explicit node.mine()
	| {type: 'interval'; intervalMs: number}; // mine on a timer

export interface PersistenceAdapter {
	/** Load the single serialized state record (or null on first run). */
	load(): Promise<SerializedState | null>;
	/** Persist the single serialized state record. */
	save(state: SerializedState): Promise<void>;
}

/**
 * State backing mode.
 * - `'none'` (DEFAULT): `SimpleStateManager` — plain Maps, NO trie, NO state root.
 *   The fast path; block `stateRoot`/`receiptsRoot`/`transactionsRoot` are zero
 *   placeholders (you are a local chain; canonical roots aren't needed). This is
 *   the recommended mode and what makes the node ~4× faster than the trie path.
 * - `'trie'`: `MerkleStateManager` — real Merkle-Patricia trie. SLOWER (recomputes
 *   the state root each tx) but produces a REAL `stateRoot`, which (a) lets the
 *   node be conformance-tested against `ethereum/tests` GeneralStateTests (they
 *   verify the post-state root), and (b) gives honest canonical block roots for
 *   consumers that need them. Opt-in: pay for the trie only when you want it.
 */
export type StateMode = 'none' | 'trie';

export interface NodeOptions {
	/** EIP-155 chain id. Default 31337 (anvil/hardhat-style local). */
	chainId?: number;
	/** State backing: `'none'` (fast, no trie/root — default) or `'trie'` (real
	 *  state root, slower; unlocks GeneralStateTests conformance). */
	stateMode?: StateMode;
	/** Mining strategy. Default {type:'auto'}. */
	miningConfig?: MiningConfig;
	/** Optional persistence adapter (e.g. IndexedDB). */
	persistence?: PersistenceAdapter;
	/** Constant gas-fee values (slim node — no real fee market). */
	baseFeePerGas?: bigint;
	gasPrice?: bigint;
	maxPriorityFeePerGas?: bigint;
	/** Block gas limit. Default 30_000_000n. */
	blockGasLimit?: bigint;
	/** Pre-fund accounts at genesis (address -> balance wei). */
	initialBalances?: Record<string, bigint>;
	/**
	 * Full genesis pre-state (address -> {balance, nonce, code, storage}). Richer
	 * than `initialBalances` (which only sets balance). Used to load an arbitrary
	 * starting state — e.g. a GeneralStateTest `pre` section — so that, in
	 * `stateMode:'trie'`, `getStateRoot()` after a tx can be compared to the
	 * fixture's expected post-state root. Applied at genesis, before block 0.
	 */
	initialState?: Record<string, GenesisAccount>;
	/**
	 * Override the header fields of MINED blocks (not genesis). Lets a consumer
	 * run a tx under a specific block environment (coinbase, base fee, number,
	 * timestamp, prevRandao) — required to reproduce a GeneralStateTest `env`
	 * (the coinbase is credited tx fees, so it affects the post-state root). When
	 * omitted, the node uses its own constant fee market + a zero coinbase.
	 */
	blockEnv?: BlockEnv;
}

/** A full genesis account (all fields optional except an implicit zero default). */
export interface GenesisAccount {
	balance?: bigint;
	nonce?: bigint;
	code?: string; // 0x-prefixed hex (omit/`0x` for EOA)
	storage?: Record<string, string>; // slot hex -> value hex
}

/** Mined-block header overrides (e.g. to honor a GeneralStateTest `env`). */
export interface BlockEnv {
	coinbase?: string;
	baseFeePerGas?: bigint;
	number?: bigint;
	timestamp?: bigint;
	gasLimit?: bigint;
	prevRandao?: string; // 0x-prefixed 32-byte hex (mixHash, post-Merge)
}

/** A slim node: transport-agnostic EIP-1193 + node-owned controls. */
export interface SlimNode {
	/** EIP-1193 request. Async ⇒ same object works on main thread or over comlink. */
	request(args: RequestArguments): Promise<unknown>;
	/** Mine one block now (only matters in manual/interval modes). */
	mine(): Promise<{blockNumber: number; blockHash: string; txHashes: string[]}>;
	/** Serialize all state to a plain object (live-set-sized; no trie/RLP walk). */
	dumpState(): Promise<SerializedState>;
	/** Restore state previously produced by dumpState (replaces current state). */
	loadState(state: SerializedState): Promise<void>;
	/** Subscribe to newHeads locally (used by eth_subscribe and consumers). */
	onNewHead(cb: (head: {number: number; hash: string}) => void): () => void;
	/**
	 * Current canonical state root. In `'trie'` mode this is the REAL
	 * Merkle-Patricia root (usable for GeneralStateTests conformance); in `'none'`
	 * mode the trie is absent so this throws (honest — there is no root to give).
	 */
	getStateRoot(): Promise<string>;
	/** The state mode this node was created with. */
	readonly stateMode: 'none' | 'trie';
	/** Stop timers / release resources. */
	dispose(): Promise<void>;
}

/** Slim, live-set-sized serialized state. No trie, no RLP state-root walk. */
export interface SerializedState {
	version: 1;
	chainId: number;
	/** State mode the dump was produced in (informational). */
	stateMode?: 'none' | 'trie';
	/** SimpleStateManager Maps: address -> hex-encoded account/code/storage. */
	accounts: Record<string, string>; // addr -> rlp/hex account
	code: Record<string, string>; // addr -> code hex
	storage: Record<string, Record<string, string>>; // addr -> (slot hex -> value hex)
	/** Block list (header fields we keep) keyed by number. */
	blocks: SerializedBlock[];
	/** Receipts keyed by tx hash. */
	receipts: Record<string, SerializedReceipt>;
	/** Raw tx + meta keyed by tx hash (for eth_getTransactionByHash). */
	transactions: Record<string, SerializedTx>;
}

export interface SerializedBlock {
	number: number;
	hash: string;
	parentHash: string;
	timestamp: number;
	gasUsed: string;
	gasLimit: string;
	baseFeePerGas: string;
	/** Real Merkle-Patricia state root in `'trie'` mode; zero placeholder in `'none'`. */
	stateRoot: string;
	transactions: string[]; // tx hashes
	logsCount: number;
}

export interface SerializedLog {
	address: string;
	topics: string[];
	data: string;
	blockNumber: number;
	blockHash: string;
	transactionHash: string;
	transactionIndex: number;
	logIndex: number;
}

export interface SerializedReceipt {
	transactionHash: string;
	transactionIndex: number;
	blockNumber: number;
	blockHash: string;
	from: string;
	to: string | null;
	contractAddress: string | null;
	cumulativeGasUsed: string;
	gasUsed: string;
	effectiveGasPrice: string;
	status: 0 | 1;
	type: number;
	logs: SerializedLog[];
	logsBloom: string;
}

export interface SerializedTx {
	hash: string;
	raw: string;
	from: string;
	to: string | null;
	nonce: number;
	value: string;
	input: string;
	type: number;
	blockNumber: number;
	blockHash: string;
	transactionIndex: number;
	gas: string;
	gasPrice: string | null;
	maxFeePerGas: string | null;
	maxPriorityFeePerGas: string | null;
}
