/**
 * state-manager.ts — the node's `stateMode:'none'` state manager.
 *
 * `@ethereumjs/statemanager@10.1.2`'s `SimpleStateManager` ships `clearStorage`
 * as `async clearStorage() { }`: an empty body that takes NO parameter, while the
 * `StateManagerInterface` it implements declares `clearStorage(address)`. A
 * zero-parameter method satisfies a one-parameter interface member, so TypeScript
 * never flagged it and the address argument is silently dropped.
 *
 * `@ethereumjs/evm` calls it on EVERY contract creation (`evm.js:555`, right
 * after `journal.putAccount`) precisely to guarantee a fresh contract starts with
 * empty storage. With the upstream no-op, a contract created at an address that
 * already holds storage INHERITS it: seed slot 0 via `evm_setStorageAt`, deploy a
 * Counter that lands on that address, and `number()` returns the seeded value
 * instead of 0. Nothing errors, and every value looks plausible.
 *
 * So we override it. Reported upstream with a reproduction and a patch; this
 * override is what protects consumers in the meantime.
 *
 * WHY AN OVERRIDE RATHER THAN A `pnpm patch`: a patch would fix only THIS repo's
 * own test runs. `embedded-eth-node` is a library, so a consumer resolves
 * `@ethereumjs/statemanager` themselves and would never see our patch. The fix
 * has to live in code we publish.
 *
 * WHAT THIS DOES NOT FIX (and cannot, in this mode): the EIP-7610 collision guard
 * sitting just above that call rejects creation outright when the target account
 * has non-empty storage, and it reads `account.storageRoot`. `SimpleStateManager`
 * implements no state-root logic at all, so `storageRoot` never reflects its flat
 * storage map and the guard cannot fire. `stateMode:'trie'` gets the correct,
 * spec-current behaviour from `MerkleStateManager` (creation fails with
 * `CREATE_COLLISION`); `stateMode:'none'` clears and proceeds, which is the
 * pre-EIP-7610 semantics and what the EVM's own call asks for. Both are far
 * better than silently inheriting; they are not identical to each other, and that
 * asymmetry is documented in the README's state-mode section.
 */
import {SimpleStateManager} from '@ethereumjs/statemanager';
import type {Address} from '@ethereumjs/util';

export class SimpleStateManagerWithClearStorage extends SimpleStateManager {
	/**
	 * Delete every storage slot belonging to `address`, honouring the checkpoint
	 * stack.
	 *
	 * Deletes from the TOP frame only, which is what makes it revert-safe:
	 * `checkpointSync()` pushes a full COPY of the storage map, so a clear inside
	 * a checkpoint that is later reverted disappears with the frame, and one that
	 * is committed survives because `commit()` splices the frame below away.
	 *
	 * O(total storage), because `SimpleStateManager` keys storage in ONE flat map
	 * as `${address}_${slot}` and there is no per-account index to consult. That is
	 * acceptable here (a create or SELFDESTRUCT is rare next to a read) but it is
	 * the same flat-layout cost noted in
	 * `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md`,
	 * and a per-account layout would make both this and revm's `clearStorage`
	 * O(that account).
	 * The parameter is OPTIONAL for a irritating reason that is itself a symptom of
	 * the bug: the base class declares `clearStorage()` with ZERO parameters, and
	 * TypeScript refuses an override that ADDS a required one (TS2416, not
	 * assignable to the base type). Callers reaching us through
	 * `StateManagerInterface` always pass an address, because THAT declares
	 * `clearStorage(address)`. A no-argument call keeps the base's do-nothing
	 * behaviour rather than guessing which account was meant.
	 */
	override async clearStorage(address?: Address): Promise<void> {
		if (address === undefined) return;
		const top = this.topStorageStack();
		const prefix = `${address.toString()}_`;
		for (const key of top.keys()) {
			if (key.startsWith(prefix)) top.delete(key);
		}
	}
}
