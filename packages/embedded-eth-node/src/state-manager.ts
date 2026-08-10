/**
 * state-manager.ts — the node's `stateMode:'none'` state manager.
 *
 * `@ethereumjs/statemanager@10.1.2`'s `SimpleStateManager` keeps storage in ONE
 * FLAT `Map` keyed `` `${address}_${slot}` ``, and `checkpointSync()` pushes a
 * full COPY of it. `@ethereumjs/evm` checkpoints once per MESSAGE FRAME, so every
 * transaction pays `frames + 1` copies of ALL of state, and `clearStorage` (which
 * the EVM calls on every contract creation) can only be a prefix scan of the whole
 * map. Measured end to end: four ordinary transactions cost 289 ms at 100,000
 * slots on that layout and 10 ms on this one, and one transaction at 10,000 slots
 * already ate between a third and nine tenths of a 16.6 ms frame budget through
 * the node's own public surface. All of it is in
 * `docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/measurements.md`.
 *
 * So this subclass re-layers storage. It is `Map<address, Map<slot, value>>`, and
 * a checkpoint pushes a **storage overlay** — one checkpoint's worth of CHANGE —
 * rather than copying anything:
 *
 * - `checkpointSync()` pushes an EMPTY overlay: O(1), whatever state holds.
 * - `putStorage` writes into the TOP overlay only.
 * - `getStorage` walks the overlay stack DOWNWARDS until it finds the slot, or an
 *   overlay that cleared the account (which hides every overlay below it).
 * - `commit()` merges the top overlay into the one below and pops it; `revert()`
 *   just pops it, so an uncommitted write was never anywhere else to begin with.
 * - `clearStorage(address)` is one `delete` plus one tombstone: O(that account).
 *
 * ONE WORD FOR THE CONCEPT: **overlay**. The spike that produced this design
 * called the same thing an overlay, a diff frame and a journal frame in different
 * places; "frame" already means an EVM message frame (and, in `CONTEXT.md`, the
 * 16.6 ms frame budget) and "journal" already means the one `@ethereumjs/evm`
 * keeps ABOVE the state manager, so neither is free. `overlay` is, and it is
 * defined in `CONTEXT.md`'s glossary. Use it in code, tests and commits.
 *
 * ## Copy-on-write is not enough, and the naive version fails SILENTLY
 *
 * The plausible wrong version of this is `new Map(outer)` per checkpoint: it
 * copies the outer map and SHARES every inner map, so a child frame's write
 * mutates the parent's map, survives a revert, and lands in committed state with
 * no error anywhere. `test/helpers/storage-overlay.ts` keeps that version as a
 * CONTROL and asserts it fails the same checks this class passes — a correctness
 * claim with nothing to fail against is not a claim. (Cloning the inner map on
 * first write fixes the leak but leaves the checkpoint O(accounts-with-storage),
 * which is the same O(total) when state is one slot per account, i.e. exactly
 * what per-player game state looks like. Hence overlays.)
 *
 * ## `storageStack` is GONE, and reading it THROWS
 *
 * The base class's `storageStack` is not maintained here, because it is the thing
 * being replaced. It is deliberately made unreadable rather than left present and
 * empty: with an empty stack still sitting there, three shipped readers answered
 * WRONG rather than throwing (the revm store reported "this slot is zero" for a
 * slot holding `0x2a`, `dumpState` dumped no storage at all, and the guard meant
 * to catch a shape change passed). Wrong-but-plausible is the failure this repo's
 * honest-edge convention exists to prevent, so any remaining reader now gets a
 * loud error naming the replacement instead of a believable zero.
 *
 * ## The field-initialiser trap, which will bite the next person
 *
 * `SimpleStateManager`'s CONSTRUCTOR calls `this.checkpointSync()`. A subclass
 * field declaration runs AFTER `super()` returns, so `storageOverlays = []` would
 * overwrite whatever that first checkpoint created. There is therefore NO field
 * declaration for it: it is created lazily inside the override.
 *
 * ## `clearStorage` is also an upstream-bug fix, and still is
 *
 * `SimpleStateManager` ships `clearStorage` as `async clearStorage() { }`: an
 * empty body taking NO parameter, while the `StateManagerInterface` it implements
 * declares `clearStorage(address)`. A zero-parameter method satisfies a
 * one-parameter interface member, so TypeScript never flagged it and the address
 * argument is silently dropped. `@ethereumjs/evm` calls it on EVERY contract
 * creation (`evm.js:555`) precisely to guarantee a fresh contract starts with
 * empty storage, so with the upstream no-op a contract created at an address that
 * already holds storage INHERITS it. Reported upstream; see
 * `docs/adr/0007-we-override-simplestatemanagers-no-op-clearstorage.md`.
 *
 * WHY AN OVERRIDE RATHER THAN A `pnpm patch`: a patch would fix only THIS repo's
 * own test runs. `embedded-eth-node` is a library, so a consumer resolves
 * `@ethereumjs/statemanager` themselves and would never see our patch. The fix
 * has to live in code we publish. That argument is even stronger for the layout,
 * which is a representation our own `dumpState` and revm store read directly.
 *
 * WHAT THIS DOES NOT FIX (and cannot, in this mode): the EIP-7610 collision guard
 * sitting just above that call rejects creation outright when the target account
 * has non-empty storage, and it reads `account.storageRoot`. `SimpleStateManager`
 * implements no state-root logic at all, so `storageRoot` never reflects its
 * storage and the guard cannot fire. `stateMode:'trie'` gets the correct,
 * spec-current behaviour from `MerkleStateManager` (creation fails with
 * `CREATE_COLLISION`); `stateMode:'none'` clears and proceeds, which is the
 * pre-EIP-7610 semantics and what the EVM's own call asks for. Both are far
 * better than silently inheriting; they are not identical to each other, and that
 * asymmetry is documented in the README's state-mode section.
 */
import {SimpleStateManager} from '@ethereumjs/statemanager';
import type {Address} from '@ethereumjs/util';
import {bytesToHex} from '@ethereumjs/util';

/** `address.toString()` — `0x`-prefixed lowercase hex. */
export type AddressKey = string;
/** `bytesToHex(slot)` — `0x`-prefixed lowercase hex, exactly as upstream keys it. */
export type SlotKey = string;

/**
 * ONE CHECKPOINT'S WORTH OF STORAGE CHANGE: the slots written since that
 * checkpoint, plus the accounts cleared in it.
 *
 * `written` holds ONLY what this overlay touched, which is what makes a
 * checkpoint O(1): nothing is copied forward. `cleared` is the tombstone half —
 * an account in it reads as EMPTY through this overlay, hiding every overlay
 * below, which is what makes `clearStorage` O(that account) rather than a scan.
 * Both are needed: without `cleared`, a clear could only be expressed by copying
 * the account's slots forward as zeroes, which is the cost being removed.
 */
export interface StorageOverlay {
	/** address key -> (slot key -> value) written IN THIS overlay. */
	readonly written: Map<AddressKey, Map<SlotKey, Uint8Array>>;
	/** Accounts cleared in this overlay: every overlay below it is hidden for them. */
	readonly cleared: Set<AddressKey>;
}

function emptyOverlay(): StorageOverlay {
	return {written: new Map(), cleared: new Set()};
}

const STORAGE_STACK_IS_GONE =
	"embedded-eth-node: SimpleStateManager's flat `storageStack` is not maintained " +
	"by this node. `stateMode:'none'` storage is per-account with per-checkpoint " +
	'OVERLAYS — read it through `storageAt(addressKey, slotKey)` (one slot, ' +
	'synchronously), `liveStorage()` (every live slot, grouped by account) or the ' +
	'async `getStorage(address, key)`. This throws on purpose: an empty ' +
	'`storageStack` left in place answers "that slot is zero" for a slot that ' +
	'holds a value, and a plausible wrong answer is worse than an error. See ' +
	'src/state-manager.ts.';

export class OverlayStorageStateManager extends SimpleStateManager {
	/**
	 * The overlay stack, bottom (committed state) to top (the innermost open
	 * checkpoint). Always non-empty: the base constructor's `checkpointSync()`
	 * seeds it.
	 *
	 * Public for the same reason `accountStack` and `codeStack` are: the revm store
	 * reads AND WRITES state SYNCHRONOUSLY and `StateManagerInterface` is async
	 * throughout (ADR 0005). Prefer {@link storageAt} / {@link liveStorage} /
	 * {@link setStorageAt} / {@link clearStorageAt} over walking this by hand.
	 *
	 * NO INITIALISER — see the header's field-initialiser trap.
	 */
	declare storageOverlays: StorageOverlay[];

	constructor(opts?: ConstructorParameters<typeof SimpleStateManager>[0]) {
		super(opts);
		// The base constructor assigned `this.storageStack = []`. Replace that own
		// property with a throwing accessor, so a reader that has not been migrated
		// fails loudly here instead of reporting an empty storage map as truth. The
		// setter swallows writes rather than throwing, because the base class also
		// assigns to it and a constructor that throws is not the honest edge — a
		// READ is where a wrong answer would escape.
		Object.defineProperty(this, 'storageStack', {
			configurable: true,
			get(): never {
				throw new Error(STORAGE_STACK_IS_GONE);
			},
			set(): void {},
		});
	}

	// --- the checkpoint contract --------------------------------------------

	/**
	 * Push a frame. Accounts and code exactly as upstream (they are not what this
	 * class re-layers, and copying them byte-for-byte keeps the diff honest);
	 * storage pushes an EMPTY overlay, which copies nothing at any state size.
	 */
	protected override checkpointSync(): void {
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
		// First call comes from the BASE constructor, before any subclass field
		// could have run. `as ... | undefined` because the declared type says it is
		// always there, and at this one instant it is not.
		const overlays = this.storageOverlays as StorageOverlay[] | undefined;
		if (overlays === undefined) {
			this.storageOverlays = [emptyOverlay()];
			return;
		}
		overlays.push(emptyOverlay());
	}

	/**
	 * Merge the top overlay into the one below and drop it.
	 *
	 * The clear is merged FIRST and in O(1) per account: dropping the account from
	 * the overlay below and re-tombstoning it there hides everything deeper,
	 * without touching a single slot. Then the writes land on top of that, so a
	 * clear-then-write inside one frame commits as "only the new slots".
	 */
	override async commit(): Promise<void> {
		this.accountStack.splice(-2, 1);
		this.codeStack.splice(-2, 1);
		const overlays = this.storageOverlays;
		const top = overlays[overlays.length - 1];
		const below = overlays[overlays.length - 2];
		if (top === undefined || below === undefined) {
			throw new Error(
				'embedded-eth-node: commit() with no open storage checkpoint below the ' +
					'top one. Every commit must be preceded by a checkpoint.',
			);
		}
		for (const address of top.cleared) {
			below.written.delete(address);
			below.cleared.add(address);
		}
		for (const [address, inner] of top.written) {
			const target = below.written.get(address);
			// `inner` was created by `top`, which is about to disappear, so no overlay
			// below can be holding a reference to it: handing the object over is safe
			// and O(1). This is the one place ownership moves, and it is why nothing
			// here needs copy-on-write bookkeeping.
			if (target === undefined) below.written.set(address, inner);
			else for (const [slot, value] of inner) target.set(slot, value);
		}
		overlays.pop();
	}

	/** Drop the top overlay. Everything written since the checkpoint goes with it. */
	override async revert(): Promise<void> {
		this.accountStack.pop();
		this.codeStack.pop();
		this.storageOverlays.pop();
	}

	// --- storage -------------------------------------------------------------

	private topOverlay(): StorageOverlay {
		const overlays = this.storageOverlays;
		const top = overlays[overlays.length - 1];
		if (top === undefined) {
			throw new Error(
				'embedded-eth-node: the storage overlay stack is empty, so there is no ' +
					'state to read or write. More reverts than checkpoints.',
			);
		}
		return top;
	}

	/**
	 * Read one slot SYNCHRONOUSLY, by key, walking the overlay stack downwards.
	 *
	 * `undefined` means "no overlay holds this slot", i.e. zero. A zero-LENGTH
	 * `Uint8Array` is different: it means an overlay explicitly stored the empty
	 * value (the interpreter strips leading zeros before `putStorage`, so a slot
	 * zeroed by `SSTORE` is stored as empty rather than deleted) and it must stop
	 * the walk, or a cleared slot would read through to a stale value below.
	 *
	 * The stack walk is the cost this layout ADDS, and it is two map lookups per
	 * open checkpoint. Measured against frame depths 1/2/4/8 it is not
	 * distinguishable from the flat map's single lookup; see the spike.
	 */
	storageAt(addressKey: AddressKey, slotKey: SlotKey): Uint8Array | undefined {
		const overlays = this.storageOverlays;
		for (let i = overlays.length - 1; i >= 0; i--) {
			const overlay = overlays[i];
			const hit = overlay.written.get(addressKey)?.get(slotKey);
			if (hit !== undefined) return hit;
			if (overlay.cleared.has(addressKey)) return undefined;
		}
		return undefined;
	}

	/**
	 * Write one slot SYNCHRONOUSLY, by key, into the TOP overlay — the write-side
	 * twin of {@link storageAt}, and for the same reason it exists: revm's commit
	 * runs inside a synchronous wasm callback and every method on
	 * `StateManagerInterface` returns a `Promise` (ADR 0005). `putStorage` below is
	 * this function plus an `Address`.
	 *
	 * THE VALUE MUST ALREADY BE IN SHORTEST FORM, because that is what this
	 * representation holds and what `dumpState` serialises: `@ethereumjs/evm`
	 * strips leading zeros before `putStorage` (a zeroed slot arrives as a
	 * ZERO-LENGTH array, which {@link storageAt} treats as "explicitly empty" and
	 * stops the walk at). A caller handing over 32 padded bytes would write state
	 * that reads back correctly and dumps differently from the same state written
	 * by the default engine.
	 */
	setStorageAt(
		addressKey: AddressKey,
		slotKey: SlotKey,
		value: Uint8Array,
	): void {
		const top = this.topOverlay();
		let inner = top.written.get(addressKey);
		if (inner === undefined) {
			inner = new Map();
			top.written.set(addressKey, inner);
		}
		inner.set(slotKey, value);
	}

	/**
	 * Clear one account's storage SYNCHRONOUSLY, by key — {@link clearStorage}
	 * without an `Address`, for the same synchronous-callback reason as
	 * {@link setStorageAt}. Still O(1): one `delete` plus one tombstone.
	 */
	clearStorageAt(addressKey: AddressKey): void {
		const top = this.topOverlay();
		top.written.delete(addressKey);
		top.cleared.add(addressKey);
	}

	override async getStorage(
		address: Address,
		key: Uint8Array,
	): Promise<Uint8Array> {
		return (
			this.storageAt(address.toString(), bytesToHex(key)) ?? new Uint8Array(0)
		);
	}

	override async putStorage(
		address: Address,
		key: Uint8Array,
		value: Uint8Array,
	): Promise<void> {
		this.setStorageAt(address.toString(), bytesToHex(key), value);
	}

	/**
	 * Delete every storage slot belonging to `address`. O(THAT ACCOUNT) — in fact
	 * O(1): drop this overlay's own writes for it and tombstone it, which hides
	 * every overlay below. The flat layout could only prefix-scan the whole map,
	 * 14 ms at 100,000 slots, on every contract creation.
	 *
	 * Revert-safe by construction: both effects live in the TOP overlay, so a
	 * clear inside a checkpoint that is later reverted disappears with it.
	 *
	 * The parameter is OPTIONAL for an irritating reason that is itself a symptom
	 * of the upstream bug: the base class declares `clearStorage()` with ZERO
	 * parameters, and TypeScript refuses an override that ADDS a required one
	 * (TS2416). Callers reaching us through `StateManagerInterface` always pass an
	 * address, because THAT declares `clearStorage(address)`. A no-argument call
	 * keeps the base's do-nothing behaviour rather than guessing which account was
	 * meant.
	 */
	override async clearStorage(address?: Address): Promise<void> {
		if (address === undefined) return;
		this.clearStorageAt(address.toString());
	}

	/**
	 * Every live storage slot, grouped by account, flattened across the whole
	 * overlay stack — the view `dumpState` serialises.
	 *
	 * Bottom-up, applying each overlay's clears before its writes, so the result is
	 * what {@link storageAt} would answer for every key. Iteration order is
	 * insertion order (accounts in first-write order, slots likewise), which is the
	 * order the flat map produced, so the serialised `dumpState` output is
	 * byte-identical to the pre-overlay node's for the same state.
	 *
	 * O(live slots) and allocating, so it is a dump/persist operation, not a read
	 * path. Read one slot with {@link storageAt}.
	 */
	liveStorage(): Map<AddressKey, Map<SlotKey, Uint8Array>> {
		const out = new Map<AddressKey, Map<SlotKey, Uint8Array>>();
		for (const overlay of this.storageOverlays) {
			for (const address of overlay.cleared) out.delete(address);
			for (const [address, inner] of overlay.written) {
				let target = out.get(address);
				if (target === undefined) {
					target = new Map();
					out.set(address, target);
				}
				for (const [slot, value] of inner) target.set(slot, value);
			}
		}
		return out;
	}

	/**
	 * An INDEPENDENT copy. Overlays are cloned two levels deep (the stack, each
	 * overlay's outer map and each inner map), because the copy's overlays are not
	 * this object's: sharing an inner map would let a write on the copy land in
	 * this manager's committed state.
	 */
	override shallowCopy(): OverlayStorageStateManager {
		const copy = new OverlayStorageStateManager({common: this.common});
		copy.accountStack = this.accountStack.map((m) => new Map(m));
		copy.codeStack = this.codeStack.map((m) => new Map(m));
		copy.storageOverlays = this.storageOverlays.map((overlay) => {
			const written = new Map<AddressKey, Map<SlotKey, Uint8Array>>();
			for (const [address, inner] of overlay.written)
				written.set(address, new Map(inner));
			return {written, cleared: new Set(overlay.cleared)};
		});
		return copy;
	}
}
