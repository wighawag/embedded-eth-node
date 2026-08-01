/**
 * slim-node-checks.spec.ts — in-browser correctness + honesty assertions for the
 * node, run in real Chromium:
 *   - LEGACY (type-0) tx receipt does NOT crash; `effectiveGasPrice` present.
 *   - EIP-1559 receipt has `effectiveGasPrice` too.
 *   - Account/signing + unknown methods throw a real -32601 (never fake success).
 *   - dump/load persistence round-trips into a fresh node.
 *   - State-root mode: `'none'` throws / zero block root; `'trie'` produces a REAL
 *     Merkle-Patricia root that matches the block header; both modes agree.
 *   - Engine seam: an engine that cannot start, cannot serve the node's
 *     configuration, or is not an engine at all fails LOUDLY at construction
 *     (never a silent fallback to the default engine), and an engine handed to
 *     `createWorkerNode` is refused by name rather than by a DataCloneError.
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

	// ---- engine seam: the honest edges of `createNode({engine})` ----
	// The failure that matters is a SILENT FALLBACK. Every probe below reports the
	// engine the node CAME UP on, so a fallback would read as
	// `DID_NOT_THROW:@ethereumjs/evm` instead of quietly passing.

	// an engine that fails to initialise: construction fails, naming the engine and
	// the cause the engine itself reported.
	expect(c.engineInitFailure).not.toContain('DID_NOT_THROW');
	expect(c.engineInitFailure).toContain(c.engineInitCause);
	expect(c.engineInitFailure).toContain('test-engine-that-cannot-start');

	// a configuration the engine cannot serve: refused at construction, carrying
	// the engine's own reason...
	expect(c.engineRefusedMode).not.toContain('DID_NOT_THROW');
	expect(c.engineRefusedMode).toContain("stateMode:'trie'");
	// ...while the SAME engine serves the mode it supports, so the refusal is about
	// the configuration, not the engine.
	expect(c.engineServedMode).toBe('DID_NOT_THROW:test-engine-none-only');

	// an object that is not a ReadEngine is refused at construction, not at the
	// first read.
	expect(c.engineNotAnEngine).not.toContain('DID_NOT_THROW');
	expect(c.engineNotAnEngine).toContain('call');

	// the Worker path refuses an engine by NAME (an engine cannot be
	// structured-cloned into a Worker) rather than surfacing comlink's opaque
	// DataCloneError. The probe reports `threw:<name>:<message>`, so the ERROR
	// TYPE is what distinguishes the two: our own Error, not comlink's
	// DataCloneError DOMException. (The message mentions DataCloneError on
	// purpose, for anyone who got one before this guard existed.)
	expect(c.workerEngine).not.toContain('DID_NOT_THROW');
	expect(c.workerEngine).not.toContain('threw:DataCloneError');
	expect(c.workerEngine).toMatch(
		/^threw:Error:embedded-eth-node\/worker-client: `engine`/,
	);
	expect(c.workerEngine).toContain('createNode');

	// (7) a CREATE never inherits storage that was already at its address.
	// Upstream `SimpleStateManager.clearStorage()` is an empty no-op that drops its
	// address argument, so without our override (src/state-manager.ts) a fresh
	// Counter deployed onto a seeded address returned 99 here instead of 0 —
	// silently, with a success receipt.
	for (const mode of ['none', 'trie'] as const) {
		expect(BigInt(c[`seededSlot0.${mode}`])).toBe(99n);
	}
	// 'none': no storageRoot, so EIP-7610 cannot fire; creation proceeds and the
	// storage is CLEARED.
	expect(c['deployStatus.none']).toBe('success');
	expect(c['deployLandedOnTarget.none']).toBe(true);
	expect(c['numberAfterRedeploy.none']).toBe('0');
	// 'trie': a real storageRoot, so the collision guard REJECTS the creation. The
	// mode difference is deliberate and asserted so it cannot drift unnoticed.
	expect(c['deployStatus.trie']).not.toBe('success');
	expect(c['numberAfterRedeploy.trie']).toBe('n/a');

	await h.dispose();
});
