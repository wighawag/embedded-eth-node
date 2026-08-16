/**
 * estimate-gas.spec.ts: `eth_estimateGas` RETURNS A GAS LIMIT THAT WORKS.
 *
 * The method reports the smallest limit at which the request SUCCEEDS, found by
 * re-executing it, rather than the gas it consumes. The two differ by EIP-150's
 * 63/64 rule for anything that calls out or creates, and the difference is a
 * transaction that mines versus one that reverts with no contract created and no
 * hint as to why. The battery, the reasoning and the CREATE2-factory case it is
 * built around live in `helpers/estimate-gas.ts`.
 *
 * Every case that produces a number signs a transaction AT that number and
 * submits it, so `refused: ...` is a possible outcome throughout: the node must
 * never refuse a limit its own `eth_estimateGas` has just recommended.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('eth_estimateGas returns the smallest gas LIMIT that works, not the gas consumed', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'estimate-gas'}});

	console.log('\n[estimate-gas] errors:', r.errors);
	const c = r.results.estimateGas as Record<string, any>;
	console.log('[estimate-gas]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// 0) The battery really is measuring against the standard CREATE2 factory,
	// deployed by its own keyless presigned transaction at the canonical address.
	// Without this, every assertion below could be passing against nothing.
	expect(c.factoryDeploy).toEqual({
		status: '0x1',
		address: '0x4e59b44847b379578588920ca78fbf26c0b4956c',
		codeBytes: 69,
	});

	// 1) THE BUG. A deployment THROUGH the factory (a plain call whose body does
	// one CREATE2) mines at the estimate, and the contract exists. With the
	// run-and-measure this method used to be, this is `mined 0x0` with
	// `createdCodeBytes: 0` — a failed deployment behind a receipt that names no
	// reason, and a caller left pointing at an address with no code.
	expect(c.throughFactory.outcome).toBe('mined 0x1');
	expect(c.throughFactory.createdCodeBytes).toBeGreaterThan(0);
	// ...and the gap is the 1/64 the outer frame keeps: the estimate is ABOVE what
	// the transaction consumed, which is exactly what run-and-measure cannot be.
	expect(BigInt(c.throughFactory.gapOverConsumption)).toBeGreaterThan(0n);
	expect(BigInt(c.throughFactory.estimate)).toBeGreaterThan(
		BigInt(c.throughFactory.gasUsed),
	);

	// 2) ...AND IT IS THE MINIMUM, not a padding. One gas less must fail, which is
	// the half of this that a "multiply by 1.1" implementation cannot pass.
	expect(c.throughFactoryOneGasLess.outcome).toBe('mined 0x0');

	// 3) THE COMMON CASES ARE NOT INFLATED. A bare value transfer is 21000 to the
	// gas, and a deployment with no inner create still estimates exactly what it
	// consumes when mined — the search short-circuits the moment consumption is
	// proven to be a workable limit.
	expect(c.transfer).toEqual({
		estimate: '21000',
		outcome: 'mined 0x1',
		gasUsed: '21000',
		contractAddress: null,
	});
	expect(c.deploy.outcome).toBe('mined 0x1');
	expect(c.deploy.estimate).toBe(c.deploy.gasUsed);

	// 4) WHAT CANNOT SUCCEED AT ANY LIMIT IS AN ERROR, never a plausible number.
	// The leading clause and the `data` stay what a client decodes (viem turns the
	// pair into a typed revert error); what is added is the part only this method
	// knows — that no gas limit would have helped — and the reason, decoded.
	expect(c.unestimatable.outcome).toBe('threw');
	expect(c.unestimatable.code).toBe(3);
	expect(c.unestimatable.message).toContain('execution reverted');
	expect(c.unestimatable.message).toContain('EVERY gas limit');
	expect(c.unestimatable.message).toContain('Revert reason: boom');
	// the callee's own bytes, untouched: `Error("boom")`.
	expect(c.unestimatable.data).toMatch(/^0x08c379a0/);

	// ...and the TWO ALLOWANCE EDGES, which are a different problem and say so.
	// Neither reverted, so neither is code 3 with empty `data`: a client that read
	// one as a revert would hunt for return data that does not exist, and a user
	// would be told their contract failed when their gas allowance did. Both are
	// -32000 in geth's own vocabulary, which is what the node already answers a
	// transaction whose gas limit its pool refuses.
	//
	// First: an allowance too small to pay for the transaction's own bytes, so
	// nothing executes at all.
	expect(c.capTooLow.outcome).toBe('threw');
	expect(c.capTooLow.code).toBe(-32000);
	expect(c.capTooLow.data).toBe(null);
	expect(c.capTooLow.message).toContain('gas required exceeds allowance');

	// Second: an allowance that starts the transaction and cannot finish it — the
	// request burns the whole block gas limit and halts. The node tells this apart
	// from a revert STRUCTURALLY (everything spent, nothing returned) rather than by
	// matching an engine's words, and names the knob that raises the allowance.
	expect(c.overAllowance.outcome).toBe('threw');
	expect(c.overAllowance.code).toBe(-32000);
	expect(c.overAllowance.data).toBe(null);
	expect(c.overAllowance.message).toContain('gas required exceeds allowance');
	expect(c.overAllowance.message).toContain('blockGasLimit');

	// 5) THE COST, at the seam. A search is only affordable in a browser tab if the
	// common case does not pay for it: against an engine that always succeeds, ONE
	// estimate is TWO engine calls — the run at the upper bound, and the probe that
	// confirms consumption is a workable limit — and the answer is still exactly
	// intrinsic + the execution gas the engine reported.
	expect(c.probeCounts.callsForOneEstimate).toBe(2);
	expect(c.probeCounts.estimate).toBe(c.probeCounts.estimateExpected);

	// ...and the case that DOES search, against an engine whose 63/64 shortfall is
	// arithmetic rather than bytecode: the answer is the threshold EXACTLY (so the
	// search is exact, not merely safe), and the whole search costs a pinned number
	// of full executions. This is the figure a change to the ramp or the bounds
	// would move, and the number a consumer pays for a realistic single-level
	// shortfall — the gap here is the 3,099 gas the real factory case measures.
	expect(c.searchCost.answer).toBe(c.searchCost.answerExpected);
	expect(BigInt(c.searchCost.answer)).toBeGreaterThan(
		BigInt(c.searchCost.consumption),
	);
	expect(c.searchCost.callsForOneEstimate).toBe(15);

	await h.dispose();
});
