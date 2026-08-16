/**
 * revm-access-list.spec.ts: EIP-2930 ACCESS LISTS ARE CHARGED AND WARMED, and
 * the proof is arithmetic rather than agreement.
 *
 * A CROSS-ENGINE DIFF CANNOT SEE A DROPPED ACCESS LIST. If the node fails to pass
 * `tx.accessList` to the engine, the transaction costs the same number on both
 * engines, the receipts match field for field and the post-state is identical, so
 * every differential in this repo stays green while a protocol charge silently
 * disappears. So the assertions below are ABSOLUTE and they are DIFFERENCES:
 * the same transaction with the list versus with an EMPTY one, held to the figures
 * EIP-2930 and EIP-2929 specify, on BOTH engines.
 *
 * The three differences are what identify the failure rather than merely
 * reporting one:
 *
 *   * `-100`: the list was charged (2,400 / 1,900) AND warmed (saving 2,500 /
 *     2,000). This is the only combination that lands there.
 *   * `+2400`: charged, but the entry was already warm, so it bought nothing.
 *     Also what a charged-but-NOT-warmed implementation would show on an entry
 *     that IS touched, which is why the touched cases assert the negative number.
 *   * `+6200`: charged in full for entries never touched at all (2,400 + 2 *
 *     1,900). The shape where a dropped list is invisible by every other measure.
 *   * `0`: what a DROPPED list gives on every case above.
 *
 * ...and the estimate that has to survive the node's own advice: the intrinsic-gas
 * refusal tells a caller that `eth_estimateGas` reports what a transaction needs,
 * so this battery estimates a type-1 request WITH its access list and then sends a
 * real transaction at exactly that gas limit. Before `eth_estimateGas` charged the
 * list it answered 21,000 for a transaction whose floor is 27,200, and the node
 * refused the number it had just recommended.
 *
 * Its OWN cut (helpers/cut-revm.ts), because that bundle carries the revm `.wasm`
 * and the shared cut must keep costing the other specs nothing.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

/**
 * WHAT EACH ARM COSTS, to the gas, held against BOTH engines, because two
 * engines can agree on a price neither should have charged.
 *
 * Every figure is 21,000 + the access-list charge + the program, and the program
 * is six bytes long on purpose:
 *
 *   * `BALANCE_PROBE` = `PUSH20 <addr>` (3) + `BALANCE` (2,600 cold / 100 warm) +
 *     `POP` (2) + `STOP` (0);
 *   * `SLOAD_PROBE`   = `PUSH1 07` (3) + `SLOAD` (2,100 cold / 100 warm) + `POP`
 *     (2) + `STOP` (0);
 *   * a value transfer to a codeless recipient = nothing at all.
 */
const GAS = {
	// 21,000 + 3 + 2,600 (COLD account access) + 2.
	'addressTouched.cold': {type: '1', status: '1', gasUsed: '23605'},
	// 21,000 + 2,400 (the list's address term) + 3 + 100 (WARM) + 2, one hundred
	// gas LESS than the arm above, which is the whole assertion of this battery.
	'addressTouched.listed': {type: '1', status: '1', gasUsed: '23505'},
	// 21,000 + 3 + 2,100 (COLD storage read) + 2.
	'keyTouched.none': {type: '1', status: '1', gasUsed: '23105'},
	// ...+ 2,400 for naming the callee, which EIP-2929 had already warmed: a
	// charge that buys nothing, and the shape of "charged but not warmed".
	'keyTouched.addressOnly': {type: '1', status: '1', gasUsed: '25505'},
	// ...+ 1,900 for the key, and the SLOAD drops from 2,100 to 100: again -100
	// against the arm above, now for the storage-key term alone.
	'keyTouched.addressAndKey': {type: '1', status: '1', gasUsed: '25405'},
	// A bare value transfer.
	'untouched.none': {type: '1', status: '1', gasUsed: '21000'},
	// ...+ 2,400 + 2 * 1,900 for entries the transaction never mentions again.
	'untouched.listed': {type: '1', status: '1', gasUsed: '27200'},
} as const;

/**
 * `eth_estimateGas`, per request, identical on both engines, because the node
 * adds the same intrinsic terms to whatever EXECUTION gas an engine reports.
 */
const ESTIMATES = {
	// A bare transfer: the base and nothing else.
	'untouched.none': '21000',
	// ...and the SAME request carrying the access list: +6,200, which is exactly
	// the transaction's own intrinsic floor and exactly what it costs when mined.
	'untouched.listed': '27200',
	// DELIBERATELY HIGHER THAN THE 23,505 THE MINED TRANSACTION PAYS. A read
	// carries no access list to the engine, so the `BALANCE` is priced COLD (2,600)
	// while the estimate still charges the list's 2,400: 21,000 + 2,400 + 3 + 2,600
	// + 2. Over-estimating is the safe direction (a client uses the estimate as its
	// gas limit), and it is pinned here so the property is stated and measured
	// rather than discovered. See `accessListGas` in `src/intrinsic-gas.ts`.
	'addressTouched.listed': '26005',
} as const;

test('revm access lists: EIP-2930 entries are CHARGED and WARMED, identically to @ethereumjs/vm, and eth_estimateGas charges them too', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The bundler-resolved wasm delivery shape, as in `revm-fees.spec.ts`.
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'access-list'}});

	console.log('\n[revm-access-list] errors:', r.errors);
	const c = r.results.revmAccessList as Record<string, any>;
	console.log('[revm-access-list]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// The battery really ran the two engines against each other, and not one engine
	// against itself, the failure mode that would make every assertion below pass
	// while measuring nothing.
	expect(c.referenceEngineId).toBe('@ethereumjs/evm');
	expect(c.engineId).toBe('revm-wasm');

	// 1) THE ABSOLUTE STATEMENT, on BOTH engines. This is the assertion a dropped
	// access list fails: agreement between the engines would survive it, these
	// literals cannot.
	expect(c.gas.underTest).toEqual(GAS);
	expect(c.gas.reference).toEqual(GAS);

	// 2) THE DIFFERENTIAL: the same transaction cost the same gas, was the same
	// EIP-2718 type and succeeded the same way on both engines, for every arm.
	// `mismatches` names `case.field` with both values.
	expect(c.mismatches).toEqual([]);

	// 3) ...AND THE DIFFERENCES THEMSELVES, spelled out, so the numbers above are
	// read as the protocol's arithmetic rather than as figures somebody recorded.
	const used = (label: keyof typeof GAS) =>
		BigInt(c.gas.underTest[label].gasUsed);

	// LISTING AN ADDRESS THE TRANSACTION TOUCHES IS 100 GAS CHEAPER: charged 2,400,
	// saved 2,500. A dropped list gives 0 here; a list charged but never warmed
	// gives +2,400.
	expect(used('addressTouched.listed') - used('addressTouched.cold')).toBe(
		-100n,
	);

	// NAMING THE CALLEE BUYS NOTHING (it was already warm), so the address term
	// shows up whole. This is the positive control for the assertion above: it is
	// what a charge with no warming looks like.
	expect(used('keyTouched.addressOnly') - used('keyTouched.none')).toBe(2400n);

	// ADDING THE KEY TO THAT SAME ENTRY IS 100 GAS CHEAPER: charged 1,900, saved
	// 2,000. The address term is identical in both arms, so this difference is the
	// storage-key term and nothing else.
	expect(
		used('keyTouched.addressAndKey') - used('keyTouched.addressOnly'),
	).toBe(-100n);

	// ENTRIES NEVER TOUCHED ARE CHARGED IN FULL AND BUY NOTHING: 2,400 + 2 * 1,900.
	// Nothing else about this transaction changes (same status, same value, same
	// post-state), so a node that dropped the list would show 0 here and be caught
	// by no other assertion in this repo.
	expect(used('untouched.listed') - used('untouched.none')).toBe(6200n);

	// 4) A LISTED ADDRESS IS WARMED, NOT TOUCHED. Naming an account in an access
	// list does not bring it into existence, on either engine.
	expect(c.neverTouchedInDump).toEqual({reference: false, underTest: false});

	// 5) eth_estimateGas CHARGES THE LIST, identically on both engines.
	expect(c.estimates.underTest).toEqual(ESTIMATES);
	expect(c.estimates.reference).toEqual(ESTIMATES);
	expect(
		BigInt(c.estimates.underTest['untouched.listed']) -
			BigInt(c.estimates.underTest['untouched.none']),
	).toBe(6200n);
	// The estimate is never BELOW what the transaction actually pays, which is the
	// direction that reaches a user: a client uses this number as its gas limit.
	expect(
		BigInt(c.estimates.underTest['addressTouched.listed']),
	).toBeGreaterThanOrEqual(used('addressTouched.listed'));

	// 6) ...AND THE NODE'S OWN ADVICE SURVIVES BEING TAKEN. The intrinsic-gas
	// refusal tells the caller to ask `eth_estimateGas` for the number a transaction
	// needs; a transaction signed at exactly that number must MINE. With an estimate
	// blind to the access list this is `refused: intrinsic gas too low: have 21000,
	// want 27200`, the node refusing the figure it had just recommended.
	expect(c.atEstimatedGas.underTest).toEqual({
		gasLimit: '27200',
		outcome: 'mined 0x1',
	});
	expect(c.atEstimatedGas.reference).toEqual({
		gasLimit: '27200',
		outcome: 'mined 0x1',
	});

	await h.dispose();
});
