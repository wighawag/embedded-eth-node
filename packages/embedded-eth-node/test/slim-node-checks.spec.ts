/**
 * slim-node-checks.spec.ts — in-browser correctness + honesty assertions for the
 * node, run in real Chromium:
 *   - LEGACY (type-0) tx receipt does NOT crash; `effectiveGasPrice` present.
 *   - EIP-1559 receipt has `effectiveGasPrice` too.
 *   - Account/signing + unknown methods throw a real -32601 (never fake success).
 *   - dump/load persistence round-trips into a fresh node.
 *   - State-root mode: `'none'` throws / zero block root; `'trie'` produces a REAL
 *     Merkle-Patricia root that matches the block header; both modes agree.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('node honesty + correctness (receipts, gaps, persistence, state-root mode)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'slim-node-checks'}});

	console.log('\n[slim-node-checks] errors:', r.errors);
	const c = r.results.slimNodeChecks as Record<string, any>;
	console.log('[slim-node-checks]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);
	expect(c.legacyReceipt.ok).toBe(true); // legacy receipt does NOT crash
	expect(c.eip1559ReceiptHasEffGasPrice).toBe(true);
	// account/signing methods + unknown methods throw -32601
	expect(c.gap_eth_sendTransaction).toBe('threw:-32601');
	expect(c.gap_eth_accounts).toBe('threw:-32601');
	expect(c.gap_personal_sign).toBe('threw:-32601');
	expect(c.gap_unknown_method).toBe('threw:-32601');
	// persistence round-trip
	expect(c.restoredNumber).toBe(c.number);
	// state-root mode: 'none' has no root (honest throw / zero block root); 'trie'
	// gives a REAL Merkle-Patricia root in the node + the block header; both agree.
	expect(c.noneModeGetStateRootThrows).toBe(true);
	expect(c.noneBlockStateRootIsZero).toBe(true);
	expect(c.trieModeNumber).toBe('3');
	expect(c.trieModeRootIsReal).toBe(true);
	expect(c.trieBlockStateRootMatches).toBe(true);

	await h.dispose();
});
