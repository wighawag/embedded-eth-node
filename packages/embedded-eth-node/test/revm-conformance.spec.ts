/**
 * revm-conformance.spec.ts — the DIFFERENTIAL conformance battery, run with the
 * `embedded-eth-node/revm` engine installed.
 *
 * The battery itself is the one `conformance.spec.ts` runs (helpers/conformance.ts):
 * the same signed transactions through the node AND through a trie-backed
 * `@ethereumjs/vm` `runTx` reference, diffed field by field plus post-state. What
 * changes here is only WHICH EVM answers the READ path — `eth_call` return data
 * and `eth_estimateGas` — because that is the whole of what THIS engine owns
 * today: the seam covers transactions, and `createRevmEngine()` has no write half
 * yet, so a revm-backed node still executes its transactions on `@ethereumjs/vm`.
 *
 * STATE-MODE COVERAGE IS EXPLICIT, and it is the shipped engine's refusal that
 * decides the split, not a convenience:
 *
 *   'none'  — served by revm, so the WHOLE battery runs on it here.
 *   'trie'  — REFUSED by revm at construction (`MerkleStateManager` has no
 *             synchronous view for revm to read through, ADR 0005), so it keeps
 *             its existing default-engine coverage in `conformance.spec.ts`.
 *
 * The refusal is re-asserted below so the split is self-evident from this file:
 * if revm ever served `'trie'`, this test would go red rather than quietly leave
 * a mode unmeasured. Nothing in the battery is relaxed or skipped for revm —
 * `conformance.spec.ts` still runs both modes on the default engine, unchanged.
 *
 * Its OWN cut (helpers/cut-revm.ts), because that bundle carries the revm
 * `.wasm` and the shared cut must keep costing the other specs nothing.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('differential conformance with the revm engine installed (stateMode:none)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The bundler-resolved wasm delivery shape: `import ... from
		// 'revm-wasm/revm.wasm'` built into the bundle as bytes (the harness's
		// built-in `.wasm` loader is `copy`, which the browser then refuses to
		// execute as a module).
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'conformance'}});

	console.log('\n[revm-conformance] errors:', r.errors);
	const c = r.results.revmConformance as any;
	const served = c.served;
	console.log(
		`\n[revm-conformance:${served.stateMode} on ${served.engineId}] ${served.steps.length} steps, ${served.totalMismatches} mismatches`,
	);
	for (const s of served.steps) {
		const tag = s.mismatches.length === 0 ? 'OK ' : 'XX ';
		console.log(
			`  ${tag}${s.label}${s.mismatches.length ? ': ' + JSON.stringify(s.mismatches) : ''}`,
		);
	}
	console.log('[revm-conformance] refusals:', JSON.stringify(c.refusals));

	expect(r.errors).toEqual([]);

	// The battery really ran ON REVM (not silently on the default engine).
	expect(served.engineId).toBe('revm-wasm');
	expect(served.stateMode).toBe('none');

	// Field-by-field equality against the trie-backed reference → zero diffs.
	expect(served.totalMismatches).toBe(0);
	expect(c.totalMismatches).toBe(0);

	// Sanity: the same full battery, not a short-circuited subset. Same bound as
	// `conformance.spec.ts` uses for each of its two modes.
	expect(served.steps.length).toBeGreaterThanOrEqual(15);

	// The read assertions the engine actually owns are in there, and passed.
	const labels = served.steps.map((s: any) => s.label);
	expect(labels).toContain('1559-call(increment) view number()');
	expect(labels).toContain('estimateGas exactness (increment)');
	expect(labels).toContain('estimateGas CREATE incl. EIP-3860 initcode');
	// ...including the BLOCK-ENVIRONMENT step, the one bar that can see an engine
	// lying about the block it runs in (BASEFEE / PREVRANDAO / COINBASE / NUMBER /
	// TIMESTAMP are gas-independent, so neither the gas gate nor the receipt diff
	// can). This is the step the zeroed base fee would have failed.
	expect(labels).toContain('block environment through a contract');
	// ...and the VALUE-BEARING-READ step, which pins the other half of `eth_call`
	// semantics: relaxing a transaction's validity rules must not relax the value
	// TRANSFER, so a read carrying more ether than the sender holds fails on revm
	// exactly as it does on `@ethereumjs/evm`.
	expect(labels).toContain('value-bearing read affordability');

	// ...and the OTHER state mode is refused rather than covered here — which is
	// exactly why `conformance.spec.ts` keeps running it on the default engine.
	expect(c.refusals).toHaveLength(1);
	expect(c.refusals[0].stateMode).toBe('trie');
	expect(c.refusals[0].error).not.toBe('DID_NOT_THROW');
	expect(c.refusals[0].error).toContain('trie');

	await h.dispose();
});
