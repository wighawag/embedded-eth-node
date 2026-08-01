/**
 * types.ts — the public shape of the slim node. Deliberately tiny and
 * transport-agnostic: a node is just an object with an async EIP-1193 `request()`
 * plus a few node-owned controls (`mine`/`dumpState`/`loadState`). It knows
 * NOTHING about Workers — because `request()` is already async, the exact same
 * object works unchanged whether called on the main thread or across a thread
 * boundary (see ../worker.ts for the optional comlink wrapper).
 *
 * The `@ethereumjs/*` imports below are TYPE-ONLY (erased at build time), so this
 * module — and the core entry point that re-exports it — adds no runtime import.
 */
import type {Address} from '@ethereumjs/util';
import type {Block} from '@ethereumjs/block';
import type {StateManagerInterface} from '@ethereumjs/common';
import type {Common} from '@ethereumjs/common';

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

/**
 * Sender-derivation mode.
 * - `'recover'` (DEFAULT): derive the sender from the signature with ecrecover,
 *   exactly as a real node does. The tx is self-authenticating: a caller cannot
 *   claim to be an address it does not hold the key for. This is the only mode
 *   that is safe when the node is reachable by a caller you do not control.
 * - `'trusted'`: TRUST a caller-supplied sender and SKIP ecrecover entirely.
 *   Enables `evm_sendRawTransactionAs` / `evm_sendRawTransactionSyncAs`, which
 *   take an explicit `from`. The signature is still carried on the wire and the
 *   tx hash is still the real one, but it is NEVER verified, so ANY caller can
 *   claim to be ANY address.
 *
 * Why it exists: ecrecover is a FIXED ~2ms per tx and it dominates small txs
 * (~80% of a 21k-gas transfer). A client that signed the tx already knows the
 * sender, so re-deriving it is pure waste in a local chain. Measured ~13x on
 * `runTx` in isolation and ~2.3x end-to-end through a viem-style client, with
 * byte-identical gas and status.
 *
 * The primitive is just "execute as this sender, do not recover". It serves BOTH
 * an ordinary signed tx that wants to skip a redundant recovery AND a higher
 * layer building anvil-style impersonation on top with a fabricated signature.
 * Impersonation itself is account POLICY and is deliberately NOT this package's
 * job — see the `parseTx` docblock in node.ts for the full caller contract
 * (notably: fabricated txs must be made unique per sender, or their hashes
 * collide).
 *
 * The trade is real and one-directional: `'trusted'` removes the ONLY thing that
 * binds a tx to its sender. Use it for a local, same-origin dev chain or an
 * in-browser game. Never expose a `'trusted'` node over a transport that an
 * untrusted caller can reach.
 */
export type SenderMode = 'recover' | 'trusted';

/**
 * One read-only call for an {@link ReadEngine} to execute: exactly the inputs the
 * node's pure-read helper has always handed `runCall`, and nothing more.
 *
 * The value types are `@ethereumjs/*`'s own (`Address`, `Block`) rather than hex
 * strings, because the node already holds them in that form and the default
 * engine passes them straight through — converting at the seam would add cost and
 * a chance to change behaviour, in a refactor whose whole point is changing none.
 */
export interface ReadCallRequest {
	/** Caller (`msg.sender`). The node defaults it to the zero address. */
	readonly from: Address;
	/** Callee, or `undefined` for a CREATE-shaped call (gas estimation). */
	readonly to?: Address;
	/** Calldata (or init code when `to` is absent). */
	readonly data: Uint8Array;
	readonly value: bigint;
	/** Gas made available to EXECUTION (intrinsic gas is the node's business). */
	readonly gasLimit: bigint;
	/** The block the call observes (NUMBER, TIMESTAMP, COINBASE, BASEFEE...). */
	readonly block: Block;
}

/** What an engine reports back for a read-only call. */
export interface ReadCallResult {
	/** Return data (or the revert data when `error` is set). */
	readonly returnValue: Uint8Array;
	/**
	 * EXECUTION gas only — NOT a transaction's total. `eth_estimateGas` adds the
	 * intrinsic gas (21000 base, +32000 create, calldata bytes, EIP-3860 initcode)
	 * on top, exactly as it did before the seam existed.
	 */
	readonly executionGasUsed: bigint;
	/** Set iff execution failed (revert/halt); the EVM's own error string. */
	readonly error?: string;
}

/**
 * What the node hands an engine once, at construction, so the engine can reach
 * the node's AUTHORITATIVE state. Deliberately minimal: a later engine that needs
 * more adds a field here rather than the node guessing now (ADR 0006 names this
 * additive widening as the sanctioned way to grow the seam — `getBlockHash`
 * arrived that way, for `embedded-eth-node/revm`).
 */
export interface ReadEngineContext {
	/** The node's live state manager. The node keeps ownership; do not fork it. */
	readonly stateManager: StateManagerInterface;
	/** Chain params (chain id, hardfork, custom crypto) the node runs under. */
	readonly common: Common;
	/**
	 * The hash of one of the node's blocks, by number, for the `BLOCKHASH` opcode
	 * — `undefined` for a block the node does not have (the EVM then reads zero).
	 *
	 * SYNCHRONOUS, unlike everything else the node does with blocks, because
	 * `BLOCKHASH` is answered in the middle of an opcode and a wasm interpreter has
	 * no suspension point to await at. It is a live lookup, not a snapshot: the
	 * node has mined no blocks yet when `connect` runs.
	 *
	 * An engine that leaves this unwired makes `BLOCKHASH` answer nothing for
	 * blocks the node actually has, silently — which is why it is on the context
	 * rather than an engine-side option to remember to pass.
	 */
	getBlockHash(blockNumber: bigint): Uint8Array | undefined;
	/**
	 * The node's state mode. An engine that cannot serve it must THROW here —
	 * `connect` is called during `createNode()`, so the refusal lands at
	 * construction rather than at the first opcode.
	 */
	readonly stateMode: StateMode;
}

/**
 * An EVM behind the node's READ path — `eth_call`, `eth_estimateGas` and
 * `eth_fillTransaction`'s gas estimation. Transactions are NOT routed through it
 * (they run on `@ethereumjs/vm`), which is why the node exposes it as
 * {@link SlimNode.readEngine} rather than as "the engine".
 *
 * An engine is an INJECTED OBJECT, never a name the core resolves — see
 * `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md`.
 *
 * A read-only call MUST NOT mutate the node's state. Whatever it takes to hold
 * that (a checkpoint/revert, a warm-slot reset, or nothing at all) is the
 * ENGINE's business, not the node's: the default `@ethereumjs/evm` engine needs
 * both and pays for both, an engine that is structurally incapable of committing
 * pays for neither.
 */
export interface ReadEngine {
	/**
	 * Stable identifier for bug reports (`'@ethereumjs/evm'` for the default).
	 * Surfaced verbatim as `node.readEngine.id`.
	 */
	readonly id: string;
	/**
	 * Bind to the node's state + chain context. Called EXACTLY once, during
	 * `createNode()`, before any call. Optional: an engine the node itself builds
	 * already has what it needs. Throwing here fails node construction.
	 */
	connect?(context: ReadEngineContext): void | Promise<void>;
	/** Execute one read-only call against the node's CURRENT state. */
	call(request: ReadCallRequest): Promise<ReadCallResult>;
}

/** Which engine a node is running its reads on (see {@link SlimNode.readEngine}). */
export interface ReadEngineInfo {
	/** The engine's stable identifier, e.g. `'@ethereumjs/evm'`. */
	readonly id: string;
}

export interface NodeOptions {
	/** EIP-155 chain id. Default 31337 (anvil/hardhat-style local). */
	chainId?: number;
	/** State backing: `'none'` (fast, no trie/root — default) or `'trie'` (real
	 *  state root, slower; unlocks GeneralStateTests conformance). */
	stateMode?: StateMode;
	/**
	 * Sender derivation: `'recover'` (ecrecover, authenticated — DEFAULT) or
	 * `'trusted'` (skip ecrecover, trust a caller-supplied `from`). See
	 * {@link SenderMode}. `'trusted'` is ~13x faster per small tx and lets ANY
	 * caller impersonate ANY address — opt in only for a local chain you control.
	 */
	senderMode?: SenderMode;
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
	/**
	 * EVM engine for the READ path (`eth_call`, `eth_estimateGas` and
	 * `eth_fillTransaction`'s estimation). Default: `@ethereumjs/evm`, i.e. exactly
	 * what the node has always run. Transactions run on `@ethereumjs/vm`
	 * regardless, so a node with a non-default engine runs TWO EVMs — read
	 * `node.readEngine` to know which one produced a read.
	 *
	 * An engine is passed as an OBJECT, never named by a string: the core must not
	 * reference engines it does not use, or a consumer of the JS-only path would
	 * pay (in bundle size) for an engine they never import. See
	 * `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md`.
	 */
	engine?: ReadEngine;
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
	/** The sender mode this node was created with. */
	readonly senderMode: SenderMode;
	/**
	 * The engine this node runs READS on (`eth_call`, `eth_estimateGas`,
	 * `eth_fillTransaction`'s estimation) — `{id: '@ethereumjs/evm'}` unless an
	 * engine was injected. It is NOT what executed transactions: those always run
	 * on `@ethereumjs/vm`, so a receipt can never be attributed to this engine.
	 */
	readonly readEngine: ReadEngineInfo;
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
