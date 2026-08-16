/**
 * invalid-transactions.ts — WHAT THE NODE REFUSES, and what it leaves behind when
 * it does: four transactions a real node rejects, submitted through the node's
 * public transaction path on the engine under test AND on `@ethereumjs/vm`.
 *
 * THE FOUR CASES, and why these four. Each is a rule a real node enforces BEFORE
 * a transaction runs, and each is enforced by both engines in a completely
 * different vocabulary:
 *
 *  1. **A REPLAY** — a nonce the sender has already used. The reason nonces exist.
 *  2. **A FAR-FUTURE NONCE** — a gap this node will never fill, because it has no
 *     mempool to queue the transaction in.
 *  3. **AN UNAFFORDABLE TRANSACTION** — `value + gasLimit * maxFeePerGas` above
 *     the sender's balance. Note the MAX fee: the sender must be able to pay for
 *     the whole gas limit at the price it OFFERED, not at the price it will
 *     actually be charged. Both engines draw the line exactly there, to the wei
 *     (measured in
 *     `docs/spikes/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors/measurements.md`),
 *     so this case is issued twice: one wei over, and — as its control — the
 *     largest value that still mines.
 *  4. **A GAS LIMIT BELOW INTRINSIC GAS** — a transaction that could not pay to
 *     reach its first opcode.
 *
 * ## Three things are measured per case, and the second is the valuable one
 *
 * **IT FAILED** is the weakest half. A `catch` that counts throws would be
 * satisfied by a typo'd address, a node that failed to construct, or an engine
 * that threw for an unrelated reason.
 *
 * **NOTHING MOVED** is what a half-committed rejection would fail: every balance,
 * the sender's nonce, a STORAGE SLOT the transaction would have written, the
 * block number, the receipt, the stored transaction, and the block's own
 * transaction list. That is why every case here targets a contract that
 * INCREMENTS a slot rather than a codeless sink: a rejection that partly ran
 * leaves the slot one higher, and no balance reading would show it. The follow-up
 * transaction each case ends with pins the rest: the node still mines (so the
 * refusal was about the transaction, not about the node having broken), it mines
 * at the SAME nonce the refused transaction claimed (so no nonce was silently
 * spent), it lands in the NEXT block, and its receipt's `cumulativeGasUsed`
 * equals its own `gasUsed` — the refused transaction contributed no gas to the
 * block it never entered.
 *
 * **AND THE REFUSAL IS THE NODE'S OWN SENTENCE**, identical on both engines. The
 * engines disagree loudly here by nature: `@ethereumjs/vm` says `the tx doesn't
 * have the correct nonce. account has nonce of: 1 tx has nonce of: 0` followed by
 * a dump of the whole block and transaction, and revm says
 * `Transaction(NonceTooLow { tx: 0, state: 1 })`. Neither is something to hand a
 * client. So each case checks: the JSON-RPC code, that the error carries NO
 * `data` (nothing executed, so there is no callee answer, and `data` on an RPC
 * error means exactly that to a client — the mistake recorded in the
 * `rejectionMessage` JSDoc of `src/revm.ts`), that the cause and its NUMBERS are
 * named, that no engine-shaped text appears in it at all, and — the assertion
 * that ties those together — that the two engines produce the SAME message,
 * character for character.
 *
 * ## The reference, and why the statement is absolute anyway
 *
 * The reference is a node on the DEFAULT engine reached through the same node
 * code, exactly as in ./fees.ts and ./post-state.ts. But agreeing with each other
 * is not enough: two engines can both mine a transaction neither should have
 * mined. So `test/revm-invalid-transactions.spec.ts` pins every reading below as
 * a literal and holds BOTH engines to it, the shape ./conformance.ts's
 * value-bearing steps established.
 *
 * ## The last case: the nonce check, asserted from OUTSIDE
 *
 * Nonce checking is chosen BY THE CALL PATH — a transaction checks, a read does
 * not — and never by a caller-supplied parameter (story 10 of
 * `work/specs/tasked/revm-engine-behind-runtx.md`). At the seam that is asserted
 * on the options each engine passes (./revm-engine.ts). Here it is asserted from
 * the OUTSIDE, on one node whose on-chain nonce is 5: the READ path answers the
 * identical call, the transaction path REFUSES nonce 99, and the transaction path
 * MINES nonce 5. The third leg is what makes the first two a statement about the
 * nonce rather than about the node being broken.
 */
import {
	createNode,
	type GenesisAccount,
	type SlimNode,
} from '../../src/index.js';
import type {EngineFactory} from './conformance.js';
import {privateKeyToAccount} from 'viem/accounts';
import {keccak256} from 'viem';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);

/** Small, so every figure in the report is arithmetic a reader can check by eye. */
const BASE_FEE = 7n;
const MAX_FEE = 10n;
const TIP = 1n;
const GENESIS_BALANCE = 10n ** 18n;
/** A distinctive coinbase, never confusable with the zero address. */
const COINBASE = '0x00000000000000000000000000000000c0173a5e';
/** Pinned, so the two chains cannot drift on `Date.now()`. */
const TIMESTAMP = 1_700_000_000n;

/**
 * THE TARGET IS A STORAGE WRITER, not a codeless sink, and that is the point:
 * `PUSH1 07, SLOAD, PUSH1 01, ADD, PUSH1 07, SSTORE, STOP` increments slot 7 on
 * every call. A rejection that half-ran leaves the slot one higher than the
 * transactions actually mined, which no balance reading would show. Hand-written
 * for the same reason as ./fees.ts's fixtures: it must reach ONE thing and drag
 * no dispatcher or metadata hash through the figures.
 */
const COUNTER = '0x0000000000000000000000000000000000007777';
const COUNTER_CODE = '0x60075460010160075500';
const COUNTED_SLOT = '0x7';
/** Comfortably above the cold-SSTORE cost, and nowhere near the block limit. */
const TX_GAS = 100_000n;
/** What a transaction must be able to pay for BEFORE it runs, at the MAX fee. */
const UPFRONT_FEE = TX_GAS * MAX_FEE;

const GENESIS: Record<string, GenesisAccount> = {
	[COUNTER]: {code: COUNTER_CODE},
};

/**
 * Every reading a refused transaction must leave UNTOUCHED, in one object, so the
 * report can name exactly which of them moved.
 */
interface StateReading {
	blockNumber: string;
	senderNonce: string;
	senderBalance: string;
	counterBalance: string;
	coinbaseBalance: string;
	counterSlot: string;
}

/** One case: what the refusal said, and what it left behind. */
export interface RefusalReading {
	/** `refused`, or `mined <status>` if the node executed it after all. */
	outcome: string;
	/** The JSON-RPC error code the caller saw. */
	code: string;
	/**
	 * Whether the error carried a `data` field. It must not: nothing executed, so
	 * there is no callee answer, and `data` on an RPC error means exactly that to
	 * a client.
	 */
	hasData: string;
	/** The cause, named in the node's own vocabulary — or the refusal, verbatim. */
	namesCause: string;
	/** The numbers behind the cause — or the refusal, verbatim. */
	namesNumbers: string;
	/** `engine-independent`, or the engine-shaped fragment found in the message. */
	engineIndependent: string;
	/** The whole refusal, so the two engines can be diffed on it. */
	message: string;
	/** Which state readings changed across the refusal. `NOTHING` is the bar. */
	moved: string;
	/** `none`, or the receipt the refused transaction should not have. */
	receipt: string;
	/** `none`, or the stored transaction it should not have. */
	transaction: string;
	/** `no`, or the block whose transaction list contains its hash. */
	inABlock: string;
	/** The follow-up transaction, at the nonce the refused one claimed. */
	recovered: string;
	/** Blocks mined across the refusal and the follow-up. Exactly one. */
	blocksMined: string;
	/** The follow-up receipt's `cumulativeGasUsed`, against its own `gasUsed`. */
	cumulativeGasUsed: string;
	/** Slot 7 after the follow-up: the transactions that mined, and nothing else. */
	counterSlotAfter: string;
	/**
	 * THE CONTROL UNDER `receipt`, `transaction` AND `inABlock`: the FOLLOW-UP
	 * transaction, looked up by a hash computed the very same way, IS found — in the
	 * receipt store and in its block's transaction list. Without it, a hash computed
	 * wrongly would report the refused transaction as absent from everything and the
	 * three readings above would pass while measuring nothing.
	 */
	lookupByHashWorks: string;
}

/** The three legs of the nonce asymmetry, on one node at on-chain nonce 5. */
export interface NonceCheckReading {
	onChainNonce: string;
	/** The identical call through the READ path, which checks no nonce. */
	read: string;
	/** The same sender and target, as a transaction at a far-future nonce. */
	txAtFutureNonce: string;
	/** ...and at the nonce the chain is actually at. */
	txAtCorrectNonce: string;
}

/** The wei-exact positive control under the `unaffordableByOneWei` case. */
export interface AffordableReading {
	/** The largest value this sender can afford, given the fee it offered. */
	value: string;
	outcome: string;
	/** The slot the transaction incremented: it really ran. */
	counterSlot: string;
}

export interface InvalidTxReport {
	referenceEngineId: string;
	engineId: string;
	/** Every case/field the two engines disagreed about. Empty = one answer. */
	mismatches: string[];
	refusals: {
		reference: Record<string, RefusalReading>;
		underTest: Record<string, RefusalReading>;
	};
	affordableToTheWei: {
		reference: AffordableReading;
		underTest: AffordableReading;
	};
	/**
	 * The nonce check, from outside: the read path does not check it, the
	 * transaction path does, and the correct nonce still mines.
	 */
	nonceCheck: {reference: NonceCheckReading; underTest: NonceCheckReading};
}

async function buildNode(makeEngine: EngineFactory | undefined) {
	return createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: GENESIS_BALANCE},
		initialState: GENESIS,
		baseFeePerGas: BASE_FEE,
		blockEnv: {coinbase: COINBASE, timestamp: TIMESTAMP},
		engine: makeEngine ? await makeEngine() : undefined,
	});
}

/**
 * ONE SIGNED TRANSACTION, defaulting to the EIP-1559 shape every case but one
 * uses. `type: 'eip2930'` switches the fee fields to the legacy pair rather than
 * merely adding a field, because the two families are mutually exclusive on the
 * wire and mixing them is a signing error, not a transaction.
 */
const sign = (tx: Record<string, unknown>): Promise<string> => {
	const type = (tx.type as string) ?? 'eip1559';
	return account.signTransaction({
		chainId: CHAIN_ID,
		gas: TX_GAS,
		to: COUNTER,
		value: 0n,
		...(type === 'eip1559'
			? {maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: TIP}
			: {gasPrice: MAX_FEE}),
		...tx,
		type,
	} as any);
};

/**
 * The transaction's hash, computed from its BYTES rather than asked of the node —
 * which is the whole point here, since the node must not have stored it. A typed
 * (EIP-2718) transaction hashes as `keccak256(type || payload)`, i.e. exactly the
 * bytes that go on the wire.
 */
const hashOf = (raw: string) => keccak256(raw as `0x${string}`);

async function readState(node: SlimNode): Promise<StateReading> {
	const dec = async (method: string, params: unknown[]) =>
		String(BigInt((await node.request({method, params})) as string));
	return {
		blockNumber: await dec('eth_blockNumber', []),
		senderNonce: await dec('eth_getTransactionCount', [
			account.address,
			'latest',
		]),
		senderBalance: await dec('eth_getBalance', [account.address, 'latest']),
		counterBalance: await dec('eth_getBalance', [COUNTER, 'latest']),
		coinbaseBalance: await dec('eth_getBalance', [COINBASE, 'latest']),
		counterSlot: await dec('eth_getStorageAt', [
			COUNTER,
			COUNTED_SLOT,
			'latest',
		]),
	};
}

/** One submission: the receipt's status, or the refusal, classified. */
async function send(node: SlimNode, raw: string) {
	try {
		const rcpt = (await node.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		})) as Record<string, string> | null;
		return {
			outcome: `mined ${String(rcpt?.status)}`,
			code: '',
			hasData: '',
			message: '',
			receipt: rcpt,
		};
	} catch (e) {
		const err = e as {code?: unknown; data?: unknown; message?: string};
		return {
			outcome: 'refused',
			code: String(err?.code),
			hasData: String(err?.data !== undefined),
			message: String(err?.message ?? e),
			receipt: null,
		};
	}
}

/**
 * A phrase the refusal must contain, reported AS THE REFUSAL when it does not:
 * `false` says nothing about what came back instead, which is the one thing a
 * reader of the mismatch needs. Same device as ./conformance.ts's block-gas-limit
 * step.
 */
function names(text: string, ...words: string[]): string {
	const missing = words.filter((w) => !text.includes(w));
	return missing.length === 0
		? 'named'
		: `NOT named (${missing.join(' | ')}), refusal was: ${text}`;
}

/**
 * THE ENGINE-SHAPED FRAGMENTS that must not reach a caller.
 *
 * `Transaction(` opens every `InvalidTransaction` variant revm renders
 * (`Transaction(NonceTooLow { tx: 0, state: 1 })`); `vm hf=` opens the block +
 * transaction dump `@ethereumjs/vm` appends to every `runTx` error;
 * `INTRINSIC_GAS_TOO_LOW` is that engine's own screaming-case code; and either
 * engine's NAME would tell a caller which EVM refused, which is precisely what
 * they must not have to care about. A refusal containing none of them is one the
 * node wrote itself.
 */
const ENGINE_SHAPED = [
	'Transaction(',
	'vm hf=',
	'revm',
	'INTRINSIC_GAS_TOO_LOW',
	'@ethereumjs',
];

function engineIndependent(text: string): string {
	const found = ENGINE_SHAPED.filter((f) => text.includes(f));
	return found.length === 0
		? 'engine-independent'
		: `engine text leaked (${found.join(' | ')}): ${text}`;
}

/** What one case needs to say about itself. */
interface Case {
	label: string;
	/** Transactions mined first, so the refusal has the state it needs. */
	setup: number[];
	/** The transaction that must be refused. */
	invalid: Record<string, unknown>;
	/** The cause phrase first, then the numbers the refusal must name. */
	expects: [cause: string, ...numbers: string[]];
	/** The nonce the follow-up uses: the one the refused transaction claimed. */
	recoverNonce: number;
}

/**
 * Run ONE case on ONE node: mine the setup, submit the invalid transaction, read
 * everything it must not have changed, then prove the node still mines.
 */
async function runCase(node: SlimNode, c: Case): Promise<RefusalReading> {
	for (const nonce of c.setup) await send(node, await sign({nonce}));
	const raw = await sign(c.invalid);
	const hash = hashOf(raw);
	const before = await readState(node);
	const r = await send(node, raw);
	const after = await readState(node);
	const moved = (Object.keys(before) as (keyof StateReading)[]).filter(
		(k) => before[k] !== after[k],
	);
	const receipt = await node.request({
		method: 'eth_getTransactionReceipt',
		params: [hash],
	});
	const transaction = await node.request({
		method: 'eth_getTransactionByHash',
		params: [hash],
	});
	const head = (await node.request({
		method: 'eth_getBlockByNumber',
		params: ['latest', false],
	})) as {transactions: string[]; number: string};

	// THE POSITIVE CONTROL, at the very nonce the refused transaction claimed: the
	// node still mines, nothing was silently consumed, and the block it lands in is
	// the NEXT one.
	const recoveredRaw = await sign({nonce: c.recoverNonce});
	const recoveredHash = hashOf(recoveredRaw);
	const recovered = await send(node, recoveredRaw);
	const afterRecovery = await readState(node);
	// ...and the three absences above are absences, not a mis-computed hash: the
	// SAME hashing finds the transaction that did mine, in both places the refused
	// one was looked for.
	const recoveredReceipt = await node.request({
		method: 'eth_getTransactionReceipt',
		params: [recoveredHash],
	});
	const recoveredHead = (await node.request({
		method: 'eth_getBlockByNumber',
		params: ['latest', false],
	})) as {transactions: string[]};

	return {
		outcome: r.outcome,
		code: r.code,
		hasData: r.hasData,
		namesCause: names(r.message, c.expects[0]),
		namesNumbers: names(r.message, ...c.expects.slice(1)),
		engineIndependent: engineIndependent(r.message),
		message: r.message,
		moved: moved.length === 0 ? 'NOTHING' : moved.join(', '),
		receipt: receipt === null ? 'none' : JSON.stringify(receipt),
		transaction: transaction === null ? 'none' : JSON.stringify(transaction),
		inABlock: head.transactions.includes(hash)
			? `in block ${head.number}`
			: 'no',
		recovered: recovered.outcome,
		blocksMined: String(
			BigInt(afterRecovery.blockNumber) - BigInt(before.blockNumber),
		),
		cumulativeGasUsed:
			recovered.receipt === null
				? 'no receipt'
				: BigInt(recovered.receipt.cumulativeGasUsed) ===
					  BigInt(recovered.receipt.gasUsed)
					? 'equal to its own gasUsed'
					: `${recovered.receipt.cumulativeGasUsed}, its own gasUsed is ${recovered.receipt.gasUsed}`,
		counterSlotAfter: afterRecovery.counterSlot,
		lookupByHashWorks:
			recoveredReceipt !== null &&
			recoveredHead.transactions.includes(recoveredHash)
				? 'the mined transaction IS found by the same hashing'
				: `the mined transaction ${recoveredHash} was NOT found (receipt ${
						recoveredReceipt === null ? 'missing' : 'present'
					}, block lists ${JSON.stringify(recoveredHead.transactions)})`,
	};
}

/**
 * THE FIVE REFUSALS. Every `invalid` transaction differs in its BYTES from every
 * transaction its setup mined (the replay carries a different value), because a
 * byte-identical replay would hash to the mined transaction and
 * `eth_getTransactionReceipt` would answer with ITS receipt — a false positive
 * exactly where this battery reads hardest.
 */
const CASES: Case[] = [
	{
		// A REPLAY: nonce 0 again, after nonce 0 was mined.
		label: 'replayedNonce',
		setup: [0],
		invalid: {nonce: 0, value: 2n},
		expects: ['nonce too low', 'tx: 0', 'state: 1'],
		recoverNonce: 1,
	},
	{
		// A GAP THIS NODE WILL NEVER FILL: it has no mempool to queue it in.
		label: 'nonceTooHigh',
		setup: [0],
		invalid: {nonce: 99},
		expects: ['nonce too high', 'tx: 99', 'state: 1'],
		recoverNonce: 1,
	},
	{
		// UNAFFORDABLE: the whole balance as value, so `value + gasLimit * maxFee`
		// is over it by the entire fee.
		label: 'unaffordable',
		setup: [],
		invalid: {nonce: 0, value: GENESIS_BALANCE},
		expects: [
			'insufficient funds',
			`have ${GENESIS_BALANCE}`,
			`want ${GENESIS_BALANCE + UPFRONT_FEE}`,
		],
		recoverNonce: 0,
	},
	{
		// ...AND THE WEI-EXACT OTHER SIDE OF IT: one wei more than the sender can
		// afford, where affordable means `balance - gasLimit * maxFeePerGas` — the
		// MAX fee, not the effective one. A node checking the effective price would
		// mine this while both engines refused it.
		label: 'unaffordableByOneWei',
		setup: [],
		invalid: {nonce: 0, value: GENESIS_BALANCE - UPFRONT_FEE + 1n},
		expects: [
			'insufficient funds',
			`have ${GENESIS_BALANCE}`,
			`want ${GENESIS_BALANCE + 1n}`,
		],
		recoverNonce: 0,
	},
	{
		// BELOW INTRINSIC GAS: one gas short of what it costs to reach the first
		// opcode.
		label: 'belowIntrinsicGas',
		setup: [],
		invalid: {nonce: 0, gas: 20_999n},
		expects: ['intrinsic gas too low', 'have 20999', 'want 21000'],
		recoverNonce: 0,
	},
	{
		// ...AND THE SAME RULE WHERE THE FLOOR IS NOT 21000: a type-1 transaction
		// naming one address (2,400) and two storage keys (2 * 1,900) must pay 27,200
		// before its first opcode. Both engines charge the access list, and
		// `src/intrinsic-gas.ts`'s shared read-path formula does NOT carry that term
		// (an `eth_call` has no access list), so a node checking the floor with THAT
		// formula would wave this transaction through and let whichever engine is
		// installed refuse it in its own vocabulary. This case is what makes the
		// node's choice of figure load-bearing rather than merely documented.
		label: 'belowIntrinsicGasWithAccessList',
		setup: [],
		invalid: {
			nonce: 0,
			type: 'eip2930',
			gas: 27_199n,
			accessList: [
				{
					address: COUNTER,
					storageKeys: [`0x${'00'.repeat(32)}`, `0x${'00'.repeat(31)}07`],
				},
			],
		},
		expects: ['intrinsic gas too low', 'have 27199', 'want 27200'],
		recoverNonce: 0,
	},
];

/**
 * THE CONTROL UNDER `unaffordableByOneWei`: the largest value the sender CAN
 * afford must MINE. Without it, "one wei more is refused" is a statement about
 * value-bearing transactions in general rather than about affordability, and a
 * node that refused every valuable transaction would pass.
 */
async function runAffordable(node: SlimNode): Promise<AffordableReading> {
	const value = GENESIS_BALANCE - UPFRONT_FEE;
	const r = await send(node, await sign({nonce: 0, value}));
	const state = await readState(node);
	return {
		value: String(value),
		outcome: r.outcome,
		counterSlot: state.counterSlot,
	};
}

/** The nonce asymmetry, from outside, on one node. */
async function runNonceCheck(node: SlimNode): Promise<NonceCheckReading> {
	for (let n = 0; n < 5; n++) await send(node, await sign({nonce: n}));
	const onChainNonce = String(
		BigInt(
			(await node.request({
				method: 'eth_getTransactionCount',
				params: [account.address, 'latest'],
			})) as string,
		),
	);
	// THE SAME CALL, THROUGH THE PATH THAT CHECKS NO NONCE. It has no nonce to
	// give — that IS the asymmetry — so what it establishes is that the sender, the
	// target and the state are all fine, and therefore that the refusal below is
	// about the nonce and about nothing else.
	let read: string;
	try {
		await node.request({
			method: 'eth_call',
			params: [{from: account.address, to: COUNTER}, 'latest'],
		});
		read = 'ok';
	} catch (e) {
		read = `failed: ${String((e as Error)?.message ?? e)}`;
	}
	const future = await send(node, await sign({nonce: 99}));
	const correct = await send(node, await sign({nonce: 5}));
	return {
		onChainNonce,
		read,
		txAtFutureNonce:
			future.outcome !== 'refused'
				? future.outcome
				: names(future.message, 'nonce too high', 'tx: 99', 'state: 5') ===
					  'named'
					? 'refused: nonce too high'
					: future.message,
		txAtCorrectNonce: correct.outcome,
	};
}

export async function runInvalidTransactionChecks(params: {
	makeEngine: EngineFactory;
}): Promise<InvalidTxReport> {
	const mismatches: string[] = [];
	const refusals: InvalidTxReport['refusals'] = {reference: {}, underTest: {}};
	let referenceEngineId = '';
	let engineId = '';

	/** Diff one reading between the two engines, field by field. */
	const diff = <T extends Record<string, string>>(
		label: string,
		reference: T,
		underTest: T,
	) => {
		for (const field of Object.keys(reference) as (keyof T & string)[]) {
			if (reference[field] !== underTest[field])
				mismatches.push(
					`${label}.${field}: reference=${reference[field]} underTest=${underTest[field]}`,
				);
		}
	};

	/**
	 * One case, on a FRESH pair of nodes, so what a case reads is the whole of what
	 * that one transaction did and nothing accumulates across cases.
	 */
	const onPair = async <T extends Record<string, string>>(
		label: string,
		run: (node: SlimNode) => Promise<T>,
	): Promise<{reference: T; underTest: T}> => {
		const reference = await buildNode(undefined);
		const underTest = await buildNode(params.makeEngine);
		referenceEngineId = reference.engine.id;
		engineId = underTest.engine.id;
		const out = {
			reference: await run(reference),
			underTest: await run(underTest),
		};
		await reference.dispose();
		await underTest.dispose();
		diff(label, out.reference, out.underTest);
		return out;
	};

	for (const c of CASES) {
		const out = await onPair(c.label, (node) => runCase(node, c));
		refusals.reference[c.label] = out.reference;
		refusals.underTest[c.label] = out.underTest;
	}
	const affordableToTheWei = await onPair('affordableToTheWei', runAffordable);
	const nonceCheck = await onPair('nonceCheck', runNonceCheck);

	return {
		referenceEngineId,
		engineId,
		mismatches,
		refusals,
		affordableToTheWei,
		nonceCheck,
	};
}
