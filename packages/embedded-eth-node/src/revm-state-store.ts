/**
 * revm-state-store.ts — a SYNCHRONOUS `StateStore` (revm-wasm) over the node's
 * live `SimpleStateManager`, with NO state copied across and NO state owned.
 *
 * READ AND WRITE, both on demand. The engine reads accounts, code, storage and
 * block hashes as an opcode needs them, and a COMMITTING execute writes back
 * ONLY the accounts revm touched and the slots that changed. There is no bulk
 * sync in either direction and no second copy of state anywhere, which is what
 * keeps the cost proportional to what a transaction touched and why `dumpState`,
 * `loadState`, persistence and the `evm_set*` cheats keep working untouched. See
 * `docs/adr/0010-revm-reads-and-writes-through-host-callbacks-the-node-keeps-owning-state.md`
 * for the ownership decision, its measured cost and the caveat that cuts against
 * it.
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
 * retains one. The WRITE methods receive fresh arrays and may keep them, which
 * is what lets a storage value be stored without a copy.
 */
import {Account} from '@ethereumjs/util';
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

/**
 * The inverse of {@link pad32}: revm hands over 32 padded bytes and this
 * representation holds the SHORTEST form.
 *
 * Not a micro-optimisation — it is what makes a slot written by revm
 * indistinguishable from the same slot written by `@ethereumjs/evm`, which
 * strips leading zeros itself before `putStorage` (`opcodes/functions.js`, the
 * `SSTORE` case: a zero value becomes a ZERO-LENGTH array, anything else
 * `bigIntToBytes`). `dumpState` serialises the stored bytes verbatim, so a
 * padded write would round-trip correctly and dump differently.
 */
function shortest(v: Uint8Array): Uint8Array {
	let i = 0;
	while (i < v.length && v[i] === 0) i++;
	// A cleared slot is stored EMPTY rather than deleted, exactly as the default
	// engine stores it: `storageAt` stops its overlay walk on a zero-length value,
	// so an overlay below cannot leak a stale value through it.
	return i === 0 ? v : v.subarray(i);
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
	 * wires this to its `EngineContext` rather than defaulting it.
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
		typeof sm.liveStorage !== 'function' ||
		typeof sm.setStorageAt !== 'function' ||
		typeof sm.clearStorageAt !== 'function'
	) {
		throw new Error(
			'embedded-eth-node/revm: the state manager does not expose storageAt(), ' +
				"liveStorage(), setStorageAt() and clearStorageAt(), so it is not the node's " +
				'OverlayStorageStateManager. The revm engine reads AND writes storage ' +
				'synchronously through those accessors; a state manager with a different ' +
				'storage representation would answer every slot as ZERO rather than failing. ' +
				'See src/state-manager.ts.',
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
	/** Code hashes already looked for and NOT found — see {@link beginExecution}. */
	readonly #absentCodeHashes = new Set<string>();
	/**
	 * Code handed over by {@link setCode} during the execution now committing,
	 * keyed by hash, waiting for the {@link setAccount} that names the address it
	 * belongs to.
	 *
	 * THE BINDING'S COMMIT ORDER IS WHY THIS EXISTS, and it is measured rather than
	 * assumed (`docs/spikes/revm-executes-the-first-transaction-with-commit/`):
	 * `setCode(codeHash, code)` arrives BEFORE the `setAccount` carrying that hash,
	 * because revm's own state is keyed by code HASH while this node keys code by
	 * ADDRESS. Nobody but the account change knows the address, so the code waits
	 * one callback.
	 *
	 * Cleared per execution, not per commit: a hash left here would attach a
	 * previous transaction's code to an account of the same code hash, which is
	 * harmless (the key IS the content hash) but makes the reasoning harder than
	 * clearing it.
	 */
	readonly #pendingCode = new Map<string, Uint8Array>();
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
	 * documents `connect` as called exactly once (see `Engine.connect` in
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
	 * Start of one execution — a read-only call OR a committing transaction. Drops
	 * the negative code-index cache and any code left waiting for its account.
	 *
	 * A rebuild-on-miss index cannot cache a miss ACROSS executions: code deployed
	 * between two of them would stay invisible, and an invisible contract runs as
	 * EMPTY code and returns `success` with empty data — silently wrong (ADR
	 * 0005). WITHIN one execution it can, and must, because nothing else can write
	 * to the node's state while the interpreter holds the thread: JS runs
	 * single-threaded, a read-only call never calls a write method at all, and a
	 * transaction's writes all arrive at the END, during commit, after the last
	 * opcode. So a hash that is absent at the first opcode is absent at the last,
	 * and a contract that is genuinely absent no longer re-scans the whole code map
	 * on every access.
	 *
	 * NOT `beginCall`, which it was called while this store served only `eth_call`:
	 * *call* names the seam's READ operation in this codebase (`Engine.call`), and
	 * a transaction reaches here too now.
	 */
	beginExecution(): void {
		this.#absentCodeHashes.clear();
		this.#pendingCode.clear();
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
				'embedded-eth-node/revm: the engine touched state before connect() bound ' +
					'it to a node. Pass the engine to createNode() before using it.',
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
		const pending = this.#pendingCode.get(key);
		if (pending !== undefined) return pending;
		if (this.#absentCodeHashes.has(key)) return undefined;
		this.#reindexCode();
		const rebuilt = this.#byCodeHash.get(key);
		if (rebuilt === undefined) this.#absentCodeHashes.add(key);
		return rebuilt;
	}

	getBlockHash(blockNumber: bigint): Bytes32 | undefined {
		return this.#blockHash?.(blockNumber);
	}

	// --- the write half ------------------------------------------------------
	// ONLY a COMMITTING execute reaches these (`Revm#call` cannot be made to
	// commit, whatever its options say), and they arrive with revm's own commit
	// semantics ALREADY APPLIED: a `SELFDESTRUCT` and an EIP-161 empty-account
	// clearing both arrive as `clearStorage` then `removeAccount`, and a created
	// account arrives with `clearStorage` FIRST so a fresh contract cannot inherit
	// storage from a previous life at its address. None of that is re-derived here;
	// re-deriving it is how a host gets EIP-161 subtly wrong.
	//
	// EACH ONE IS ONE MAP WRITE INTO THE TOP OF THE NODE'S OWN STATE, at the same
	// depth `putAccount` / `putCode` / `putStorage` write to, so a transaction's
	// cost is proportional to what it touched and a `revert()` above still drops it.
	// They are written against the state manager's REPRESENTATION rather than its
	// async interface for the reason in the header: revm's commit runs inside a
	// synchronous wasm callback and every `StateManagerInterface` method returns a
	// `Promise`.

	setAccount(address: Address, account: AccountState): void {
		const accounts = this.#accounts;
		const key = addrKey(address);
		const existing = accounts.get(key);
		// The storage ROOT is carried over rather than computed: `SimpleStateManager`
		// implements no state-root logic at all, so this field never reflects storage
		// on either engine (ADR 0009 records the EIP-7610 consequence). Carrying it
		// keeps a revm-written account byte-identical to an ethereumjs-written one,
		// which is what `dumpState` serialises.
		accounts.set(
			key,
			new Account(
				account.nonce,
				account.balance,
				existing?.storageRoot,
				account.codeHash,
			),
		);
		// The code this account's hash names, if it arrived a callback ago. Written
		// HERE because this is the only callback that knows the address, and only when
		// `setCode` actually ran, which the binding does exactly when revm loaded or
		// deposited code for it — never for an account that merely received ether.
		const hashKey = hexOf(account.codeHash);
		const code = this.#pendingCode.get(hashKey);
		if (code !== undefined) this.#code.set(key, code);
	}

	setCode(codeHash: Bytes32, code: Uint8Array): void {
		// This one method writes only into the store's OWN index (the address it
		// belongs to arrives with the next `setAccount`), so it would otherwise be the
		// one write that an UNBOUND store accepted in silence.
		this.#connected();
		const key = hexOf(codeHash);
		this.#pendingCode.set(key, code);
		// A hash that was absent a moment ago exists now, so the negative cache must
		// forget it or a contract created inside this transaction would read as EMPTY
		// code in the next one.
		this.#absentCodeHashes.delete(key);
		this.#byCodeHash.set(key, code);
	}

	setStorage(address: Address, slot: Bytes32, value: Bytes32): void {
		this.#connected().setStorageAt(
			addrKey(address),
			'0x' + hexOf(slot),
			shortest(value),
		);
	}

	clearStorage(address: Address): void {
		this.#connected().clearStorageAt(addrKey(address));
	}

	removeAccount(address: Address): void {
		// A TOMBSTONE, not a delete, because that is what `deleteAccount` does
		// upstream (`SimpleStateManager` sets the key to `undefined`) and this store
		// must leave the node's state in the shape the default engine leaves it: a
		// `delete` would let an overlay-free account map answer from nothing while a
		// tombstone answers "absent", and `dumpState` skips both. The account's CODE is
		// deliberately left where it is, again matching upstream, which never removes
		// it either; nothing reads it, since revm asks for code by HASH.
		this.#accounts.set(addrKey(address), undefined);
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
