/**
 * conformance.spec.ts — DIFFERENTIAL conformance of the slim node's receipt/RPC
 * layer against a trusted reference EVM (a trie-backed @ethereumjs/vm `runTx` set
 * up by hand — the SAME engine WITH a Merkle state manager) running the SAME
 * signed txs, in real Chromium via playwright-browser-harness.
 *
 * WHY differential (not ethereum/tests fixtures): GeneralStateTests /
 * execution-spec-tests verify by comparing the post-state Merkle-Patricia TRIE
 * ROOT (+ keccak(RLP(logs))). The default slim node (`stateMode:'none'`) has NO
 * trie/root on purpose and throws on getStateRoot, so those fixtures can't
 * validate it without reintroducing a trie — and VMTests (the one trie-free
 * format) is frozen at Homestead. The legacy effectiveGasPrice bug this node
 * guards against is a RECEIPT/RPC-layer concern none of them cover. See the
 * package README "On comprehensive EVM test fixtures". The right tool is a
 * differential diff of OUR layer — implemented in test/helpers/conformance.ts.
 *
 * We run the whole battery against BOTH state modes ('none' default fast path AND
 * 'trie') and assert ZERO field-by-field mismatches against the reference.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('slim-node differential conformance vs trie-backed @ethereumjs/vm reference', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'conformance'}});

	console.log('\n[conformance] errors:', r.errors);
	const c = r.results.conformance as any;
	// Pretty-print the per-step report so a failure tells you exactly which field
	// diverged on which tx (and in which state mode).
	for (const mode of ['none', 'trie'] as const) {
		console.log(
			`\n[conformance:${mode}] ${c[mode].steps.length} steps, ${c[mode].totalMismatches} mismatches`,
		);
		for (const s of c[mode].steps) {
			const tag = s.mismatches.length === 0 ? 'OK ' : 'XX ';
			console.log(
				`  ${tag}${s.label}${s.mismatches.length ? ': ' + JSON.stringify(s.mismatches) : ''}`,
			);
		}
	}

	expect(r.errors).toEqual([]);

	// Field-by-field equality across the WHOLE battery, BOTH modes → zero diffs.
	expect(c.none.totalMismatches).toBe(0);
	expect(c.trie.totalMismatches).toBe(0);
	expect(r.results.conformanceTotalMismatches).toBe(0);

	// Sanity: the battery actually ran a meaningful number of steps (not silently
	// short-circuited). Each mode runs the full battery (deploy/calls/legacy/2930/
	// multi-log/revert/estimate/back-to-back + post-state reads).
	expect(c.none.steps.length).toBeGreaterThanOrEqual(15);
	expect(c.trie.steps.length).toBeGreaterThanOrEqual(15);

	// The BLOCK-ENVIRONMENT step ran, in both modes. Named explicitly because it
	// is the only step whose class of bug is invisible to every other bar in the
	// repo: BASEFEE / PREVRANDAO / COINBASE / NUMBER / TIMESTAMP are
	// gas-independent, so an engine reading them wrong charges identical gas and
	// produces identical receipts. If it silently stopped running, nothing else
	// would go red.
	for (const mode of ['none', 'trie'] as const) {
		expect(c[mode].steps.map((s: any) => s.label)).toContain(
			'block environment through a contract',
		);
	}
});
