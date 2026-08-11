/**
 * revm-state-roundtrip.spec.ts — the `evm_set*` cheats and the `dumpState` /
 * `loadState` round trip ACROSS A TRANSACTION BOUNDARY, with the
 * `embedded-eth-node/revm` engine installed.
 *
 * The suite is the one `state-roundtrip.spec.ts` runs (helpers/state-roundtrip.ts)
 * and the expectations are the same literals (./state-roundtrip-expected.ts). What
 * changes is which EVM executed the transactions.
 *
 * WHY THIS FILE EXISTS. State never left the node: revm reads and writes it through
 * host callbacks and holds nothing across a transaction (ADR 0010), which is what
 * makes the node's own features — the cheats, `dumpState`, `loadState`, IndexedDB
 * persistence — cost nothing to keep. Every OTHER differential in this repo runs
 * within a single transaction and would pass unchanged for an engine that cached
 * state between them. The two round trips here are the ones that would not: a cheat
 * applied BETWEEN two revm transactions, and a dump taken AFTER one. Neither throws
 * when it goes wrong; both return success receipts and plausible numbers.
 *
 * Its OWN cut (helpers/cut-revm.ts), because that bundle carries the revm `.wasm`
 * and the shared cut must keep costing the other specs nothing.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {STATE_ROUND_TRIP} from './state-roundtrip-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('cheats cross a transaction boundary and a dump reloads and keeps behaving (revm)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The bundler-resolved wasm delivery shape, as in `revm-conformance.spec.ts`.
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'state-roundtrip'}});

	console.log('\n[revm-state-roundtrip] errors:', r.errors);
	const c = r.results.revmStateRoundTrip as Record<string, any>;
	console.log('[revm-state-roundtrip]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// The suite really ran ON REVM, on BOTH nodes, and the transactions really went
	// through the seam — counted at it, because a suite whose transactions had gone
	// back to `@ethereumjs/vm` would pass every assertion below while measuring
	// nothing.
	expect(c.engineId).toBe('revm-wasm');
	expect(c.reload.reloadedEngineId).toBe('revm-wasm');
	expect(Object.keys(c.transactionsByEngine)).toEqual(['revm-wasm']);
	// deploy + 3 cheat-observing txs on the original node, + the follow-on on each.
	expect(c.transactionsByEngine['revm-wasm']).toBe(6);

	// Everything the two round trips compared agreed.
	expect(c.mismatches).toEqual([]);

	// (1) THE CHEATS, applied between two REVM transactions and observed by
	// EXECUTION: the cheated nonce the second transaction was accepted at, the
	// cheated balance it was paid from, the cheated slot it incremented, and the
	// cheated CODE the third one called. An engine caching state across a
	// transaction reports 2 for `numberAfterSecondTx` and 0 for
	// `cheatedCodeSlot7After`, with success receipts and nothing thrown.
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

	// (2) THE DUMP taken AFTER a revm transaction, reloaded into a fresh node: same
	// accounts, same code, same slots, same values (compared STRUCTURALLY — key
	// order follows write order and is not part of the state), same block height,
	// same readings.
	expect(c.reload.dumpStructurallyEqualAfterLoad).toBe(true);
	expect(c.reload.readingsEqualAfterLoad).toBe(true);
	expect(c.reload.blockNumberReloaded).toBe(c.reload.blockNumberOrigin);
	// ...and the reloaded node KEEPS BEHAVING: the same signed transaction produces
	// the same receipt and the same post-state as on the original. This is the round
	// trip a persisted browser session performs on every reload.
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
