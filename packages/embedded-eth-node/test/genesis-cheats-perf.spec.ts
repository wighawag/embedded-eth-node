/**
 * genesis-cheats-perf.spec.ts — in real Chromium:
 *  1. custom genesis via `initialState` (funded EOAs + a pre-deployed contract
 *     with seeded storage) is visible to a viem client immediately;
 *  2. runtime `evm_set*` cheats round-trip in BOTH state modes;
 *  3. measure + report the trie-vs-none perf delta (the price of a real
 *     Merkle-Patricia root).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('custom genesis + runtime cheats + trie-vs-none perf', async ({page}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'genesis-cheats-perf'}});

	console.log('\n[gcp] errors:', r.errors);
	const s = r.results.genesisCheatsPerf as any;
	console.log('[gcp] customGenesis:', JSON.stringify(s.customGenesis, null, 2));
	console.log('[gcp] cheats:', JSON.stringify(s.cheats, null, 2));
	console.log('[gcp] perf (trie vs none):', JSON.stringify(s.perf, null, 2));

	expect(r.errors).toEqual([]);

	// (1) custom genesis
	expect(s.customGenesis.eoaBalance).toBe((1234n * 10n ** 18n).toString());
	expect(s.customGenesis.eoaNonce).toBe('7');
	expect(s.customGenesis.preDeployedCodePresent).toBe(true);
	expect(s.customGenesis.preDeployedNumber).toBe('41'); // seeded storage slot 0
	expect(s.customGenesis.numberAfterIncrement).toBe('42'); // increment() worked

	// (2) runtime cheats, both modes
	for (const mode of ['none', 'trie'] as const) {
		const c = s.cheats[mode];
		expect(c.balance).toBe((5n * 10n ** 18n).toString());
		expect(c.nonce).toBe('42');
		expect(c.code).toBe('0x60016002');
		expect(c.storageSlot7).toBe('99');
	}

	// (3) perf: both produce correct outputs; trie has a real root, none throws.
	expect(s.perf.none.getRootThrows).toBe(true);
	expect(s.perf.trie.rootIsReal).toBe(true);
	// Sanity bounds: timings are positive and trie is NOT faster than none.
	expect(s.perf.none.avgCallMs).toBeGreaterThan(0);
	expect(s.perf.trie.avgCallMs).toBeGreaterThan(0);
	expect(s.perf.callSlowdownX).toBeGreaterThanOrEqual(1);
	console.log(
		`[gcp] trie is ~${s.perf.callSlowdownX}x slower per call, ~${s.perf.deploySlowdownX}x on deploy`,
	);
});
