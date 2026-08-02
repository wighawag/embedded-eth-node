/**
 * revm-engine.spec.ts — `embedded-eth-node/revm` in real browsers:
 *   - the node runs its READ path on revm-wasm and says so
 *   - results and gas are IDENTICAL to the default `@ethereumjs/evm` engine
 *   - revm reads the node's own state (a mined tx is visible with no sync step)
 *   - an `eth_call` on revm cannot mutate state
 *   - a read from an UNFUNDED address and from an address HOLDING CODE works on
 *     both engines, with the same result and the same gas
 *   - a VALUE-BEARING read succeeds or fails IDENTICALLY on both engines: the
 *     simulation switches relax a transaction's validity rules, never the value
 *     transfer itself
 *   - the BLOCK ENVIRONMENT a contract reads (BASEFEE / PREVRANDAO / COINBASE /
 *     NUMBER / TIMESTAMP / GASLIMIT) is the node's own, and identical on both
 *   - BLOCKHASH answers with the node's real block hashes
 *   - both wasm delivery shapes (bundler-resolved asset, runtime-fetched URL)
 *   - `stateMode:'trie'` is refused at construction, naming the reason
 *   - a hardfork whose rules the node's intrinsic-gas arithmetic does not
 *     implement is refused at construction, naming the EIP and where to look
 *   - on every hardfork the engine DOES admit, what the node hands it is
 *     accepted: the estimate for a calldata-heavy call and the default read
 *     budget both survive revm's own transaction validation
 *   - one engine instance serves one node (a second `createNode()` is refused)
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
		params: {
			mode: 'revm-engine',
			runtimeWasmUrl: new URL('revm.wasm', h.serverUrl).href,
		},
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

	// every caller a SIMULATION must serve works, on both engines: funded,
	// unfunded (what the zeroed base fee used to buy), and holding code (EIP-3607,
	// which the default engine's runCall never enforced). A refusal on either
	// engine is a divergence.
	expect(c.callerErrors).toEqual({});
	expect(c.callerResultsMatch).toBe(true);
	expect(c.callerGasMatches).toBe(true);
	expect(c.callerResultsAgree).toBe(true);
	// sumTo(4) == 0+1+2+3 == 6, from a caller that holds code.
	expect(BigInt(c.callerResults['contract.revm'])).toBe(6n);

	// a VALUE-BEARING read is relaxed in its VALIDITY rules, never in its
	// TRANSFER: an unaffordable value fails on both engines (geth's `eth_call`
	// fails it too, with ErrInsufficientBalance), an affordable one succeeds on
	// both, and a zero-value read from an address holding nothing still works.
	// Both engines are held to the absolute statement, not merely to each other.
	expect(c.valueOutcomesMatch).toBe(true);
	expect(c.valueOutcomes).toEqual(
		Object.fromEntries(
			Object.entries(c.valueExpected).flatMap(([name, want]) => [
				[`${name}.default`, want],
				[`${name}.revm`, want],
			]),
		),
	);
	expect(c.valueOutcomesCorrect).toBe(true);

	// the BLOCK ENVIRONMENT read through a contract is the node's own, and the
	// SAME on both engines. Gas cannot see this class of bug: these opcodes are
	// fee-independent, so an engine running the read against a block the node
	// never had still charges byte-identical gas.
	expect(c.blockEnvMatches).toBe(true);
	expect(c.blockEnvOnRevm).toEqual(c.blockEnvExpected);
	// ...and specifically NOT the zeroed base fee the engine used to force.
	expect(BigInt(c.blockEnvOnRevm.basefee)).toBe(7_000_000_000n);
	expect(BigInt(c.blockEnvOnRevm.prevrandao)).not.toBe(0n);

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

	// a HARDFORK the engine cannot cost is refused the same way. The node runs
	// Cancun, so this guard is unreachable through `createNode()` — which is the
	// point: it fires the day the node's hardfork moves, instead of the node
	// quietly charging pre-Prague intrinsic gas against post-Prague enforcement.
	expect(c.refusedHardforks).toEqual(['prague', 'osaka']);
	expect(c.hardforkRefusals.prague).not.toBe('DID_NOT_THROW');
	expect(c.hardforkRefusals.prague).toContain('EIP-7623');
	expect(c.hardforkRefusals.prague).toContain('intrinsic-gas.ts');
	expect(c.hardforkRefusals.osaka).not.toBe('DID_NOT_THROW');
	expect(c.hardforkRefusals.osaka).toContain('EIP-7825');
	for (const message of Object.values(c.hardforkRefusals) as string[]) {
		// every refusal names the ADR a reader should go and read
		expect(message).toContain('docs/adr/0008-');
	}
	// ...and the fork the node actually runs is untouched
	expect(c.cancunAdmitted).toBe(true);
	expect(c.admittedHardforks).toEqual([
		'berlin',
		'london',
		'paris',
		'shanghai',
		'cancun',
	]);

	// THE INVARIANT, asserted against the engine itself: on every hardfork the
	// table admits, the number `eth_estimateGas` returned for a calldata-heavy
	// call is a gas limit revm RUNS, and so is the node's default read budget.
	// viem uses an estimate as the transaction's gas limit, so a rejection here
	// would reach the user as "out of gas" with no warning.
	expect(c.heavyEstimatesMatch).toBe(true);
	expect(BigInt(c.heavyEstimates.revm)).toBe(21_000n + 1000n * 16n);
	for (const hardfork of c.admittedHardforks as string[]) {
		expect(`${hardfork}: ${c.estimateVerdicts[hardfork]}`).toBe(
			`${hardfork}: accepted`,
		);
		expect(`${hardfork}: ${c.budgetVerdicts[hardfork]}`).toBe(
			`${hardfork}: accepted`,
		);
	}
	// ...and the refusals are load-bearing: the SAME numbers are rejected on the
	// specs the table does not admit.
	expect(c.estimateOnPrague).toContain('GasFloorMoreThanGasLimit');
	expect(c.budgetOnOsaka).toContain('TxGasLimitGreaterThanCap');

	// one engine, one node: re-using a connected engine is refused rather than
	// silently re-pointing the first node's reads at the second node's state
	expect(c.reuseRefusal).not.toBe('DID_NOT_THROW');
	expect(c.reuseRefusal).toMatch(/createNode/i);
	expect(c.numberAfterReuseAttempt).toBe('1');

	await h.dispose();
});
