/**
 * probe-invalid-transactions.mjs: what the node ACTUALLY does today, per engine,
 * when a transaction is invalid — a replayed nonce, a far-future nonce, a sender
 * who cannot afford `value + gas * maxFee`, and a gas limit below intrinsic gas.
 *
 * WHY IT EXISTS. `replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors`
 * has to make those four refusals IDENTICAL across the two engines and speak the
 * node's own vocabulary. Whether that needs new code, and where, depends on what
 * each engine says today, on whether anything MOVED when it said it, and on
 * whether the two engines even draw the affordability line in the same place. So
 * this measures all three before anything is changed.
 *
 * Three sections:
 *   1. the four invalid transactions, per engine: the message that reached the
 *      caller, its JSON-RPC code, and every state reading before/after;
 *   2. the AFFORDABILITY BOUNDARY, to the wei: the largest value a sender can
 *      afford and the first it cannot, on both engines;
 *   3. the NONCE ASYMMETRY: the same sender, the same target, the same state —
 *      a read (no nonce check) against a transaction at a far-future nonce.
 *
 * Run it from the repo root against the installed workspace (no build step):
 *
 *   packages/embedded-eth-node/node_modules/.bin/tsx docs/spikes/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors/probe-invalid-transactions.mjs
 *
 * Measurements are recorded next to this file in `measurements.md`.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createNode} from '../../../packages/embedded-eth-node/src/index.js';
import {createRevmEngine} from '../../../packages/embedded-eth-node/src/revm.js';

// Resolved through the package that depends on them, so this runs from the repo
// root with no install of its own (same shape as the probe in
// docs/spikes/stop-forwarding-revms-validation-error-text-as-eth-call-return-data/).
const require = createRequire(
	new URL('../../../packages/embedded-eth-node/package.json', import.meta.url),
);
const {wasmUrl} = await import(require.resolve('revm-wasm/wasm-url'));
const {privateKeyToAccount} = await import(require.resolve('viem/accounts'));

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
const SINK = '0x00000000000000000000000000000000000000aa';
const BASE_FEE = 7n;
const GENESIS_BALANCE = 10n ** 18n;
const MAX_FEE = 10n;
const TIP = 1n;

// Node cannot `fetch` a `file:` URL, so the bytes are read first (module header
// of src/revm.ts).
const wasm = await WebAssembly.compile(readFileSync(fileURLToPath(wasmUrl)));

async function build(withRevm, balance = GENESIS_BALANCE) {
	return createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: balance},
		baseFeePerGas: BASE_FEE,
		blockEnv: {timestamp: 1_700_000_000n},
		engine: withRevm ? await createRevmEngine({wasm}) : undefined,
	});
}

const sign = (tx) =>
	account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		maxFeePerGas: MAX_FEE,
		maxPriorityFeePerGas: TIP,
		...tx,
	});

async function stateOf(node) {
	const call = (method, params) => node.request({method, params});
	return {
		blockNumber: await call('eth_blockNumber', []),
		nonce: await call('eth_getTransactionCount', [account.address, 'latest']),
		balance: await call('eth_getBalance', [account.address, 'latest']),
		sink: await call('eth_getBalance', [SINK, 'latest']),
	};
}

async function send(node, raw) {
	try {
		const rcpt = await node.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		});
		return {outcome: `mined ${rcpt?.status}`, code: '', message: ''};
	} catch (e) {
		return {
			outcome: 'refused',
			code: String(e?.code),
			data: String(e?.data),
			message: String(e?.message ?? e),
		};
	}
}

const ENGINES = [
	['@ethereumjs/evm', false],
	['revm-wasm', true],
];

// ---- 1) the four invalid transactions ------------------------------------
const transfer = (over) => ({to: SINK, value: 1n, gas: 21_000n, ...over});
const CASES = [
	[
		'replayed nonce (0 again)',
		async (node) => {
			// One good transaction first, so nonce 0 is spent.
			await send(node, await sign(transfer({nonce: 0})));
			return sign(transfer({nonce: 0, value: 2n}));
		},
	],
	['far-future nonce (99)', async () => sign(transfer({nonce: 99}))],
	[
		'unaffordable value + fees',
		async () => sign(transfer({nonce: 0, value: GENESIS_BALANCE})),
	],
	[
		'gas limit below intrinsic (20999)',
		async () => sign(transfer({nonce: 0, gas: 20_999n})),
	],
];

for (const [engine, withRevm] of ENGINES) {
	console.log(`\n===== ${engine} =====`);
	for (const [label, make] of CASES) {
		const node = await build(withRevm);
		const raw = await make(node);
		const before = await stateOf(node);
		const r = await send(node, raw);
		const after = await stateOf(node);
		const moved = Object.keys(before).filter((k) => before[k] !== after[k]);
		console.log(`\n-- ${label}`);
		console.log(`   outcome : ${r.outcome}  code=${r.code} data=${r.data ?? ''}`);
		console.log(`   message : ${r.message}`);
		console.log(`   state   : ${JSON.stringify(before)}`);
		console.log(`   moved   : ${moved.length ? moved.join(', ') : 'NOTHING'}`);
		await node.dispose();
	}
}

// ---- 2) the affordability boundary, to the wei ---------------------------
// A 1559 transaction must satisfy `balance >= value + gasLimit * maxFeePerGas`
// (the EIP's own assertion), NOT `value + gasLimit * effectiveGasPrice`. The two
// differ by `gasLimit * (maxFee - effective)`, so a node checking the wrong one
// would admit transactions one engine mines and the other refuses. Measured
// here as: the largest value that mines, and the first that does not.
console.log('\n===== affordability boundary =====');
{
	const fee = 21_000n * MAX_FEE;
	const affordable = GENESIS_BALANCE - fee;
	for (const [label, value] of [
		['value == balance - gasLimit*maxFee (the last affordable wei)', affordable],
		['value == balance - gasLimit*maxFee + 1', affordable + 1n],
		['value == balance - gasLimit*effectiveGasPrice', GENESIS_BALANCE - 21_000n * (BASE_FEE + TIP)],
	]) {
		console.log(`\n-- ${label}`);
		for (const [engine, withRevm] of ENGINES) {
			const node = await build(withRevm);
			const r = await send(node, await sign(transfer({nonce: 0, value})));
			console.log(
				`   ${engine.padEnd(16)}: ${r.outcome}${r.message ? ` — ${r.message.split(' (vm ')[0]}` : ''}`,
			);
			await node.dispose();
		}
	}
}

// ---- 3) the nonce asymmetry, from outside --------------------------------
// The same sender, the same target, the same state: the READ path does not check
// a nonce and the TRANSACTION path does. Five transactions are mined first so the
// on-chain nonce is 5 and 99 is unambiguously in the future.
console.log('\n===== nonce asymmetry (on-chain nonce 5) =====');
for (const [engine, withRevm] of ENGINES) {
	const node = await build(withRevm);
	for (let n = 0; n < 5; n++) await send(node, await sign(transfer({nonce: n})));
	const nonce = await node.request({
		method: 'eth_getTransactionCount',
		params: [account.address, 'latest'],
	});
	let read;
	try {
		await node.request({
			method: 'eth_call',
			params: [{from: account.address, to: SINK, value: '0x1'}, 'latest'],
		});
		read = 'ok';
	} catch (e) {
		read = `failed: ${String(e?.message ?? e)}`;
	}
	const future = await send(node, await sign(transfer({nonce: 99})));
	const correct = await send(node, await sign(transfer({nonce: 5})));
	console.log(`\n-- ${engine} (nonce ${nonce})`);
	console.log(`   eth_call (no nonce check) : ${read}`);
	console.log(`   tx at nonce 99            : ${future.outcome} — ${future.message.split(' (vm ')[0]}`);
	console.log(`   tx at nonce 5             : ${correct.outcome}`);
	await node.dispose();
}
