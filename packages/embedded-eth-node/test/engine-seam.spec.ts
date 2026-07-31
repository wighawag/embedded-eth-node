/**
 * engine-seam.spec.ts — the EVM engine seam, in real browsers:
 *   - the DEFAULT engine is `@ethereumjs/evm`, exposed as the node's READ engine
 *   - an injected engine serves ALL THREE read-path callers (eth_call,
 *     eth_estimateGas, eth_fillTransaction's estimation)
 *   - the engine reports EXECUTION gas; the node adds intrinsic gas
 *   - transactions do NOT go through the read engine
 *   - the default engine keeps the EIP-2929 reset + pure-read checkpoint/revert
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('engine seam (default @ethereumjs/evm, injected engine, read-only scope)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'engine-seam'}});

	console.log('\n[engine-seam] errors:', r.errors);
	const c = r.results.engineSeam as Record<string, any>;
	console.log('[engine-seam]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// the default engine, named as the READ engine
	expect(c.defaultReadEngineId).toBe('@ethereumjs/evm');
	// the pure-read invariants the default engine owns
	expect(c.estimateIncrementStable).toBe(true);
	expect(c.callDidNotMutateState).toBe(true);
	expect(c.number).toBe('0');

	// an injected engine is what the read path actually runs on
	expect(c.stubReadEngineId).toBe('test-stub');
	expect(c.stubConnectCount).toBe(1);
	expect(c.stubConnectedStateMode).toBe('none');
	expect(c.stubConnectedStateManagerUsable).toBe(true);
	expect(c.stubCallResult).toBe(c.stubCallExpected);
	// engine EXECUTION gas + node intrinsic gas
	expect(c.stubEstimate).toBe(c.stubEstimateExpected);
	expect(c.stubFilledGas).toBe(c.stubEstimateExpected);
	// eth_call + eth_estimateGas + eth_fillTransaction = three engine calls
	expect(c.stubCallsSeen).toBe(3);

	// transactions run on @ethereumjs/vm, NOT on the read engine
	expect(c.stubCallsAfterTx).toBe(3);
	expect(c.stubTxStatus).toBe('success');
	expect(c.stubTxGasUsed).toBe('21000');
	expect(c.stubTargetBalance).toBe('1');

	// a reverting engine result is still an honest execution-reverted error
	expect(c.revertingCall).toBe('threw:3:0xdeadbeef');

	await h.dispose();
});
