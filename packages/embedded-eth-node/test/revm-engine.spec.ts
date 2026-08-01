/**
 * revm-engine.spec.ts — `embedded-eth-node/revm` in real browsers:
 *   - the node runs its READ path on revm-wasm and says so
 *   - results and gas are IDENTICAL to the default `@ethereumjs/evm` engine
 *   - revm reads the node's own state (a mined tx is visible with no sync step)
 *   - an `eth_call` on revm cannot mutate state
 *   - BLOCKHASH answers with the node's real block hashes
 *   - both wasm delivery shapes (bundler-resolved asset, runtime-fetched URL)
 *   - `stateMode:'trie'` is refused at construction, naming the reason
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {mountHarness} from 'playwright-browser-harness';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// Its OWN cut: this bundle carries the revm `.wasm`, and the shared cut must
// keep costing the other specs nothing (see helpers/cut-revm.ts).
const cut = resolve(here, './helpers/cut-revm.ts');
// Served next to the bundle so the RUNTIME-FETCHED delivery shape has a URL to
// fetch. The bundler-resolved shape needs no help: the cut imports it.
const revmWasm = require.resolve('revm-wasm/revm.wasm');

/** Reference execution gas — identical on `@ethereumjs/evm` and revm-wasm. */
const REF = {
	number: '2446',
	sumTo2000: '498689',
	keccakLoop2000: '1107052',
	keccakResult:
		'0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a',
};

test('revm engine: same results + same gas as @ethereumjs/evm, on the node own state', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The BUNDLER-RESOLVED delivery shape: `import ... from 'revm-wasm/revm.wasm'`
		// in the cut, built into the bundle as bytes. The harness's built-in `.wasm`
		// loader is `copy`, which leaves a real module import the browser then refuses
		// to execute (`MIME type application/wasm`), so the suite picks the asset
		// loader a consumer's bundler would give it.
		esbuild: {loader: {'.wasm': 'binary'}},
		// ...and the RUNTIME-FETCHED shape needs the same file served next to the
		// bundle, exactly as a consumer would host it.
		assets: [revmWasm],
	});
	const r = await h.run({
		phase: 'once',
		params: {runtimeWasmUrl: new URL('revm.wasm', h.serverUrl).href},
	});

	console.log('\n[revm-engine] errors:', r.errors);
	const c = r.results.revmEngine as Record<string, any>;
	console.log('[revm-engine]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// the node reports which EVM ran its reads
	expect(c.defaultEngineId).toBe('@ethereumjs/evm');
	expect(c.revmEngineId).toBe(c.revmEngineIdExpected);
	expect(c.sameDeployAddress).toBe(true);

	// identical results and identical gas, engine against engine
	expect(c.resultsMatch).toBe(true);
	expect(c.gasMatches).toBe(true);
	// ...and the reference numbers, so a wrong answer is obvious
	expect(c.executionGas['number.revm']).toBe(REF.number);
	expect(c.executionGas['sumTo2000.revm']).toBe(REF.sumTo2000);
	expect(c.executionGas['keccakLoop2000.revm']).toBe(REF.keccakLoop2000);
	expect(c.callResults['keccakLoop2000.revm']).toBe(REF.keccakResult);

	// the engine reads the node's AUTHORITATIVE state — no sync step
	expect(c.txStatus).toBe('success');
	expect(c.numberAfterTx).toBe('1');

	// a read cannot mutate: eth_call increment() left slot 0 alone, and the store
	// revm reads through refuses every write
	expect(c.callDidNotMutateState).toBe(true);
	expect(BigInt(c.storageAfterCall)).toBe(1n);
	expect(c.writeMethodsThrow).toBe(true);

	// BLOCKHASH is wired to the node's OWN blocks (an unwired one answers zero,
	// silently). Each node is its own chain, so each is checked against itself.
	expect(c['blockHash.revm']).toBe(c['blockHashExpected.revm']);
	expect(c['blockHash.default']).toBe(c['blockHashExpected.default']);
	expect(BigInt(c['blockHash.revm'])).not.toBe(0n);

	// the runtime-fetched-URL delivery shape produces a working engine too
	expect(c.runtimeUrlEngineId).toBe(c.revmEngineIdExpected);
	expect(c.runtimeUrlCall).toBe(c.runtimeUrlCallExpected);
	expect(BigInt(c.runtimeUrlCall)).not.toBe(0n);

	// a stateMode the engine cannot serve is refused AT CONSTRUCTION, out loud
	expect(c.trieRefusal).not.toBe('DID_NOT_THROW');
	expect(c.trieRefusal).toContain('trie');
	expect(c.trieRefusal).toMatch(/revm/i);

	await h.dispose();
});
