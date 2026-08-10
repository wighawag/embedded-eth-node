/**
 * fees.ts — THE MONEY DIFFERENTIAL: what a transaction COSTS, measured on
 * BALANCES rather than on the receipt, and diffed between the engine under test
 * and `@ethereumjs/vm`.
 *
 * WHY BALANCES AND NOT `effectiveGasPrice`. A receipt can carry exactly the right
 * `effectiveGasPrice` while the wrong amount left the sender — the number and the
 * charge are produced at different moments, and only one of them is what a
 * consumer's ether actually did. The cross-backend gate in `packages/benchmarks`
 * cannot see this class of bug at all (it compares EXECUTION gas), and neither
 * can a receipt-field diff. So every case below reads three balances before and
 * after ONE transaction and asserts the three flows a transaction really has:
 *
 *   * the SENDER is charged `value + gasUsed * effectiveGasPrice`;
 *   * the COINBASE is credited the PRIORITY portion, `gasUsed * (effectiveGasPrice
 *     - baseFee)`;
 *   * `gasUsed * baseFee` is BURNT — measured as the drop in TOTAL SUPPLY over
 *     every account in `dumpState`, so money that appeared at a fourth address
 *     would show up here rather than being invisible.
 *
 * ...and the four together must CLOSE: what left the sender is exactly what the
 * recipient, the coinbase and the fire received. That closure is the one
 * assertion no single-address reading can fake.
 *
 * WHAT THE REFERENCE IS. A node built on the DEFAULT engine, which is
 * `@ethereumjs/vm`'s `runTx` — the EVM that charges the transaction — reached
 * through the same node code as the engine under test, so the only difference
 * between the two chains is which EVM took the money. Engine-parameterised
 * exactly like ./post-state.ts and ./conformance.ts, and for the same reason: the
 * revm engine faces the bar the default engine already meets, rather than a
 * softer one of its own.
 *
 * AND THE ABSOLUTE STATEMENT ALONGSIDE IT. Two engines can agree on a price
 * neither should have charged, so `test/revm-fees.spec.ts` pins every number
 * below as a literal and holds BOTH engines to it. That is also why the base fee
 * here is SEVEN wei rather than a gwei: the whole battery is arithmetic a reader
 * can do in their head, and it is the task's own worked example — a 1,000 wei
 * transfer at 21,000 gas and an effective price of 10 charges the sender 211,000,
 * credits the coinbase 63,000 and burns 147,000.
 *
 * ## The cases, and why these
 *
 *  1. **LEGACY UNDER A NON-ZERO BASE FEE** (`gasPrice` 10, base fee 7). Named
 *     first because it is where the engines' own authors expect the first
 *     disagreement: a type-0 transaction has no `maxFeePerGas` at all, so an
 *     implementation that reaches for `min(maxFee, baseFee + tip)` reads
 *     `undefined` — and a battery that only ever signs legacy transactions AT the
 *     base fee (tip zero) cannot tell the two apart, because both answers are
 *     then the base fee.
 *  2. **EIP-2930** (type 1, an access list, `gasPrice` 11). The access list is
 *     charged (2,400 for the address, 1,900 for the key) and the money is priced
 *     off that larger `gasUsed`.
 *  3. **EIP-1559 CAPPED BY `maxFeePerGas`** (max 9, tip ask 5, base fee 7): the
 *     effective price is 9, not 12 — the `min` branch, and the one a legacy-shaped
 *     implementation gets wrong in the other direction.
 *  4. **EIP-1559 CAPPED BY THE TIP** (max 100, tip 3): the same money as case 1
 *     through a completely different transaction type, which is what says the
 *     price follows the fee fields rather than the type.
 *  5. **A ZERO PRIORITY FEE**: the coinbase is credited NOTHING, ends the
 *     transaction touched-and-empty, and is DELETED under EIP-161 — on both
 *     engines, and it is correct. Case 1 is its positive control: with a tip, the
 *     same coinbase IS in the dump, so "absent" means "credited nothing" rather
 *     than "never written".
 *  6. **A STORAGE-CLEARING REFUND**, priced at the EFFECTIVE gas price. This is
 *     the case that catches a version pricing refunds any other way: the sender
 *     pays `netGasUsed * effectiveGasPrice`, so a refund valued at the BASE fee
 *     (or credited to the wrong flow) leaves the sender's balance short by
 *     `refund * tip` while every receipt field still reads correctly. It runs TWO
 *     transactions on one pair of nodes — the same call against a NON-ZERO slot
 *     and then against the now-zero one — because the second is what proves a
 *     refund happened at all: without one, the identical call costs 2,000 gas
 *     MORE.
 *
 * Each case gets a FRESH pair of nodes (except case 6, whose second transaction
 * needs the first one's state), so a case's balance deltas are the whole of what
 * that one transaction did and nothing accumulates across cases.
 */
import {
	createNode,
	type GenesisAccount,
	type SlimNode,
} from '../../src/index.js';
import type {EngineFactory} from './conformance.js';
import {createAccountFromRLP, hexToBytes} from '@ethereumjs/util';
import type {PrefixedHexString} from '@ethereumjs/util';
import {privateKeyToAccount} from 'viem/accounts';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);

/**
 * SEVEN WEI. The node's default base fee is a gwei, which makes every figure in
 * this battery a 14-digit number nobody can check by eye. Seven is the task's own
 * worked example, it is not a round number (so a term dropped from the arithmetic
 * does not accidentally still balance), and it is what turns the assertions into
 * numbers a reader verifies without a calculator.
 */
const BASE_FEE = 7n;
const GENESIS_BALANCE = 10n ** 18n;
/** A distinctive coinbase, never confusable with the zero address. */
const COINBASE = '0x00000000000000000000000000000000c0173a5e';
/** Pinned, so the two chains cannot drift on `Date.now()`. */
const TIMESTAMP = 1_700_000_000n;
/** A plain codeless recipient: it receives the value and nothing else. */
const RECIPIENT = '0x00000000000000000000000000000000000000aa';

/**
 * The refund fixture: runtime code that writes ZERO to slot 7 and stops —
 * `PUSH1 00, PUSH1 07, SSTORE, STOP` (`SSTORE` pops the key first, so the value
 * is pushed first). Six bytes, hand-written for the same reason as ./post-state.ts's
 * fixtures: it must reach ONE thing (a storage clear) and drag no dispatcher,
 * memory layout or metadata hash through the gas figures.
 */
const CLEARER = '0x0000000000000000000000000000000000007777';
const CLEARER_CODE = '0x600060075500';
const CLEARED_SLOT = '0x7';
/** Non-zero, so the first call CLEARS it (4,800 refund) and the second does not. */
const CLEARED_VALUE = `0x${'00'.repeat(31)}2a`;

/** Everything one transaction did to the money, in wei, as decimal strings. */
export interface MoneyReading {
	/** The receipt's EIP-2718 type, so a case cannot silently sign the wrong one. */
	type: string;
	gasUsed: string;
	/** What the ENGINE says it charged per gas. */
	effectiveGasPrice: string;
	value: string;
	/** Sender balance before minus after: the whole cost of the transaction. */
	senderPaid: string;
	recipientReceived: string;
	coinbaseCredited: string;
	/** The drop in TOTAL SUPPLY across every account in `dumpState`. */
	burnt: string;
}

export interface FeesReport {
	referenceEngineId: string;
	engineId: string;
	baseFee: string;
	/** Every case/field the two engines disagreed about. Empty = the same money. */
	mismatches: string[];
	/** Every arithmetic identity that failed, per engine. Empty = the money adds up. */
	violations: string[];
	money: {
		reference: Record<string, MoneyReading>;
		underTest: Record<string, MoneyReading>;
	};
	/**
	 * The coinbase in `dumpState` after a TIPPED transaction (present) and after a
	 * ZERO-TIP one (absent, deleted under EIP-161) — on both engines.
	 */
	coinbaseInDump: {
		tipped: {reference: boolean; underTest: boolean};
		zeroTip: {reference: boolean; underTest: boolean};
	};
}

interface Pair {
	reference: SlimNode;
	underTest: SlimNode;
}

async function buildNode(
	makeEngine: EngineFactory | undefined,
	initialState?: Record<string, GenesisAccount>,
): Promise<SlimNode> {
	return createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: GENESIS_BALANCE},
		...(initialState ? {initialState} : {}),
		// The base fee is the node's, constant per block, and SMALL — see BASE_FEE.
		baseFeePerGas: BASE_FEE,
		blockEnv: {coinbase: COINBASE, timestamp: TIMESTAMP},
		engine: makeEngine ? await makeEngine() : undefined,
	});
}

async function buildPair(
	makeEngine: EngineFactory,
	initialState?: Record<string, GenesisAccount>,
): Promise<Pair> {
	return {
		reference: await buildNode(undefined, initialState),
		underTest: await buildNode(makeEngine, initialState),
	};
}

async function balanceOf(node: SlimNode, address: string): Promise<bigint> {
	return BigInt(
		(await node.request({
			method: 'eth_getBalance',
			params: [address, 'latest'],
		})) as string,
	);
}

/**
 * EVERY WEI THE CHAIN HOLDS, summed over `dumpState`'s accounts.
 *
 * This is what makes "burnt" a MEASUREMENT rather than a subtraction: money paid
 * to a fourth address would leave the sender's charge unchanged and the supply
 * intact, so a burn inferred from the other three readings could not see it.
 * Accounts deleted under EIP-161 drop out of the dump holding zero, so they
 * cannot change the sum.
 */
async function totalSupply(node: SlimNode): Promise<bigint> {
	const dump = await node.dumpState();
	let sum = 0n;
	for (const rlp of Object.values(dump.accounts)) {
		sum += createAccountFromRLP(hexToBytes(rlp as PrefixedHexString)).balance;
	}
	return sum;
}

async function inDump(node: SlimNode, address: string): Promise<boolean> {
	return (await node.dumpState()).accounts[address.toLowerCase()] !== undefined;
}

/**
 * Send ONE signed transaction to both nodes as the SAME BYTES and report what it
 * did to the money on each.
 *
 * The transaction is signed ONCE, exactly as in ./post-state.ts: identical bytes
 * on both chains removes the last way the two could differ for a reason that is
 * not the engine.
 */
async function moneyOfTx(
	pair: Pair,
	raw: string,
	to: string,
	value: bigint,
): Promise<{reference: MoneyReading; underTest: MoneyReading}> {
	const readings: Record<string, MoneyReading> = {};
	for (const [label, node] of [
		['reference', pair.reference],
		['underTest', pair.underTest],
	] as const) {
		const senderBefore = await balanceOf(node, account.address);
		const recipientBefore = await balanceOf(node, to);
		const coinbaseBefore = await balanceOf(node, COINBASE);
		const supplyBefore = await totalSupply(node);
		const receipt = (await node.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		})) as Record<string, string>;
		readings[label] = {
			type: String(BigInt(receipt.type)),
			gasUsed: String(BigInt(receipt.gasUsed)),
			effectiveGasPrice: String(BigInt(receipt.effectiveGasPrice)),
			value: String(value),
			senderPaid: String(
				senderBefore - (await balanceOf(node, account.address)),
			),
			recipientReceived: String((await balanceOf(node, to)) - recipientBefore),
			coinbaseCredited: String(
				(await balanceOf(node, COINBASE)) - coinbaseBefore,
			),
			burnt: String(supplyBefore - (await totalSupply(node))),
		};
	}
	return {reference: readings.reference, underTest: readings.underTest};
}

/**
 * THE FIVE IDENTITIES, checked against the receipt's OWN `gasUsed` and
 * `effectiveGasPrice` — so a violation means the money and the receipt disagree
 * with each other, which is the bug a receipt-only assertion is blind to.
 *
 * The last one is the CLOSURE: everything that left the sender arrived somewhere,
 * and the recipient, the coinbase and the burn account for all of it between them.
 */
function identityViolations(
	where: string,
	m: MoneyReading,
	baseFee: bigint,
): string[] {
	const gasUsed = BigInt(m.gasUsed);
	const price = BigInt(m.effectiveGasPrice);
	const value = BigInt(m.value);
	const out: string[] = [];
	const check = (what: string, got: string, expected: bigint) => {
		if (got !== String(expected))
			out.push(`${where}.${what}: got ${got}, expected ${expected}`);
	};
	check('senderPaid', m.senderPaid, value + gasUsed * price);
	check('recipientReceived', m.recipientReceived, value);
	check('coinbaseCredited', m.coinbaseCredited, gasUsed * (price - baseFee));
	check('burnt', m.burnt, gasUsed * baseFee);
	check(
		'closure(sender == recipient + coinbase + burnt)',
		m.senderPaid,
		BigInt(m.recipientReceived) + BigInt(m.coinbaseCredited) + BigInt(m.burnt),
	);
	return out;
}

export async function runFeesChecks(params: {
	makeEngine: EngineFactory;
}): Promise<FeesReport> {
	const mismatches: string[] = [];
	const violations: string[] = [];
	const money: FeesReport['money'] = {reference: {}, underTest: {}};
	let referenceEngineId = '';
	let engineId = '';

	/** Record one case: diff the two engines, then check each one's arithmetic. */
	const record = (
		label: string,
		r: {reference: MoneyReading; underTest: MoneyReading},
	) => {
		for (const field of Object.keys(r.reference) as (keyof MoneyReading)[]) {
			if (r.reference[field] !== r.underTest[field])
				mismatches.push(
					`${label}.${field}: reference=${r.reference[field]} underTest=${r.underTest[field]}`,
				);
		}
		violations.push(
			...identityViolations(`${label}/reference`, r.reference, BASE_FEE),
		);
		violations.push(
			...identityViolations(`${label}/underTest`, r.underTest, BASE_FEE),
		);
		money.reference[label] = r.reference;
		money.underTest[label] = r.underTest;
	};

	/** One case, one fresh pair of nodes, one transaction. */
	const oneTxCase = async (
		label: string,
		raw: string,
		to: string,
		value: bigint,
	): Promise<Pair> => {
		const pair = await buildPair(params.makeEngine);
		referenceEngineId = pair.reference.engine.id;
		engineId = pair.underTest.engine.id;
		record(label, await moneyOfTx(pair, raw, to, value));
		return pair;
	};

	// ---- 1) LEGACY UNDER A NON-ZERO BASE FEE — the first disagreement ------
	// gasPrice 10 over a base fee of 7: the tip is 3, so an implementation that
	// answered "the base fee" (or reached for a `maxFeePerGas` a type-0 transaction
	// does not have) is off by 3 wei per gas in the sender's balance AND in the
	// coinbase's, which is exactly what a battery signing legacy transactions AT
	// the base fee cannot see.
	const legacyPair = await oneTxCase(
		'legacyOverBaseFee',
		await account.signTransaction({
			chainId: CHAIN_ID,
			type: 'legacy',
			nonce: 0,
			to: RECIPIENT,
			value: 1000n,
			gas: 21_000n,
			gasPrice: 10n,
		} as any),
		RECIPIENT,
		1000n,
	);
	// The POSITIVE CONTROL for case 5: a credited coinbase IS in the dump, so its
	// absence there means "credited nothing" rather than "never written".
	const coinbaseTipped = {
		reference: await inDump(legacyPair.reference, COINBASE),
		underTest: await inDump(legacyPair.underTest, COINBASE),
	};
	await legacyPair.reference.dispose();
	await legacyPair.underTest.dispose();

	// ---- 2) EIP-2930: the access list is charged, and the money follows it --
	const accessPair = await oneTxCase(
		'access2930',
		await account.signTransaction({
			chainId: CHAIN_ID,
			type: 'eip2930',
			nonce: 0,
			to: RECIPIENT,
			value: 500n,
			gas: 60_000n,
			gasPrice: 11n,
			accessList: [{address: RECIPIENT, storageKeys: [`0x${'00'.repeat(32)}`]}],
		} as any),
		RECIPIENT,
		500n,
	);
	await accessPair.reference.dispose();
	await accessPair.underTest.dispose();

	// ---- 3) EIP-1559 CAPPED BY `maxFeePerGas` ------------------------------
	// The tip ASKED for is 5 and the cap allows 2: `min(maxFee, baseFee + tip)` is
	// 9, not 12. An implementation that added the requested tip to the base fee
	// overcharges the sender and overpays the coinbase, and the receipt would say
	// so too — which is why this is asserted on the balances of both.
	const cappedPair = await oneTxCase(
		'fee1559Capped',
		await account.signTransaction({
			chainId: CHAIN_ID,
			type: 'eip1559',
			nonce: 0,
			to: RECIPIENT,
			value: 250n,
			gas: 21_000n,
			maxFeePerGas: 9n,
			maxPriorityFeePerGas: 5n,
		} as any),
		RECIPIENT,
		250n,
	);
	await cappedPair.reference.dispose();
	await cappedPair.underTest.dispose();

	// ---- 4) EIP-1559 CAPPED BY THE TIP -------------------------------------
	// Same money as case 1 (price 10, tip 3) through a type-2 transaction: the
	// charge follows the FEE FIELDS, not the transaction type.
	const tipPair = await oneTxCase(
		'fee1559Tip',
		await account.signTransaction({
			chainId: CHAIN_ID,
			type: 'eip1559',
			nonce: 0,
			to: RECIPIENT,
			value: 1000n,
			gas: 21_000n,
			maxFeePerGas: 100n,
			maxPriorityFeePerGas: 3n,
		} as any),
		RECIPIENT,
		1000n,
	);
	await tipPair.reference.dispose();
	await tipPair.underTest.dispose();

	// ---- 5) A ZERO PRIORITY FEE, and the coinbase that vanishes ------------
	// EXPECTED, ON BOTH ENGINES, AND NOT A BUG: credited nothing, the block's own
	// beneficiary ends the transaction touched-and-empty and EIP-161 deletes it.
	// The whole fee is burnt. Do not "fix" it.
	const zeroTipPair = await oneTxCase(
		'zeroTipCoinbase',
		await account.signTransaction({
			chainId: CHAIN_ID,
			type: 'eip1559',
			nonce: 0,
			to: RECIPIENT,
			value: 1n,
			gas: 21_000n,
			maxFeePerGas: 50n,
			maxPriorityFeePerGas: 0n,
		} as any),
		RECIPIENT,
		1n,
	);
	const coinbaseZeroTip = {
		reference: await inDump(zeroTipPair.reference, COINBASE),
		underTest: await inDump(zeroTipPair.underTest, COINBASE),
	};
	await zeroTipPair.reference.dispose();
	await zeroTipPair.underTest.dispose();

	// ---- 6) A STORAGE-CLEARING REFUND, priced at the EFFECTIVE gas price ----
	// Both transactions are legacy at gasPrice 10 over a base fee of 7, so the tip
	// is non-zero — which is the ONLY configuration in which mispricing a refund is
	// visible at all: at a zero tip the effective price IS the base fee and every
	// wrong answer coincides with the right one.
	const refundPair = await buildPair(params.makeEngine, {
		[CLEARER]: {code: CLEARER_CODE, storage: {[CLEARED_SLOT]: CLEARED_VALUE}},
	});
	referenceEngineId = refundPair.reference.engine.id;
	engineId = refundPair.underTest.engine.id;
	const clearingCall = (nonce: number) =>
		account.signTransaction({
			chainId: CHAIN_ID,
			type: 'legacy',
			nonce,
			to: CLEARER,
			value: 0n,
			gas: 100_000n,
			gasPrice: 10n,
		} as any);
	// The slot really holds something first, on both nodes: a refund case whose
	// slot was already zero would pass every identity below and measure nothing.
	for (const [label, node] of [
		['reference', refundPair.reference],
		['underTest', refundPair.underTest],
	] as const) {
		const before = (await node.request({
			method: 'eth_getStorageAt',
			params: [CLEARER, CLEARED_SLOT, 'latest'],
		})) as string;
		if (BigInt(before) === 0n)
			mismatches.push(
				`refundClear.setup(${label}): slot ${CLEARED_SLOT} was already zero, so nothing is cleared`,
			);
	}
	record(
		'refundClear',
		await moneyOfTx(refundPair, await clearingCall(0), CLEARER, 0n),
	);
	// ...and the SAME call again, now that the slot is zero: no clear, no refund,
	// and 2,000 gas MORE. That difference is what says a refund happened in the
	// transaction above rather than the two simply costing what they cost.
	record(
		'refundNoop',
		await moneyOfTx(refundPair, await clearingCall(1), CLEARER, 0n),
	);
	for (const [label, node] of [
		['reference', refundPair.reference],
		['underTest', refundPair.underTest],
	] as const) {
		const after = (await node.request({
			method: 'eth_getStorageAt',
			params: [CLEARER, CLEARED_SLOT, 'latest'],
		})) as string;
		if (BigInt(after) !== 0n)
			mismatches.push(
				`refundClear.result(${label}): slot ${CLEARED_SLOT} is ${after}, so it was never cleared`,
			);
	}
	await refundPair.reference.dispose();
	await refundPair.underTest.dispose();

	return {
		referenceEngineId,
		engineId,
		baseFee: String(BASE_FEE),
		mismatches,
		violations,
		money,
		coinbaseInDump: {tipped: coinbaseTipped, zeroTip: coinbaseZeroTip},
	};
}
