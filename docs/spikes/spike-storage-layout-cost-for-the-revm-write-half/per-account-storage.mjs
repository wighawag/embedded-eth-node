/**
 * per-account-storage.mjs: the prototype this spike exists to measure, a
 * `SimpleStateManager` whose storage is `Map<address, Map<slot, value>>` with
 * COPY-ON-WRITE checkpoints, plus the NAIVE version that gets it wrong (kept as
 * a control, because a correctness claim with nothing to fail against is not a
 * claim).
 *
 * SPIKE CODE. It lives here and not in `packages/embedded-eth-node/src/`
 * deliberately; nothing imports it but the probes next to it.
 *
 * ## What is replaced, and what is deliberately not
 *
 * `SimpleStateManager` keeps three parallel checkpoint stacks and copies ALL
 * THREE on `checkpointSync()`. Only the STORAGE stack is re-layered here; the
 * account and code halves are copied byte-for-byte as upstream does them, so an
 * A/B against the stock class isolates the storage half rather than measuring an
 * unrelated rewrite.
 *
 * ## Copy-on-write is the design, not an optimisation
 *
 * `new Map(outer)` copies the outer map and SHARES every inner map. A child
 * frame writing a slot would then mutate the parent's inner map, so the write
 * would survive a revert and a reverted `SSTORE` would land in committed state
 * with no error anywhere. So each frame tracks which inner maps it OWNS (has
 * cloned), and the first write to an account it does not own clones that
 * account's map first. {@link NaivePerAccountStorageStateManager} is the same
 * class without that, and the probe's fuzz shows it diverging.
 *
 * ## The field-initialiser trap, which will bite the next person
 *
 * `SimpleStateManager`'s CONSTRUCTOR calls `this.checkpointSync()`. A subclass
 * field declaration (`storageFrames = []`) runs AFTER `super()` returns, so it
 * would overwrite whatever that first checkpoint created, with `undefined` if
 * the field has no initialiser. There is therefore NO field declaration here on
 * purpose: `storageFrames` is created lazily inside the override.
 */
import {SimpleStateManager, util} from './support.mjs';

const {bytesToHex} = util;

/** A storage checkpoint frame. */
function frame(map) {
	return {
		/** address key -> (slot hex -> value). Inner maps may be SHARED with frames below. */
		map,
		/** The subset of `map`'s inner maps this frame cloned and may mutate in place. */
		owned: new Set(),
	};
}

export class PerAccountStorageStateManager extends SimpleStateManager {
	// --- the checkpoint contract -------------------------------------------

	/**
	 * Push a frame. Accounts and code exactly as upstream; storage copies the
	 * OUTER map only, so the cost is O(accounts touched so far) rather than
	 * O(total slots).
	 */
	checkpointSync() {
		const newTopA = new Map(this.topAccountStack());
		for (const [address, account] of newTopA) {
			newTopA.set(
				address,
				account !== undefined
					? Object.assign(
							Object.create(Object.getPrototypeOf(account)),
							account,
						)
					: undefined,
			);
		}
		this.accountStack.push(newTopA);
		this.codeStack.push(new Map(this.topCodeStack()));

		if (this.storageFrames === undefined) {
			// First call, from the base constructor. Also seed the base's own
			// `storageStack` with one empty Map and never touch it again: it stays
			// present (assertStackShape in src/revm-state-store.ts still passes) and
			// stays EMPTY, which is precisely the blast radius this prototype exists
			// to expose. See measurements.md.
			this.storageFrames = [frame(new Map())];
			this.storageStack.push(new Map());
			return;
		}
		this.storageFrames.push(frame(new Map(this.#top().map)));
	}

	async commit() {
		this.accountStack.splice(-2, 1);
		this.codeStack.splice(-2, 1);
		const frames = this.storageFrames;
		const top = frames[frames.length - 1];
		const below = frames[frames.length - 2];
		if (below === undefined) throw new Error('commit with no frame below');
		// Inherit ownership where it is provably safe. An inner map `below` cloned
		// was created after `below` was pushed, so no frame beneath it can hold a
		// reference; once `below` is spliced out, `top` is its only owner and may
		// mutate it in place. The identity check is what makes that provable:
		// without it we would be assuming, and a wrong `owned` entry is exactly the
		// silent cross-frame leak this class exists to avoid.
		for (const address of below.owned) {
			if (top.map.get(address) === below.map.get(address)) top.owned.add(address);
		}
		frames.splice(-2, 1);
	}

	async revert() {
		this.accountStack.pop();
		this.codeStack.pop();
		this.storageFrames.pop();
	}

	// --- storage ------------------------------------------------------------

	#top() {
		return this.storageFrames[this.storageFrames.length - 1];
	}

	/** The inner map for `address`, cloned first unless this frame already owns it. */
	#mutable(address) {
		const top = this.#top();
		let inner = top.map.get(address);
		if (inner === undefined) {
			inner = new Map();
		} else if (top.owned.has(address)) {
			return inner;
		} else {
			inner = new Map(inner); // COPY-ON-WRITE. Without this line, writes leak down.
		}
		top.map.set(address, inner);
		top.owned.add(address);
		return inner;
	}

	async getStorage(address, key) {
		return (
			this.#top().map.get(address.toString())?.get(bytesToHex(key)) ??
			new Uint8Array(0)
		);
	}

	async putStorage(address, key, value) {
		this.#mutable(address.toString()).set(bytesToHex(key), value);
	}

	/**
	 * O(1), against O(total slots) for the flat layout's prefix scan.
	 *
	 * Deleting from the TOP frame's outer map is revert-safe for the same reason
	 * the flat override is: the frame is a copy, so a clear inside a checkpoint
	 * that is reverted disappears with the frame. It does NOT need to own the
	 * inner map first, because it is dropping the reference rather than mutating
	 * through it.
	 */
	async clearStorage(address) {
		if (address === undefined) return; // same signature irritation as src/state-manager.ts
		this.#top().map.delete(address.toString());
	}

	shallowCopy() {
		const copy = new this.constructor({common: this.common});
		copy.accountStack = this.accountStack.map((m) => new Map(m));
		copy.codeStack = this.codeStack.map((m) => new Map(m));
		// Deep enough to be independent: inner maps are cloned rather than shared,
		// because the copy's frames are not this object's frames.
		copy.storageFrames = this.storageFrames.map((f) => {
			const map = new Map();
			for (const [a, inner] of f.map) map.set(a, new Map(inner));
			const copied = frame(map);
			for (const a of map.keys()) copied.owned.add(a);
			return copied;
		});
		return copy;
	}

	// --- test/probe support -------------------------------------------------

	/** A flat `{ 'addr_slot': '0x…' }` snapshot, for diffing against the flat layout. */
	dumpStorage() {
		const out = {};
		for (const [address, inner] of this.#top().map) {
			for (const [slot, value] of inner) out[`${address}_${slot}`] = bytesToHex(value);
		}
		return out;
	}
}

/**
 * THE CONTROL: the same layout with the copy-on-write removed, i.e. what
 * "just make it `Map<address, Map<slot, value>>`" produces if the checkpoint
 * contract is not thought about. Every inner map is shared with the frame below,
 * so a child frame's write is a parent frame's write.
 *
 * It exists so the correctness section has something that FAILS. A probe where
 * every implementation passes proves the probe is weak, not the code correct.
 */
export class NaivePerAccountStorageStateManager extends PerAccountStorageStateManager {
	#topFrame() {
		return this.storageFrames[this.storageFrames.length - 1];
	}
	async putStorage(address, key, value) {
		const a = address.toString();
		const top = this.#topFrame();
		let inner = top.map.get(a);
		if (inner === undefined) {
			inner = new Map();
			top.map.set(a, inner);
		}
		inner.set(bytesToHex(key), value); // no clone: mutates whatever frames share it
	}
}

/**
 * The flat layout as the node ships it today, re-exported under a name the
 * probes can put next to the prototype. This IS
 * `packages/embedded-eth-node/src/state-manager.ts`, imported from the built
 * package rather than copied, so the measurement cannot drift from the code.
 */
export {SimpleStateManagerWithClearStorage as FlatStorageStateManager} from './support.mjs';

/** A flat snapshot of a stock `SimpleStateManager`'s storage, same shape as `dumpStorage`. */
export function dumpFlatStorage(sm) {
	const out = {};
	const top = sm.storageStack[sm.storageStack.length - 1];
	for (const [key, value] of top) out[key] = bytesToHex(value);
	return out;
}
