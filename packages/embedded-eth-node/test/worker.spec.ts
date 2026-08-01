/**
 * worker.spec.ts — proves the OPTIONAL comlink Worker story for the slim node in
 * a real Chromium:
 *   - createWorkerNode() returns the SAME {request, mine, ...} API as createNode()
 *     (interchangeable one-liners; consumer picks the thread);
 *   - a viem walletClient/publicClient drives the node ACROSS the Worker boundary
 *     unchanged (signed eth_sendRawTransactionSync, eth_call);
 *   - the main thread stays NON-BLOCKING while the Worker runs heavy compute
 *     (heavy EVM compute that would otherwise stall the main thread);
 *   - the node's `readEngine` identity ROUND-TRIPS across the boundary (it is a
 *     plain value on purpose, and nothing else asserted it survived).
 *
 * The harness bundles the page (the `cut`) AND the package's worker-entry (the
 * comlink `expose()` side) with the same Node polyfills, serving the worker as
 * `worker.js`; we hand the page its URL via params.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const workerEntry = resolve(here, '../src/worker-entry.ts');

test('slim-node over a comlink Worker: same API + main-thread non-blocking', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		worker: workerEntry,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const workerUrl = new URL('worker.js', h.serverUrl).href;
	const r = await h.run({
		phase: 'once',
		params: {mode: 'worker', workerUrl, sumTo: 50000},
	});

	console.log('\n[worker] errors:', r.errors);
	console.log('[worker] results:', JSON.stringify(r.results));
	console.log('[worker] timings:', JSON.stringify(r.timings));

	expect(r.errors).toEqual([]);
	// 20 increments across the Worker boundary landed:
	expect(r.results.number).toBe('20');
	// the engine identity survived the comlink boundary as a plain value
	expect(r.results.readEngineId).toBe('@ethereumjs/evm');

	const t = Object.fromEntries(r.timings.map((x: any) => [x.label, x.ms]));
	// The heavy compute ran in the Worker; the main-thread sampler should never
	// have stalled for anywhere near the compute time. Generous bound (the same
	// sumTo on the MAIN thread blocks ~tens of ms); here it must stay small.
	console.log(
		'[worker] main-thread max gap during Worker compute (ms):',
		t.mainThreadMaxGap,
	);
	expect(t.mainThreadMaxGap).toBeLessThan(15);

	await h.dispose();
});
