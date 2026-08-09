/**
 * per-account-overlay-storage.mjs: the FOURTH shape, and the one the numbers
 * pointed at rather than the one the task proposed: per-account storage
 * (`Map<address, Map<slot, value>>`) where a checkpoint copies NOTHING at all
 * and each frame holds only what it touched.
 *
 * It exists because the first three measurements each left something on the
 * table:
 *
 * - flat + full copy (shipped): checkpoint O(total slots), clear O(total slots).
 * - per-account + copy-on-write: clear O(1), checkpoint O(accounts), which is
 *   still O(total) when state is one slot per account, and that is exactly the
 *   shape a game's per-player storage tends towards.
 * - flat + overlay: checkpoint O(1), but the clear only MOVES, because a flat
 *   key makes "this account's slots" unenumerable, so committing a clear into
 *   the base frame is the same whole-state prefix scan.
 *
 * Combining the two ideas removes both terms: the frame is a per-account diff,
 * so a checkpoint copies nothing, a clear is a `delete` plus a tombstone, and
 * committing a clear into the base frame is one `delete` on the outer map.
 *
 * The cost it ADDS is a read that walks the frame stack (two map lookups per
 * frame instead of one), and the EVM's frame depth is the multiplier. The probe
 * measures that rather than waving at it.
 *
 * This is, not coincidentally, the shape of a journal, which is what
 * `@ethereumjs/evm` already keeps ABOVE the state manager, and what revm keeps
 * inside wasm. That is an argument for putting it upstream, not an argument that
 * it is exotic.
 *
 * SPIKE CODE, same status as its siblings.
 */
import {SimpleStateManager, util} from './support.mjs';

const {bytesToHex} = util;

function diffFrame() {
	return {
		/** address key -> (slot hex -> value) written IN THIS FRAME. */
		accounts: new Map(),
		/** accounts cleared in this frame: every frame below is hidden. */
		cleared: new Set(),
	};
}

export class PerAccountOverlayStateManager extends SimpleStateManager {
	/** See per-account-storage.mjs for why there is no field declaration here. */
	checkpointSync() {
		const newTopA = new Map(this.topAccountStack());
		for (const [address, account] of newTopA) {
			newTopA.set(
				address,
				account !== undefined
					? Object.assign(Object.create(Object.getPrototypeOf(account)), account)
					: undefined,
			);
		}
		this.accountStack.push(newTopA);
		this.codeStack.push(new Map(this.topCodeStack()));
		if (this.diffs === undefined) {
			this.diffs = [diffFrame()];
			this.storageStack.push(new Map()); // kept non-empty and empty; see measurements.md
			return;
		}
		this.diffs.push(diffFrame()); // O(1), whatever the state size
	}

	async commit() {
		this.accountStack.splice(-2, 1);
		this.codeStack.splice(-2, 1);
		const top = this.diffs[this.diffs.length - 1];
		const below = this.diffs[this.diffs.length - 2];
		if (below === undefined) throw new Error('commit with no frame below');
		// The clear, merged down in O(1) per account. This is the whole point of
		// keeping the per-account grouping AND the diff frame.
		for (const address of top.cleared) {
			below.accounts.delete(address);
			below.cleared.add(address);
		}
		for (const [address, inner] of top.accounts) {
			const target = below.accounts.get(address);
			if (target === undefined) {
				// `inner` was created by `top`, which is about to disappear, so no frame
				// below can be holding it: handing over the object is safe and O(1).
				below.accounts.set(address, inner);
			} else {
				for (const [slot, value] of inner) target.set(slot, value);
			}
		}
		this.diffs.splice(-1, 1);
	}

	async revert() {
		this.accountStack.pop();
		this.codeStack.pop();
		this.diffs.pop();
	}

	async getStorage(address, key) {
		const a = address.toString();
		const slot = bytesToHex(key);
		for (let i = this.diffs.length - 1; i >= 0; i--) {
			const f = this.diffs[i];
			const hit = f.accounts.get(a)?.get(slot);
			if (hit !== undefined) return hit;
			if (f.cleared.has(a)) return new Uint8Array(0);
		}
		return new Uint8Array(0);
	}

	async putStorage(address, key, value) {
		const a = address.toString();
		const top = this.diffs[this.diffs.length - 1];
		let inner = top.accounts.get(a);
		if (inner === undefined) {
			inner = new Map();
			top.accounts.set(a, inner);
		}
		inner.set(bytesToHex(key), value);
	}

	async clearStorage(address) {
		if (address === undefined) return;
		const a = address.toString();
		const top = this.diffs[this.diffs.length - 1];
		top.accounts.delete(a); // this frame's own writes for it go too
		top.cleared.add(a);
	}

	shallowCopy() {
		const copy = new this.constructor({common: this.common});
		copy.accountStack = this.accountStack.map((m) => new Map(m));
		copy.codeStack = this.codeStack.map((m) => new Map(m));
		copy.diffs = this.diffs.map((f) => {
			const accounts = new Map();
			for (const [a, inner] of f.accounts) accounts.set(a, new Map(inner));
			return {accounts, cleared: new Set(f.cleared)};
		});
		return copy;
	}

	/** Flattened view, same shape as the other layouts' dumps. */
	dumpStorage() {
		const out = {};
		for (const f of this.diffs) {
			for (const address of f.cleared) {
				const prefix = `${address}_`;
				for (const key of Object.keys(out)) {
					if (key.startsWith(prefix)) delete out[key];
				}
			}
			for (const [address, inner] of f.accounts) {
				for (const [slot, value] of inner) out[`${address}_${slot}`] = bytesToHex(value);
			}
		}
		return out;
	}
}
