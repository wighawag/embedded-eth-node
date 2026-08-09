/**
 * storage-overlay.spec.ts — the node's `stateMode:'none'` storage is per-account
 * with a per-checkpoint OVERLAY, and this is the bar that says it is CORRECT
 * before anything says it is fast.
 *
 * Storage used to be `SimpleStateManager`'s one flat `${address}_${slot}` map,
 * copied whole by every checkpoint — and `@ethereumjs/evm` checkpoints once per
 * MESSAGE FRAME, so every transaction paid `frames + 1` copies of ALL of state
 * (289 ms for four ordinary transactions at 100,000 slots, against 10 ms; see
 * `docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/measurements.md`).
 *
 * Every assertion here is one that FAILS against the plausible wrong version of
 * the change — a per-account layout whose checkpoint shallow-copies the outer map
 * and shares the inner ones, so a reverted write silently survives. That control
 * is run through the identical checks, and the suite asserts it FAILS them; if it
 * ever passes, these checks have stopped meaning anything.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('storage overlays: checkpoint/commit/revert semantics, the readers, and the serialised format', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'storage-overlay'}});

	console.log('\n[storage-overlay] errors:', r.errors);
	const c = r.results.storageOverlay as Record<string, any>;
	console.log('[storage-overlay]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	// ---- 1. checkpoint / commit / revert semantics ----
	// The shipped layout passes all six...
	expect(c.semanticsFailedByOverlayLayout).toEqual([]);
	// ...and the naive shared-inner-map control FAILS them, which is what makes
	// the six worth asserting. The COUNT is not pinned (that would be a claim
	// about the control, not about us); "more than none" is the property.
	expect(c.semanticsFailedByNaiveControl.length).toBeGreaterThan(0);

	// ---- 2. the randomised differential against the layout the node shipped ----
	// 20,000 mixed operations, every read compared and a full storage snapshot
	// every 500. Answering IDENTICALLY is the claim; being faster is not asserted
	// here at all.
	expect(c.fuzzOverlayMatchesFlat).toBe(true);
	expect(c.fuzzNaiveDivergesFromFlat).toBe(true);
	expect(c.fuzzTraceLength).toBeGreaterThan(1000); // the trace is not empty

	// ---- 3. the two structural claims the whole change is for ----
	expect(c.checkpointPushesEmptyOverlay).toBe(true); // a checkpoint copies NO storage
	expect(c.readsThroughEmptyOverlay).toBe(true);
	expect(c.clearIsOneTombstone).toBe(true); // clearStorage is O(that account)
	expect(c.clearLeavesNeighbourAlone).toBe(true);
	expect(c.clearRevertRestoresAccount).toBe(true);

	// ---- 4. the three readers that answered WRONG rather than throwing ----
	// The guard now constrains the REPRESENTATION: it accepts the node's manager
	// and refuses a flat one, which is exactly the change it slept through before.
	expect(c.shapeGuardAcceptsOverlayManager).toBe('accepted');
	expect(c.shapeGuardRefusesFlatManager).toContain('storageAt()');
	// The revm read store returns the VALUE for a slot holding 0x2a. It used to
	// return undefined here — "this slot is zero" — with no throw and no warning.
	expect(c.revmStoreReadsTheSlot).toBe(
		'0x000000000000000000000000000000000000000000000000000000000000002a',
	);
	expect(c.revmStoreReadsZeroSlotAsUndefined).toBe(true);
	// And the retired flat stack is not readable at all: a reader that has not
	// been migrated gets a loud error naming the replacement, never an empty map
	// it would then serialise as truth.
	expect(c.readingRetiredStorageStack).toContain(
		'storageAt(addressKey, slotKey)',
	);

	// ---- 5. dumpState is PERSISTED DATA: the format did not move with the layout
	// Byte-identical accounts/code/storage against a dump captured from the
	// pre-overlay build, and that same dump loads into the new one.
	expect(c.dumpStateStorage).toBe(c.fixtureStorage);
	expect(c.dumpStateByteIdenticalToFlatLayout).toBe(true);
	expect(c.loadedWriterSlot0).toBe(
		'0x0000000000000000000000000000000000000000000000000000000000000001',
	);
	expect(c.loadedWriterSlot9).toBe(
		'0x0000000000000000000000000000000000000000000000000000000000000099',
	);
	expect(c.loadedCheatedSlot7).toBe(
		'0x000000000000000000000000000000000000000000000000000000000000002a',
	);
	expect(c.loadedSenderBalance).not.toBe('0x0');
	expect(c.loadedReloadedDumpMatches).toBe(true);

	// ---- 6. end to end through the node's own surface ----
	expect(c.revertedTxWroteNothing).toBe(
		'0x0000000000000000000000000000000000000000000000000000000000000000',
	);

	await h.dispose();
});
