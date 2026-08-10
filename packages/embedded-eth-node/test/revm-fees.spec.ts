/**
 * revm-fees.spec.ts — THE MONEY IS RIGHT, proved by diffing BALANCES rather than
 * receipts.
 *
 * `effectiveGasPrice` has exactly ONE implementation per engine and none in the
 * node: the default engine computes it where `@ethereumjs/vm` charges the
 * transaction (`src/engine.ts`), the revm engine reports revm's own
 * `Transaction::effective_gas_price` off its outcome (`src/revm.ts`), and the node
 * copies whichever number the engine that ran the transaction handed back
 * (`test/engine-seam.spec.ts` proves that with a stub engine reporting a price no
 * EVM would produce). What NO receipt field can prove is that the matching amount
 * of ether actually moved — a receipt can carry the right price while the wrong
 * amount left the sender, and the cross-backend gas gate in `packages/benchmarks`
 * cannot see that class of bug at all.
 *
 * So this battery (helpers/fees.ts) runs seven transactions on a revm-backed node
 * AND on a default-engine (`@ethereumjs/vm` `runTx`) node built from identical
 * state, and reads the money off BALANCES: what the sender was charged, what the
 * coinbase was credited, and what was BURNT — the latter measured as the drop in
 * total supply over every account in `dumpState`, so money appearing at a fourth
 * address cannot hide in a subtraction.
 *
 * The base fee is SEVEN wei, so every number below is arithmetic a reader can do
 * in their head: at 21,000 gas and an effective price of 10, the sender is charged
 * 211,000, the coinbase is credited 63,000 and 147,000 is burnt.
 *
 * THE ONE FEE-SHAPED THING THE NODE STILL DOES, so it is not mistaken for a second
 * implementation: `eth_gasPrice`, `eth_feeHistory` and `eth_fillTransaction` SUGGEST
 * prices out of the node's constant fee market (`baseFeePerGas`, `gasPrice`,
 * `maxPriorityFeePerGas` on `NodeOptions`) for a transaction nobody has signed yet.
 * Suggesting a price is not charging one: no path in `src/node.ts` computes what a
 * mined transaction COST.
 *
 * THAT THIS BATTERY CAN GO RED is measured rather than assumed — three deliberate
 * mutations (a legacy transaction priced at the base fee, the revm engine reporting
 * gross gas, and a hand-rolled `baseFee + tip` beside revm's own answer), each with
 * the run it produced, in
 * `docs/spikes/fees-refunds-and-effective-gas-price-come-from-the-engine/measurements.md`.
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
 * WHAT EACH TRANSACTION COSTS, to the wei — held against BOTH engines, because
 * two engines can agree on a price neither should have charged.
 *
 * Every line is `gasUsed * effectiveGasPrice` split three ways: the coinbase gets
 * `gasUsed * (effectiveGasPrice - 7)`, `gasUsed * 7` is burnt, and the recipient
 * gets the value. The battery checks that split as an identity too;
 * these literals are what say the INPUTS to it (the gas and the price) are the
 * ones the protocol charges here.
 */
const FEES = {
	// LEGACY UNDER A NON-ZERO BASE FEE — the task's worked example, and the case
	// the engines' own authors expect to disagree on first: gasPrice 10 over a base
	// fee of 7 leaves a tip of 3, so an implementation answering "the base fee" (or
	// reading a `maxFeePerGas` a type-0 transaction has not got) is off by 3 wei per
	// gas in the sender's balance and in the coinbase's.
	legacyOverBaseFee: {
		type: '0',
		gasUsed: '21000',
		effectiveGasPrice: '10',
		value: '1000',
		senderPaid: '211000',
		recipientReceived: '1000',
		coinbaseCredited: '63000',
		burnt: '147000',
	},
	// EIP-2930: 21,000 + 2,400 for the access-list address + 1,900 for its storage
	// key, priced at 11 with a tip of 4.
	access2930: {
		type: '1',
		gasUsed: '25300',
		effectiveGasPrice: '11',
		value: '500',
		senderPaid: '278800',
		recipientReceived: '500',
		coinbaseCredited: '101200',
		burnt: '177100',
	},
	// EIP-1559 CAPPED BY `maxFeePerGas`: the tip ASKED for is 5 and the cap allows
	// 2, so the effective price is 9 rather than 12 — `min(maxFee, baseFee + tip)`,
	// the branch a legacy-shaped implementation gets wrong in the other direction.
	fee1559Capped: {
		type: '2',
		gasUsed: '21000',
		effectiveGasPrice: '9',
		value: '250',
		senderPaid: '189250',
		recipientReceived: '250',
		coinbaseCredited: '42000',
		burnt: '147000',
	},
	// EIP-1559 CAPPED BY THE TIP: the same money as the legacy case above, through
	// a different transaction type. The charge follows the FEE FIELDS, not the type.
	fee1559Tip: {
		type: '2',
		gasUsed: '21000',
		effectiveGasPrice: '10',
		value: '1000',
		senderPaid: '211000',
		recipientReceived: '1000',
		coinbaseCredited: '63000',
		burnt: '147000',
	},
	// A ZERO PRIORITY FEE: the effective price IS the base fee, the coinbase is
	// credited nothing, and the whole fee is burnt.
	zeroTipCoinbase: {
		type: '2',
		gasUsed: '21000',
		effectiveGasPrice: '7',
		value: '1',
		senderPaid: '147001',
		recipientReceived: '1',
		coinbaseCredited: '0',
		burnt: '147000',
	},
	// A STORAGE-CLEARING REFUND, PRICED AT THE EFFECTIVE GAS PRICE. Gross 26,006
	// (21,000 + two PUSHes + a 5,000 cold non-zero SSTORE) less the 4,800 EIP-3529
	// clearing refund = 21,206 NET, and the sender pays that NET figure at 10 wei
	// per gas. A refund valued at the base fee instead would leave the sender
	// 14,400 wei better off (4,800 * the tip of 3) with every receipt field still
	// reading correctly.
	refundClear: {
		type: '0',
		gasUsed: '21206',
		effectiveGasPrice: '10',
		value: '0',
		senderPaid: '212060',
		recipientReceived: '0',
		coinbaseCredited: '63618',
		burnt: '148442',
	},
	// ...THE SAME CALL AGAINST THE NOW-ZERO SLOT: no clear, no refund, and 2,000
	// gas MORE than the transaction above. This is what says the refund really
	// happened rather than the clearing call simply costing what it costs.
	refundNoop: {
		type: '0',
		gasUsed: '23206',
		effectiveGasPrice: '10',
		value: '0',
		senderPaid: '232060',
		recipientReceived: '0',
		coinbaseCredited: '69618',
		burnt: '162442',
	},
} as const;

test('revm fees: sender charged, coinbase credited and base fee burnt exactly as @ethereumjs/vm, for legacy, 2930, 1559 and a storage-clearing refund', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The bundler-resolved wasm delivery shape, as in `revm-post-state.spec.ts`.
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'fees'}});

	console.log('\n[revm-fees] errors:', r.errors);
	const c = r.results.revmFees as Record<string, any>;
	console.log('[revm-fees]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// The battery really ran the two engines against each other, and not one engine
	// against itself — the failure mode that would make every assertion below pass
	// while measuring nothing.
	expect(c.referenceEngineId).toBe('@ethereumjs/evm');
	expect(c.engineId).toBe('revm-wasm');
	expect(c.baseFee).toBe('7');

	// 1) THE DIFFERENTIAL: the same transaction moved the same wei on both engines,
	// for every case. `mismatches` names `case.field` with both values, so a failure
	// says which case broke rather than "not equal".
	expect(c.mismatches).toEqual([]);

	// 2) THE ARITHMETIC CLOSES, on each engine independently: the sender was charged
	// `value + gasUsed * effectiveGasPrice`, the coinbase credited
	// `gasUsed * (effectiveGasPrice - baseFee)`, `gasUsed * baseFee` left the total
	// supply, and the three add up to exactly what the sender paid. These are
	// checked against the receipt's OWN numbers, so a violation means the money and
	// the receipt disagree — which is the bug a receipt-field diff cannot see.
	expect(c.violations).toEqual([]);

	// 3) ...AND THE ABSOLUTE STATEMENT, on BOTH engines, because two engines can
	// agree on a price neither should have charged.
	expect(c.money.underTest).toEqual(FEES);
	expect(c.money.reference).toEqual(FEES);

	// 4) THE ZERO-TIP COINBASE VANISHES, ON BOTH ENGINES, AND THAT IS CORRECT.
	// Credited nothing, the block's own beneficiary ends the transaction
	// touched-and-empty and EIP-161 deletes it; `@ethereumjs/vm` does exactly the
	// same. The TIPPED case above is the control that makes the absence mean
	// "credited nothing" rather than "never written". Do not "fix" it.
	expect(c.coinbaseInDump.tipped).toEqual({reference: true, underTest: true});
	expect(c.coinbaseInDump.zeroTip).toEqual({
		reference: false,
		underTest: false,
	});

	// 5) THE REFUND IS LOAD-BEARING: the clearing transaction cost 2,000 gas LESS
	// than the identical call against an already-zero slot. Without this, every
	// assertion about "a refund priced at the effective gas price" would hold on a
	// transaction that was never refunded anything.
	expect(
		BigInt(FEES.refundNoop.gasUsed) - BigInt(FEES.refundClear.gasUsed),
	).toBe(2000n);
	expect(BigInt(c.money.underTest.refundClear.gasUsed)).toBeLessThan(
		BigInt(c.money.underTest.refundNoop.gasUsed),
	);

	await h.dispose();
});
