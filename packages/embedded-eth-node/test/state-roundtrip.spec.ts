/**
 * state-roundtrip.spec.ts — the `evm_set*` cheats and the `dumpState` /
 * `loadState` round trip ACROSS A TRANSACTION BOUNDARY, on the default
 * `@ethereumjs/evm` engine.
 *
 * The suite is helpers/state-roundtrip.ts, and `revm-state-roundtrip.spec.ts`
 * runs the SAME one on `embedded-eth-node/revm` against the SAME literals
 * (./state-roundtrip-expected.ts). This half is not a formality: without it the
 * revm half would prove only that revm agrees with itself, and the pair is what
 * makes "adopting revm costs a consumer nothing they already had" measurable.
 *
 * WHAT IT CATCHES that no single-transaction assertion can: anything CACHING STATE
 * ACROSS A TRANSACTION. A cheat applied between two transactions and a dump taken
 * after one are the only two moments where a remembered account or slot diverges
 * from the node's own state, and both fail silently — with success receipts — when
 * they diverge.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {STATE_ROUND_TRIP} from './state-roundtrip-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('cheats cross a transaction boundary and a dump reloads and keeps behaving (default engine)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'state-roundtrip'}});

	console.log('\n[state-roundtrip] errors:', r.errors);
	const c = r.results.stateRoundTrip as Record<string, any>;
	console.log('[state-roundtrip]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);
	expect(c.engineId).toBe('@ethereumjs/evm');
	// Nothing was injected, so there is no seam out here to count at: the node
	// builds its own default engine inside `createNode()`. The revm half counts.
	expect(c.transactionsByEngine).toBe(null);

	// Everything the two round trips compared agreed.
	expect(c.mismatches).toEqual([]);

	// (1) THE CHEATS, applied between two transactions and observed by EXECUTION.
	expect(c.cheats.numberAfterFirstTx).toBe(STATE_ROUND_TRIP.numberAfterFirstTx);
	expect(c.cheats.counterSlot0AfterCheat).toBe(
		STATE_ROUND_TRIP.counterSlot0AfterCheat,
	);
	expect(c.cheats.numberAfterSecondTx).toBe(
		STATE_ROUND_TRIP.numberAfterSecondTx,
	);
	expect(c.cheats.secondTxStatus).toBe(STATE_ROUND_TRIP.secondTxStatus);
	expect(c.cheats.secondTxNonce).toBe(STATE_ROUND_TRIP.secondTxNonce);
	expect(c.cheats.cheatSenderNonceAfter).toBe(
		STATE_ROUND_TRIP.cheatSenderNonceAfter,
	);
	expect(c.cheats.cheatSenderBalanceBefore).toBe(
		STATE_ROUND_TRIP.cheatSenderBalanceBefore,
	);
	expect(c.cheats.cheatSenderChargedExactly).toBe(true);
	expect(c.cheats.cheatedCodeSlot7Before).toBe(
		STATE_ROUND_TRIP.cheatedCodeSlot7Before,
	);
	expect(c.cheats.cheatedCodeSlot7After).toBe(
		STATE_ROUND_TRIP.cheatedCodeSlot7After,
	);
	expect(c.cheats.thirdTxStatus).toBe(STATE_ROUND_TRIP.thirdTxStatus);

	// (2) THE DUMP taken AFTER a transaction, reloaded into a fresh node.
	expect(c.reload.reloadedEngineId).toBe('@ethereumjs/evm');
	expect(c.reload.dumpStructurallyEqualAfterLoad).toBe(true);
	expect(c.reload.readingsEqualAfterLoad).toBe(true);
	expect(c.reload.blockNumberReloaded).toBe(c.reload.blockNumberOrigin);
	// ...and it KEEPS BEHAVING: the same signed transaction produces the same
	// receipt and the same post-state on both nodes.
	expect(c.reload.followOnReceiptsEqual).toBe(true);
	expect(c.reload.dumpStructurallyEqualAfterFollowOn).toBe(true);
	expect(c.reload.numberAfterFollowOnOrigin).toBe(
		STATE_ROUND_TRIP.numberAfterFollowOn,
	);
	expect(c.reload.numberAfterFollowOnReloaded).toBe(
		STATE_ROUND_TRIP.numberAfterFollowOn,
	);

	await h.dispose();
});
