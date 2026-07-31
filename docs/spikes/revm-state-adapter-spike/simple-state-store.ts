/**
 * simple-state-store.ts — a synchronous `StateStore` (revm-wasm@0.1.0) over the
 * node's live `SimpleStateManager`, with NO state copied across.
 *
 * See docs/adr/0005 for what this costs. The short version: it reaches PAST
 * `StateManagerInterface` into `SimpleStateManager`'s three public checkpoint
 * stacks, which is the only synchronous view of the node's state that exists.
 *
 * `Address` and `Bytes32` arguments are revm's REUSED scratch buffers, valid
 * only for the duration of the call. Everything below consumes them immediately
 * (into a string key, or into a keccak hash); nothing retains one.
 */
import type {SimpleStateManager} from '@ethereumjs/statemanager';
import type {Account} from '@ethereumjs/util';
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
function slotKey(a: Uint8Array, slot: Uint8Array): string {
	let s = '0x';
	for (let i = 0; i < 20; i++) s += HEX[a[i]];
	s += '_0x';
	for (let i = 0; i < slot.length; i++) s += HEX[slot[i]];
	return s;
}
function hashKey(h: Uint8Array): string {
	let s = '';
	for (let i = 0; i < h.length; i++) s += HEX[h[i]];
	return s;
}

/** SimpleStateManager stores storage values UNPADDED; revm wants 32 bytes. */
function pad32(v: Uint8Array): Bytes32 {
	if (v.length === 32) return v;
	const out = new Uint8Array(32);
	out.set(v, 32 - v.length);
	return out;
}

export interface SimpleStateStoreOptions {
	/** Answers BLOCKHASH. Return 32 zero bytes for a block you do not know. */
	blockHash?: (blockNumber: bigint) => Bytes32 | undefined;
}

export class SimpleStateManagerStore implements StateStore {
	readonly #sm: SimpleStateManager;
	readonly #blockHashFn?: (n: bigint) => Bytes32 | undefined;
	/** codeHash (unprefixed hex) -> code. Derived, never authoritative. */
	readonly #byCodeHash = new Map<string, Uint8Array>();

	constructor(sm: SimpleStateManager, options: SimpleStateStoreOptions = {}) {
		this.#sm = sm;
		this.#blockHashFn = options.blockHash;
	}

	// --- the three top-of-stack views -------------------------------------
	// Read the TOP of the stack on EVERY access. The node checkpoints and reverts
	// around each pure call, and `checkpointSync()` pushes a COPY, so a view
	// cached across a checkpoint reads a stale frame.
	get #accounts(): Map<string, Account | undefined> {
		const s = (this.#sm as any).accountStack;
		return s[s.length - 1];
	}
	get #code(): Map<string, Uint8Array> {
		const s = (this.#sm as any).codeStack;
		return s[s.length - 1];
	}
	get #storage(): Map<string, Uint8Array> {
		const s = (this.#sm as any).storageStack;
		return s[s.length - 1];
	}

	getAccount(address: Address): AccountState | undefined {
		const acc = this.#accounts.get(addrKey(address));
		if (acc === undefined) return undefined;
		return {balance: acc.balance, nonce: acc.nonce, codeHash: acc.codeHash};
	}

	getStorage(address: Address, slot: Bytes32): Bytes32 | undefined {
		const v = this.#storage.get(slotKey(address, slot));
		if (v === undefined || v.length === 0) return undefined;
		return pad32(v);
	}

	getCode(codeHash: Bytes32): Uint8Array | undefined {
		const key = hashKey(codeHash);
		const hit = this.#byCodeHash.get(key);
		if (hit !== undefined) return hit;
		this.#reindexCode();
		return this.#byCodeHash.get(key);
	}

	getBlockHash(blockNumber: bigint): Bytes32 | undefined {
		return this.#blockHashFn?.(blockNumber);
	}

	// --- read-only: every write throws -------------------------------------
	setAccount(): void {
		throw new Error('read-only store: eth_call cannot commit state');
	}
	setCode(): void {
		throw new Error('read-only store: eth_call cannot commit state');
	}
	setStorage(): void {
		throw new Error('read-only store: eth_call cannot commit state');
	}
	clearStorage(): void {
		throw new Error('read-only store: eth_call cannot commit state');
	}
	removeAccount(): void {
		throw new Error('read-only store: eth_call cannot commit state');
	}

	/**
	 * Rebuild codeHash -> code from the live code map. The node keys code by
	 * ADDRESS; revm asks by HASH, so somebody has to hold the inverse, and it is
	 * derived state living outside the state manager.
	 *
	 * Rebuilt on a MISS (and only on a miss), so the cost is one keccak per
	 * account-with-code per newly-deployed contract, not per read.
	 */
	#reindexCode(): void {
		this.#byCodeHash.clear();
		for (const c of this.#code.values())
			this.#byCodeHash.set(hashKey(keccak_256(c)), c);
	}

	/** How many code blobs the index currently holds. For the harness. */
	get indexedSize(): number {
		return this.#byCodeHash.size;
	}
}
