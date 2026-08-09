/**
 * overlay-flat-storage.mjs: the THIRD shape, measured so the recommendation can
 * name what it is rejecting: keep the flat `${address}_${slot}` key exactly as
 * it is, and make a checkpoint a small WRITE-SET frame stacked over the state
 * instead of a full copy of it.
 *
 * This is the shape someone reaches for when the checkpoint cost is the finding
 * and re-layering feels like a big change: it is what a journal is, it is O(1)
 * to checkpoint, and it keeps the key format every other reader of the state
 * manager already knows. The probe measures it against the per-account layout
 * so the trade is on the table with numbers instead of intuition. What it does
 * NOT fix is `clearStorage`, and the probe shows where the cost reappears.
 *
 * SPIKE CODE, same status as `per-account-storage.mjs`.
 *
 * ## The read walks the stack
 *
 * A read checks each frame from the top down: the frame's own writes first, then
 * whether that frame CLEARED the account (which hides everything below it), then
 * the frame below. Reads therefore cost O(depth) rather than O(1), and depth is
 * the EVM's message-frame nesting, which is small but not one.
 *
 * ## Where `clearStorage` reappears
 *
 * A clear inside a frame is O(1): mark the account cleared, and drop that
 * frame's own writes for it. Committing that frame down is where it is paid:
 * the frame below may hold writes for the cleared account that must not survive,
 * so they have to be found, and when the frame below is the BASE frame, "find
 * them" is the same prefix scan over the whole state that the flat layout does
 * today. The cost moves; it does not go away, because the flat key is what makes
 * "this account's slots" unenumerable.
 */
import {SimpleStateManager, util} from './support.mjs';

const {bytesToHex} = util;

function overlayFrame() {
	return {
		/** flat `${address}_${slot}` -> value, for THIS frame only. */
		writes: new Map(),
		/** accounts cleared in this frame: everything below is hidden. */
		cleared: new Set(),
	};
}

export class OverlayFlatStateManager extends SimpleStateManager {
	/** See per-account-storage.mjs: no field declarations, the base ctor checkpoints. */
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
		if (this.overlays === undefined) {
			this.overlays = [overlayFrame()];
			this.storageStack.push(new Map()); // kept non-empty and empty, as in the CoW prototype
			return;
		}
		this.overlays.push(overlayFrame()); // O(1): no copy at all
	}

	async commit() {
		this.accountStack.splice(-2, 1);
		this.codeStack.splice(-2, 1);
		const top = this.overlays[this.overlays.length - 1];
		const below = this.overlays[this.overlays.length - 2];
		if (below === undefined) throw new Error('commit with no frame below');
		for (const address of top.cleared) {
			// THE SCAN, moved rather than removed. Over `below.writes`, which is the
			// WHOLE state when `below` is the base frame.
			const prefix = `${address}_`;
			for (const key of below.writes.keys()) {
				if (key.startsWith(prefix)) below.writes.delete(key);
			}
			below.cleared.add(address);
		}
		for (const [key, value] of top.writes) below.writes.set(key, value);
		this.overlays.splice(-1, 1);
	}

	async revert() {
		this.accountStack.pop();
		this.codeStack.pop();
		this.overlays.pop();
	}

	async getStorage(address, key) {
		const a = address.toString();
		const flat = `${a}_${bytesToHex(key)}`;
		for (let i = this.overlays.length - 1; i >= 0; i--) {
			const f = this.overlays[i];
			const hit = f.writes.get(flat);
			if (hit !== undefined) return hit;
			if (f.cleared.has(a)) return new Uint8Array(0);
		}
		return new Uint8Array(0);
	}

	async putStorage(address, key, value) {
		this.overlays[this.overlays.length - 1].writes.set(
			`${address.toString()}_${bytesToHex(key)}`,
			value,
		);
	}

	async clearStorage(address) {
		if (address === undefined) return;
		const a = address.toString();
		const top = this.overlays[this.overlays.length - 1];
		top.cleared.add(a);
		// This frame's own writes for the account must go too, or a write made
		// BEFORE the clear in the same frame would outlive it (the read checks
		// writes before `cleared`). O(this frame's writes), except in the base
		// frame where that is the whole state.
		const prefix = `${a}_`;
		for (const key of top.writes.keys()) {
			if (key.startsWith(prefix)) top.writes.delete(key);
		}
	}

	shallowCopy() {
		const copy = new this.constructor({common: this.common});
		copy.accountStack = this.accountStack.map((m) => new Map(m));
		copy.codeStack = this.codeStack.map((m) => new Map(m));
		copy.overlays = this.overlays.map((f) => ({
			writes: new Map(f.writes),
			cleared: new Set(f.cleared),
		}));
		return copy;
	}

	/** Flattened view, same shape as the other layouts' dumps. */
	dumpStorage() {
		const out = {};
		for (const f of this.overlays) {
			for (const address of f.cleared) {
				const prefix = `${address}_`;
				for (const key of Object.keys(out)) {
					if (key.startsWith(prefix)) delete out[key];
				}
			}
			for (const [key, value] of f.writes) out[key] = bytesToHex(value);
		}
		return out;
	}
}
