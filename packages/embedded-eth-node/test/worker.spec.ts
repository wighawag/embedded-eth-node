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
	// ...and so did every OTHER plain SlimNode field the worker-entry proxy
	// forwards. `senderMode` was silently absent from that proxy until
	// 2026-08-01, reading as `undefined` on a property typed
	// `'recover' | 'trusted'`; worker-client's `as any` hid it from the compiler
	// and nothing here asserted it. Assert the CLASS, not just the instance.
	expect(r.results.senderMode).toBe('recover');
	expect(r.results.stateMode).toBe('none');

	const t = Object.fromEntries(r.timings.map((x: any) => [x.label, x.ms]));
	console.log(
		'[worker] main-thread max gap during Worker compute (ms):',
		t.mainThreadMaxGap,
		'| samples:',
		r.results.mainThreadSampleCount,
		'| worker compute (ms):',
		t.workerCompute,
	);

	// THE PROPERTY: the heavy compute ran in the Worker, so the main thread kept
	// running throughout. A BLOCKED main thread cannot run the sampler at all, so
	// "the sampler fired many times during the compute" proves it on no clock at
	// all, which is what makes this load-invariant.
	//
	// We deliberately do NOT assert a raw millisecond bound on the max gap. WebKit
	// clamps `performance.now()` to 1 ms (and `setTimeout(…, 0)` is clamped too),
	// so the gap quantises to integers and a fixed bound sits one quantum away from
	// a coin flip: the previous `toBeLessThan(15)` returned exactly 15 on WebKit and
	// reddened the acceptance gate for a change that touched no executable code.
	// The repo's stance everywhere else (CI comments, benchmark config) is that
	// wall-clock numbers are reported, not asserted; this now matches it.
	expect(r.results.mainThreadSampleCount).toBeGreaterThan(10);
	// And the stall was nothing like the compute it overlapped: a wide-margin
	// RATIO of two figures measured in the SAME window on the SAME clock, so load
	// inflates both together (unlike a fixed bound, or a ratio across two runs).
	expect(t.mainThreadMaxGap).toBeLessThan(t.workerCompute / 3);

	await h.dispose();
});
