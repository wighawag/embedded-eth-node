/**
 * access-list.ts: EIP-2930, THE LIST IS CHARGED AND IT IS WARMED. Measured on
 * GAS, as the difference between the same transaction WITH the list and WITHOUT
 * it, on the engine under test AND on `@ethereumjs/vm`.
 *
 * ## Why a differential between two ENGINES is not the assertion here
 *
 * A mapping that DROPS the access list on the way to the engine is invisible to
 * every cross-engine comparison in this repo: the transaction then costs the same
 * (wrong) number on both engines, they agree perfectly, and the receipts and the
 * post-state are identical too: the list was never priced by either. The
 * assertion that catches it has to be ABSOLUTE, and it has to be a DIFFERENCE
 * against the same transaction carrying an EMPTY list:
 *
 *   * the list is CHARGED, 2,400 per address and 1,900 per storage key, up front,
 *     before the first opcode; and
 *   * the list is WARMED, so an access to a listed entry inside execution costs
 *     the EIP-2929 WARM price (100) rather than the cold one (2,600 for an
 *     account, 2,100 for a storage slot).
 *
 * Those two halves pull in OPPOSITE directions, which is what makes the arithmetic
 * diagnostic rather than merely different. For an entry the transaction really
 * touches, listing it costs 2,400/1,900 and saves 2,500/2,000, so the transaction
 * with the list is exactly **100 gas CHEAPER**. That number is unreachable by any
 * other combination: a dropped list gives a difference of 0, and a list that was
 * charged but never warmed gives +2,400 (or +1,900). The delta identifies WHICH
 * half broke.
 *
 * ## The cases, and why these three
 *
 *  1. **ADDRESS-ONLY, AND THE ADDRESS IS TOUCHED** (`addressTouched`). The callee
 *     runs `BALANCE` against a third address. Cold that access costs 2,600; listed,
 *     the transaction pays 2,400 and the access costs 100. `listed - cold = -100`.
 *     The list names NO storage keys, so this is the address term measured alone.
 *  2. **A STORAGE KEY, AND THE KEY IS READ** (`keyTouched`). The callee `SLOAD`s
 *     its own slot 7. THREE arms, because the address term and the key term have to
 *     be separated: an access list naming the callee is charged 2,400 for an
 *     address that was ALREADY warm (a transaction's `to` is pre-warmed by
 *     EIP-2929), so it buys nothing: `addressOnly - none = +2400`, the shape of a
 *     charge with no warming. Add the key to that same entry and the SLOAD goes
 *     warm: `addressAndKey - addressOnly = -100`, the key term measured alone,
 *     against an arm that already paid the address term.
 *  3. **ENTRIES THAT ARE NEVER TOUCHED** (`untouched`). A plain value transfer to a
 *     codeless recipient, with a list naming an address the transaction never
 *     mentions and two storage keys nobody reads. It is charged in full and buys
 *     NOTHING: `listed - none = +6200` (2,400 + 2 * 1,900), exactly. This is the
 *     shape where a dropped list is invisible by every other measure: no access
 *     inside execution changes price, no state moves, the receipt is otherwise
 *     identical, so the gas is the only witness there is. It also pins that a
 *     LISTED address is WARMED, NOT TOUCHED: the address is absent from
 *     `dumpState` afterwards, i.e. naming an account in an access list does not
 *     bring it into existence.
 *
 * Every arm is a type-1 (EIP-2930) transaction, including the "without" arms,
 * which carry an EMPTY access list rather than being a different transaction type.
 * The only difference between the two arms of a case is the list itself, so the
 * gas difference cannot be a difference of transaction envelope.
 *
 * ## ...and `eth_estimateGas`, which has to survive its own advice
 *
 * The node refuses a transaction whose gas limit is below the intrinsic floor and
 * tells the caller that `eth_estimateGas` reports what a transaction needs
 * (`refuseIfBelowIntrinsicGas` in `src/node.ts`). For a type-1 transaction that
 * advice is only true if the estimate CHARGES THE LIST, so this battery closes the
 * loop rather than asserting a number: it estimates the `untouched` transaction
 * WITH its access list, signs a real transaction at exactly that gas limit, and
 * requires it to MINE. An estimate that ignored the list hands back 21,000 for a
 * transaction whose floor is 27,200, and the node refuses its own advice.
 *
 * The estimate is measured for the `addressTouched` case too, and it is HIGHER
 * than what that transaction actually used: a read carries no access list to the
 * engine, so the `BALANCE` inside it is priced COLD while the mined transaction
 * pays the warm price. Over-estimating is the safe direction (a client uses the
 * estimate as its gas limit) and the figure is pinned so it is a stated,
 * measured property rather than a surprise (see the `accessListGas` JSDoc in
 * `src/intrinsic-gas.ts`).
 *
 * ## That this battery can go RED is measured, not assumed
 *
 * Two mutations, each with the run it produced, in
 * `docs/spikes/eip-2930-access-lists-are-charged-and-warmed/measurements.md`: the
 * revm engine dropping the list on the way to `ExecuteOptions` (caught by the
 * absolute pins AND by the cross-engine diff, since only one engine was mutated),
 * and the battery signing every "listed" arm with an EMPTY list, which is what a
 * node that dropped the list on BOTH engines looks like from outside. The second
 * one reports `mismatches: []`, identical receipts and an identical post-state
 * beside seven wrong gas figures, and it is the reason the assertions here are
 * absolute rather than differential.
 *
 * ## The reference, and one pair of nodes
 *
 * A node on the DEFAULT engine (`@ethereumjs/vm`'s `runTx`), reached through the
 * same node code, exactly as in ./fees.ts and ./post-state.ts. The only
 * difference between the two chains is which EVM charged the transaction. Both
 * engines are then held to the SAME pinned literals in the spec, because two
 * engines can agree on a price neither should have charged.
 *
 * ONE pair of nodes serves every case (unlike ./fees.ts, which needs a fresh pair
 * per case so a balance delta is the whole of what one transaction did): what is
 * read here is per-transaction gas, and EIP-2929 warmth does NOT survive a
 * transaction: the accessed-address and accessed-key sets are reset at the start
 * of each one. If it did survive, the second arm of every case would be warm
 * before it started and every difference below would be zero.
 */
import {
	createNode,
	type GenesisAccount,
	type SlimNode,
} from '../../src/index.js';
import type {EngineFactory} from './conformance.js';
import {privateKeyToAccount} from 'viem/accounts';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
const GENESIS_BALANCE = 10n ** 18n;
/** Small, like ./fees.ts's, so every figure here is checkable by eye. */
const BASE_FEE = 7n;
const GAS_PRICE = 10n;
/** Pinned, so the two chains cannot drift on `Date.now()`. */
const TIMESTAMP = 1_700_000_000n;

/** A plain codeless recipient: it receives the value and nothing else. */
const RECIPIENT = '0x00000000000000000000000000000000000000aa';
/**
 * The account `BALANCE_PROBE` reads, and the only entry the `addressTouched` case
 * names. It is a plain funded account with no code: the point is the ACCESS, and a
 * balance read is the cheapest access to an address there is.
 */
const TOUCHED = '0x00000000000000000000000000000000000000bb';
/**
 * Named by the `untouched` case's list and mentioned by nothing else on either
 * chain, not funded, not called, not read. It must stay absent from `dumpState`:
 * an access list WARMS an entry, it does not create the account.
 */
const NEVER_TOUCHED = '0x00000000000000000000000000000000000000cc';

/**
 * `PUSH20 <TOUCHED>, BALANCE, POP, STOP`: 3 + the account access + 2 gas.
 *
 * Hand-written for the same reason as ./fees.ts's fixtures: it must reach exactly
 * ONE thing (a single cold-or-warm account access) and drag no dispatcher, memory
 * layout or metadata hash through the gas figures.
 */
const BALANCE_PROBE = '0x00000000000000000000000000000000000000b1';
const BALANCE_PROBE_CODE = `0x73${TOUCHED.slice(2)}315000`;

/**
 * `PUSH1 07, SLOAD, POP, STOP`: 3 + the storage access + 2 gas. Reads its OWN
 * slot 7, which is the storage an access-list key names.
 */
const SLOAD_PROBE = '0x00000000000000000000000000000000000000b2';
const SLOAD_PROBE_CODE = '0x6007545000';
const SLOAD_SLOT = '0x7';
/** Non-zero, so the slot really holds something. `SLOAD` costs the same either way. */
const SLOAD_VALUE = `0x${'00'.repeat(31)}2a`;
/** The same slot as a 32-byte access-list storage key. */
const SLOAD_KEY = `0x${'00'.repeat(31)}07`;
/** Two keys nobody reads, on an address nobody touches. */
const UNTOUCHED_KEYS = [`0x${'00'.repeat(32)}`, `0x${'00'.repeat(31)}01`];

const GENESIS_STATE: Record<string, GenesisAccount> = {
	[BALANCE_PROBE]: {code: BALANCE_PROBE_CODE},
	[SLOAD_PROBE]: {code: SLOAD_PROBE_CODE, storage: {[SLOAD_SLOT]: SLOAD_VALUE}},
	[TOUCHED]: {balance: 12345n},
};

/** What one transaction cost, and what kind of transaction it was. */
export interface GasReading {
	/** The receipt's EIP-2718 type: every arm here must be a type-1. */
	type: string;
	/** `1` on every arm: a case that reverted would measure a different program. */
	status: string;
	gasUsed: string;
}

export interface AccessListReport {
	referenceEngineId: string;
	engineId: string;
	/** Every case/field the two engines disagreed about. Empty = the same gas. */
	mismatches: string[];
	gas: {
		reference: Record<string, GasReading>;
		underTest: Record<string, GasReading>;
	};
	/** `eth_estimateGas`, per engine, for the requests named in the header. */
	estimates: {
		reference: Record<string, string>;
		underTest: Record<string, string>;
	};
	/**
	 * A listed-but-never-touched address is WARMED, not created: it must be absent
	 * from `dumpState` on both engines after the `untouched` transaction.
	 */
	neverTouchedInDump: {reference: boolean; underTest: boolean};
	/**
	 * THE ADVICE, TAKEN. `eth_estimateGas` for the `untouched` request WITH its
	 * access list, then a real type-1 transaction signed at exactly that gas limit:
	 * `mined 0x1` on both engines, or the node refused the number it just gave.
	 */
	atEstimatedGas: {
		reference: {gasLimit: string; outcome: string};
		underTest: {gasLimit: string; outcome: string};
	};
}

interface Pair {
	reference: SlimNode;
	underTest: SlimNode;
}

async function buildNode(makeEngine?: EngineFactory): Promise<SlimNode> {
	return createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: GENESIS_BALANCE},
		initialState: GENESIS_STATE,
		baseFeePerGas: BASE_FEE,
		blockEnv: {timestamp: TIMESTAMP},
		engine: makeEngine ? await makeEngine() : undefined,
	});
}

interface AccessListEntry {
	address: string;
	storageKeys: string[];
}

/**
 * One arm: a type-1 transaction, signed ONCE and sent to both nodes as the SAME
 * BYTES. Identical bytes on both chains removes the last way the two could differ
 * for a reason that is not the engine.
 */
async function sign2930(args: {
	nonce: number;
	to: string;
	value?: bigint;
	gas?: bigint;
	accessList: AccessListEntry[];
}): Promise<string> {
	return account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip2930',
		gasPrice: GAS_PRICE,
		value: 0n,
		gas: 100_000n,
		...args,
	} as any);
}

export async function runAccessListChecks(params: {
	makeEngine: EngineFactory;
}): Promise<AccessListReport> {
	const pair: Pair = {
		reference: await buildNode(),
		underTest: await buildNode(params.makeEngine),
	};
	const mismatches: string[] = [];
	const gas: AccessListReport['gas'] = {reference: {}, underTest: {}};
	const estimates: AccessListReport['estimates'] = {
		reference: {},
		underTest: {},
	};

	const engines = [
		['reference', pair.reference],
		['underTest', pair.underTest],
	] as const;

	/** Send one arm to both nodes and record what each charged for it. */
	const arm = async (label: string, raw: string): Promise<void> => {
		for (const [side, node] of engines) {
			const receipt = (await node.request({
				method: 'eth_sendRawTransactionSync',
				params: [raw],
			})) as Record<string, string>;
			gas[side][label] = {
				type: String(BigInt(receipt.type)),
				status: String(BigInt(receipt.status)),
				gasUsed: String(BigInt(receipt.gasUsed)),
			};
		}
		for (const field of Object.keys(
			gas.reference[label],
		) as (keyof GasReading)[])
			if (gas.reference[label][field] !== gas.underTest[label][field])
				mismatches.push(
					`${label}.${field}: reference=${gas.reference[label][field]} underTest=${gas.underTest[label][field]}`,
				);
	};

	/** `eth_estimateGas` on both nodes, recorded per engine. */
	const estimate = async (label: string, request: unknown): Promise<void> => {
		for (const [side, node] of engines) {
			estimates[side][label] = String(
				BigInt(
					(await node.request({
						method: 'eth_estimateGas',
						params: [request],
					})) as string,
				),
			);
		}
		if (estimates.reference[label] !== estimates.underTest[label])
			mismatches.push(
				`estimate.${label}: reference=${estimates.reference[label]} underTest=${estimates.underTest[label]}`,
			);
	};

	let nonce = 0;

	// ---- 1) ADDRESS-ONLY, AND THE ADDRESS IS TOUCHED -----------------------
	// `BALANCE(TOUCHED)` costs 2,600 cold and 100 warm; the list costs 2,400 and
	// names no keys. So listing it is 100 gas CHEAPER: charged AND warmed. A
	// dropped list would make these two arms identical.
	await arm(
		'addressTouched.cold',
		await sign2930({nonce: nonce++, to: BALANCE_PROBE, accessList: []}),
	);
	await arm(
		'addressTouched.listed',
		await sign2930({
			nonce: nonce++,
			to: BALANCE_PROBE,
			accessList: [{address: TOUCHED, storageKeys: []}],
		}),
	);

	// ---- 2) A STORAGE KEY, AND THE KEY IS READ ------------------------------
	// Three arms, because the address term must not be able to hide inside the key
	// term. The middle arm names the callee with NO keys: 2,400 for an address the
	// protocol had already warmed (a transaction's `to` is pre-warmed), so it is a
	// charge that buys nothing. The third adds the key to that same entry, and the
	// SLOAD goes from 2,100 to 100.
	await arm(
		'keyTouched.none',
		await sign2930({nonce: nonce++, to: SLOAD_PROBE, accessList: []}),
	);
	await arm(
		'keyTouched.addressOnly',
		await sign2930({
			nonce: nonce++,
			to: SLOAD_PROBE,
			accessList: [{address: SLOAD_PROBE, storageKeys: []}],
		}),
	);
	await arm(
		'keyTouched.addressAndKey',
		await sign2930({
			nonce: nonce++,
			to: SLOAD_PROBE,
			accessList: [{address: SLOAD_PROBE, storageKeys: [SLOAD_KEY]}],
		}),
	);

	// ---- 3) ENTRIES THAT ARE NEVER TOUCHED ---------------------------------
	// Charged in full, buys nothing: a plain transfer, plus 2,400 + 2 * 1,900 for a
	// list the transaction never mentions again. This is the shape where a dropped
	// list changes NOTHING a receipt, a post-state read or a cross-engine diff can
	// see. The gas is the only witness.
	const untouchedList = [{address: NEVER_TOUCHED, storageKeys: UNTOUCHED_KEYS}];
	await arm(
		'untouched.none',
		await sign2930({
			nonce: nonce++,
			to: RECIPIENT,
			value: 1n,
			accessList: [],
		}),
	);
	await arm(
		'untouched.listed',
		await sign2930({
			nonce: nonce++,
			to: RECIPIENT,
			value: 1n,
			accessList: untouchedList,
		}),
	);
	const neverTouchedInDump = {
		reference: await inDump(pair.reference, NEVER_TOUCHED),
		underTest: await inDump(pair.underTest, NEVER_TOUCHED),
	};

	// ---- 4) THE ESTIMATE, AND THE ADVICE THE REFUSAL GIVES ------------------
	// `eth_estimateGas` must charge a request's access list, or the node's own
	// intrinsic-gas refusal points the caller at a number the node would refuse
	// again. The no-list arm is the control: it is what says the difference between
	// the two estimates is the LIST rather than the request.
	const untouchedRequest = {
		from: account.address,
		to: RECIPIENT,
		value: '0x1',
	};
	await estimate('untouched.none', untouchedRequest);
	await estimate('untouched.listed', {
		...untouchedRequest,
		accessList: untouchedList,
	});
	// ...and the same for a request whose listed address IS touched, where the
	// estimate is deliberately HIGHER than the mined transaction's gas: a read
	// carries no access list to the engine, so the `BALANCE` is priced cold.
	await estimate('addressTouched.listed', {
		from: account.address,
		to: BALANCE_PROBE,
		accessList: [{address: TOUCHED, storageKeys: []}],
	});

	// THE ADVICE, TAKEN: sign the `untouched` transaction at exactly the gas limit
	// the node just recommended for it, and require it to mine.
	const atEstimatedGas = {
		reference: await sendAtGas(
			pair.reference,
			nonce,
			BigInt(estimates.reference['untouched.listed']),
			untouchedList,
		),
		underTest: await sendAtGas(
			pair.underTest,
			nonce,
			BigInt(estimates.underTest['untouched.listed']),
			untouchedList,
		),
	};
	nonce++;

	const report: AccessListReport = {
		referenceEngineId: pair.reference.engine.id,
		engineId: pair.underTest.engine.id,
		mismatches,
		gas,
		estimates,
		neverTouchedInDump,
		atEstimatedGas,
	};
	await pair.reference.dispose();
	await pair.underTest.dispose();
	return report;
}

async function inDump(node: SlimNode, address: string): Promise<boolean> {
	return (await node.dumpState()).accounts[address.toLowerCase()] !== undefined;
}

/**
 * Send the `untouched` transaction at a caller-chosen gas limit and report what
 * happened in one string: `mined 0x1`, or the refusal's own message, which is the
 * failure this exists to catch (`intrinsic gas too low: have 21000, want 27200`).
 */
async function sendAtGas(
	node: SlimNode,
	nonce: number,
	gasLimit: bigint,
	accessList: AccessListEntry[],
): Promise<{gasLimit: string; outcome: string}> {
	const raw = await sign2930({
		nonce,
		to: RECIPIENT,
		value: 1n,
		gas: gasLimit,
		accessList,
	});
	try {
		const rcpt = (await node.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		})) as Record<string, string> | null;
		return {
			gasLimit: String(gasLimit),
			outcome: `mined ${String(rcpt?.status)}`,
		};
	} catch (e) {
		return {
			gasLimit: String(gasLimit),
			outcome: `refused: ${String((e as Error)?.message ?? e)}`,
		};
	}
}
