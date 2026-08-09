/**
 * revm-state-store.ts — a SYNCHRONOUS `StateStore` (revm-wasm) over the node's
 * live `SimpleStateManager`, with NO state copied across and NO state owned.
 *
 * ## The coupling this buys, stated plainly
 *
 * revm's state reads must be synchronous: the interpreter is a synchronous loop
 * inside wasm and a read happens in the middle of an opcode, so there is no
 * suspension point to await at. Every method on `StateManagerInterface` returns
 * a `Promise`. The ONLY synchronous view of the node's state that exists is the
 * node's own `OverlayStorageStateManager` — `SimpleStateManager`'s two PUBLIC
 * account/code checkpoint stacks plus our storage OVERLAY stack — so this module
 * reaches past the interface into that one implementation, exactly as `node.ts`'s
 * `dumpState` already does in `'none'` mode. The full cost, the alternatives
 * that were rejected, and why `stateMode:'trie'` therefore cannot be served are
 * in `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md`.
 *
 * Three consequences worth having in your head before editing this file:
 *
 * 1. **Read the TOP of the stack on EVERY access.** A checkpoint pushes a COPY
 *    of the account and code maps, so a frame captured once answers from the
 *    frame below after the next checkpoint — silently, with no error and
 *    plausible values. Storage is read through `storageAt()`, which walks the
 *    overlay stack live for the same reason.
 * 2. **The key formats are the state manager's, not ours**, and must be
 *    reproduced byte for byte: `address.toString()` (`0x`-prefixed lowercase
 *    hex) for accounts and code, and the same address key plus a `0x`-prefixed
 *    slot key for storage. Storage values are stored in shortest form, so reads
 *    left-pad to 32 bytes.
 * 3. **`@ethereumjs/statemanager` is version-pinned deliberately.** Renaming a
 *    stack is a compile error here (which is why this file uses the real
 *    `OverlayStorageStateManager` type and not `any`); changing the KEY FORMAT or
 *    the value padding would compile and return wrong values. {@link assertStateShape}
 *    catches the structural half at construction, and the cross-backend gas gate
 *    catches the rest, because feeding revm the wrong state changes gas.
 *
 * The `Address` and `Bytes32` arguments on the READ methods are revm's REUSED
 * scratch buffers, valid only for the duration of the call. Everything here
 * consumes them immediately (into a string key, or into a keccak hash); nothing
 * retains one.
 */
import type {Account} from '@ethereumjs/util';
import type {OverlayStorageStateManager} from './state-manager.js';
import {keccak_256} from '@noble/hashes/sha3.js';
import type {AccountState, Address, Bytes32, StateStore} from 'revm-wasm';

const HEX = /* @__PURE__ */ (() => {
	const t: string[] = [];
	for (let i = 0; i < 256; i++) t.push(i.toString(16).padStart(2, '0'));
	return t;
})();

/** `0x`-prefixed lowercase hex — the exact key format SimpleStateManager uses. */
function addrKey(a: Uint8Array): string {
	let s = '0x';
	for (let i = 0; i < 20; i++) s += HEX[a[i]];
	return s;
}
function hexOf(b: Uint8Array): string {
	let s = '';
	for (let i = 0; i < b.length; i++) s += HEX[b[i]];
	return s;
}

/** SimpleStateManager stores storage values UNPADDED; revm wants 32 bytes. */
function pad32(v: Uint8Array): Bytes32 {
	if (v.length === 32) return v;
	const out = new Uint8Array(32);
	out.set(v, 32 - v.length);
	return out;
}

/** keccak256 of the empty byte string, i.e. the code hash of every EOA. */
const EMPTY_CODE_HASH_HEX = /* @__PURE__ */ hexOf(keccak_256(new Uint8Array()));
const EMPTY_CODE = /* @__PURE__ */ new Uint8Array();

/**
 * A per-account view of storage: the address half of the key is bound once, and
 * each read supplies only the slot.
 *
 * The node's storage IS `Map<address, Map<slot, value>>` behind a stack of
 * overlays, so this is a thin binding rather than a translation — but it stays a
 * named seam because it is the ONE place a storage key is built, and the packed
 * key encoding (worth ~50% of a cold revm access, deferred to
 * `revm-state-store-packed-storage-keys`) replaces exactly this and nothing else.
 */
interface AccountStorageView {
	/** The raw (possibly zero-length, possibly short) stored value. */
	get(slotHex: string): Uint8Array | undefined;
}

/** What the store needs from the node beyond its state manager. */
export interface SimpleStateStoreOptions {
	/**
	 * Answers `BLOCKHASH`, from the node's own blocks. Returning `undefined` (or
	 * leaving this unset) makes `BLOCKHASH` answer 32 zero bytes, which is a
	 * silently wrong answer for a block the node actually has — so the engine
	 * wires this to the read-engine context rather than defaulting it.
	 */
	blockHash?: (blockNumber: bigint) => Uint8Array | undefined;
}

/**
 * Throw unless `sm` still has the exact representation this adapter reads: the
 * two upstream account/code checkpoint stacks AND the node's own storage overlay
 * stack. Cheap, once, at engine construction.
 *
 * IT MUST CONSTRAIN THE REPRESENTATION, NOT MERELY ITS SHELL. Its predecessor
 * asserted "three non-empty arrays of Maps", which a per-account layout satisfied
 * while every storage read silently answered zero — the guard passed on exactly
 * the change it existed to catch (demonstrated in
 * `docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/measurements.md`).
 * So this asserts the storage side by the two ACCESSORS the adapter actually
 * calls plus the overlay stack's own shape, and `test/storage-overlay.spec.ts`
 * feeds it a stock `SimpleStateManager` (the flat layout) to prove it refuses one.
 */
export function assertStateShape(sm: OverlayStorageStateManager): void {
	for (const name of ['accountStack', 'codeStack'] as const) {
		const stack = sm[name] as unknown;
		if (
			!Array.isArray(stack) ||
			stack.length === 0 ||
			!(stack[stack.length - 1] instanceof Map)
		) {
			throw new Error(
				`embedded-eth-node/revm: the state manager does not have the expected ` +
					`SimpleStateManager.${name} (a non-empty array of Maps). The revm engine ` +
					`reads the node's state through those stacks — see ` +
					`docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md. ` +
					`Check the @ethereumjs/statemanager version.`,
			);
		}
	}
	if (
		typeof sm.storageAt !== 'function' ||
		typeof sm.liveStorage !== 'function'
	) {
		throw new Error(
			'embedded-eth-node/revm: the state manager does not expose storageAt() and ' +
				"liveStorage(), so it is not the node's OverlayStorageStateManager. The revm " +
				'engine reads storage synchronously through those accessors; a state manager ' +
				'with a different storage representation would answer every slot as ZERO ' +
				'rather than failing. See src/state-manager.ts.',
		);
	}
	const overlays = sm.storageOverlays as unknown;
	const top = Array.isArray(overlays)
		? (overlays[overlays.length - 1] as StorageOverlayShape | undefined)
		: undefined;
	if (
		!Array.isArray(overlays) ||
		overlays.length === 0 ||
		!(top?.written instanceof Map) ||
		!(top?.cleared instanceof Set)
	) {
		throw new Error(
			'embedded-eth-node/revm: the state manager does not have the expected ' +
				'storageOverlays (a non-empty array whose top overlay has a `written` Map ' +
				'and a `cleared` Set). See src/state-manager.ts.',
		);
	}
}

/** Only what {@link assertStateShape} checks, so the guard can look before it leaps. */
interface StorageOverlayShape {
	written?: unknown;
	cleared?: unknown;
}

/**
 * revm's `StateStore`, backed by the node's live state.
 *
 * Created UNBOUND and bound in the engine's `connect(context)`: an injected
 * engine exists before the node does (ADR 0006), and the wasm instance needs its
 * store at instantiation time, so the store is the thing that waits.
 */
export class SimpleStateManagerStore implements StateStore {
	#sm: OverlayStorageStateManager | undefined;
	#blockHash: ((blockNumber: bigint) => Uint8Array | undefined) | undefined;
	/** codeHash (unprefixed hex) -> code. Derived, never authoritative. */
	readonly #byCodeHash = new Map<string, Uint8Array>();
	/** Code hashes already looked for and NOT found — see {@link beginCall}. */
	readonly #absentCodeHashes = new Set<string>();
	/** Memoised per-account storage views, keyed by address key. */
	readonly #storageViews = new Map<string, AccountStorageView>();

	/**
	 * Bind to the node's live state manager. Called once, from `connect`.
	 *
	 * ONE ENGINE SERVES ONE NODE, and a second bind is refused rather than
	 * honoured. An engine instance owns one wasm instance and this one store, so
	 * rebinding would re-point an ALREADY-RUNNING node's reads at a different
	 * node's state — the first node would then answer every `eth_call` from the
	 * second node's accounts, with plausible values and no error. The seam
	 * documents `connect` as called exactly once (see `ReadEngine.connect` in
	 * ./types.ts), so a second call is a consumer sharing one engine across nodes,
	 * and it fails at the second construction rather than at the first wrong read.
	 */
	bind(
		sm: OverlayStorageStateManager,
		options: SimpleStateStoreOptions = {},
	): void {
		if (this.#sm !== undefined) {
			throw new Error(
				'embedded-eth-node/revm: this engine is already connected to a node. An ' +
					'engine instance serves ONE node — reconnecting it would re-point the ' +
					"FIRST node's reads at the second node's state, silently. Call " +
					'createRevmEngine() once per createNode(); pass the same compiled ' +
					'WebAssembly.Module to each if you want to compile the wasm only once.',
			);
		}
		assertStateShape(sm);
		this.#sm = sm;
		this.#blockHash = options.blockHash;
	}

	/**
	 * Start of one execution. Drops the negative code-index cache.
	 *
	 * A rebuild-on-miss index cannot cache a miss ACROSS calls: code deployed
	 * between two calls would stay invisible, and an invisible contract runs as
	 * EMPTY code and returns `success` with empty data — silently wrong (ADR
	 * 0005). WITHIN one call it can, and must, because nothing can write to the
	 * node's state while the interpreter holds the thread: a read-only call never
	 * calls a write method, and JS runs single-threaded. So a hash that is absent
	 * at the first opcode is absent at the last, and a contract that is genuinely
	 * absent no longer re-scans the whole code map on every access.
	 */
	beginCall(): void {
		this.#absentCodeHashes.clear();
	}

	// --- the three top-of-stack views -------------------------------------
	// stack[stack.length - 1] on EVERY access. See the header: a cached frame is
	// stale after the next checkpoint, silently.
	get #accounts(): Map<string, Account | undefined> {
		const s = this.#connected().accountStack;
		return s[s.length - 1];
	}
	get #code(): Map<string, Uint8Array> {
		const s = this.#connected().codeStack;
		return s[s.length - 1];
	}

	#connected(): OverlayStorageStateManager {
		if (this.#sm === undefined)
			throw new Error(
				'embedded-eth-node/revm: the engine read state before connect() bound it ' +
					'to a node. Pass the engine to createNode() before using it.',
			);
		return this.#sm;
	}

	/** The ONLY place a storage key is built. */
	#storageOf(addressKey: string): AccountStorageView {
		let view = this.#storageViews.get(addressKey);
		if (view === undefined) {
			// Walks the overlay stack afresh each time: the top of it moves.
			view = {
				get: (slotHex) =>
					this.#connected().storageAt(addressKey, '0x' + slotHex),
			};
			this.#storageViews.set(addressKey, view);
		}
		return view;
	}

	getAccount(address: Address): AccountState | undefined {
		const acc = this.#accounts.get(addrKey(address));
		if (acc === undefined) return undefined;
		return {balance: acc.balance, nonce: acc.nonce, codeHash: acc.codeHash};
	}

	getStorage(address: Address, slot: Bytes32): Bytes32 | undefined {
		const v = this.#storageOf(addrKey(address)).get(hexOf(slot));
		if (v === undefined || v.length === 0) return undefined;
		return pad32(v);
	}

	getCode(codeHash: Bytes32): Uint8Array | undefined {
		const key = hexOf(codeHash);
		if (key === EMPTY_CODE_HASH_HEX) return EMPTY_CODE;
		const hit = this.#byCodeHash.get(key);
		if (hit !== undefined) return hit;
		if (this.#absentCodeHashes.has(key)) return undefined;
		this.#reindexCode();
		const rebuilt = this.#byCodeHash.get(key);
		if (rebuilt === undefined) this.#absentCodeHashes.add(key);
		return rebuilt;
	}

	getBlockHash(blockNumber: bigint): Bytes32 | undefined {
		return this.#blockHash?.(blockNumber);
	}

	// --- read-only: every write throws -------------------------------------
	// `Revm#call` cannot be made to commit, so a store backing eth_call never
	// sees these. If one is ever reached, that is a real bug and it must be LOUD
	// rather than a half-written state. The write half is `revm-engine-behind-runtx`.
	setAccount(): void {
		throw new Error(readOnly('setAccount'));
	}
	setCode(): void {
		throw new Error(readOnly('setCode'));
	}
	setStorage(): void {
		throw new Error(readOnly('setStorage'));
	}
	clearStorage(): void {
		throw new Error(readOnly('clearStorage'));
	}
	removeAccount(): void {
		throw new Error(readOnly('removeAccount'));
	}

	/**
	 * Rebuild codeHash -> code from the live code map. The node keys code by
	 * ADDRESS; revm asks by HASH, so somebody has to hold the inverse, and it is
	 * derived state living outside the state manager.
	 *
	 * Rebuilt on a MISS (and only on a miss), so the cost is one keccak per
	 * account-with-code per newly-deployed contract, not per read. Rebuild-on-miss
	 * rather than a hook on `putCode`, because code reaches the state manager by
	 * several routes (`evm_setCode`, `loadState`, a contract creation inside a
	 * transaction) and a hook can be forgotten by the next one. A hash that HITS
	 * can never be wrong: the key IS the content hash.
	 */
	#reindexCode(): void {
		this.#byCodeHash.clear();
		for (const c of this.#code.values())
			this.#byCodeHash.set(hexOf(keccak_256(c)), c);
	}
}

function readOnly(method: string): string {
	return (
		`embedded-eth-node/revm: ${method}() was called on a READ-ONLY state store. ` +
		'eth_call cannot commit state; this is a bug in the engine, not in your call.'
	);
}
