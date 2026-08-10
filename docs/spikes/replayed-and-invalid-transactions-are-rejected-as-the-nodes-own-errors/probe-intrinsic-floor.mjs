/**
 * probe-intrinsic-floor.mjs: WHICH intrinsic-gas figure the node must refuse
 * below, measured against both engines rather than reasoned about.
 *
 * The node has two candidate answers in reach and they are NOT the same number:
 *
 *   a) `src/intrinsic-gas.ts`'s shared `intrinsicGas(data, isCreate, common)` —
 *      the formula the read path adds and the revm engine subtracts. It has NO
 *      access-list term, because an `eth_call` carries no access list.
 *   b) the parsed transaction's OWN `tx.getIntrinsicGas()` (`@ethereumjs/tx`),
 *      which adds EIP-2930's 2400 per address + 1900 per storage key.
 *
 * Both engines charge the access list, so (a) is BELOW the real floor for a
 * type-1/type-2 transaction carrying one. This probe finds each engine's actual
 * floor by submitting the same transaction at `floor - 1` and at `floor`, for four
 * transaction shapes, and prints both candidates beside the answer.
 *
 * Run from the repo root:
 *
 *   packages/embedded-eth-node/node_modules/.bin/tsx docs/spikes/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors/probe-intrinsic-floor.mjs
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createNode} from '../../../packages/embedded-eth-node/src/index.js';
import {createRevmEngine} from '../../../packages/embedded-eth-node/src/revm.js';
import {intrinsicGas} from '../../../packages/embedded-eth-node/src/intrinsic-gas.js';

const require = createRequire(
	new URL('../../../packages/embedded-eth-node/package.json', import.meta.url),
);
const {wasmUrl} = await import(require.resolve('revm-wasm/wasm-url'));
const {privateKeyToAccount} = await import(require.resolve('viem/accounts'));
const {createTxFromRLP} = await import(require.resolve('@ethereumjs/tx'));
const {Common, Mainnet, Hardfork} = await import(
	require.resolve('@ethereumjs/common')
);
const {hexToBytes} = await import(require.resolve('@ethereumjs/util'));

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
const SINK = '0x00000000000000000000000000000000000000aa';
const wasm = await WebAssembly.compile(readFileSync(fileURLToPath(wasmUrl)));
const common = new Common({
	chain: {...Mainnet, chainId: CHAIN_ID, name: 'embedded-eth-node'},
	hardfork: Hardfork.Cancun,
});

const build = async (withRevm) =>
	createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 18n},
		baseFeePerGas: 7n,
		engine: withRevm ? await createRevmEngine({wasm}) : undefined,
	});

async function accepts(withRevm, raw) {
	const node = await build(withRevm);
	try {
		await node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
		return 'mined';
	} catch (e) {
		return `refused: ${String(e?.message ?? e).split(' (vm ')[0]}`;
	} finally {
		await node.dispose();
	}
}

const shapes = [
	{label: 'plain transfer', tx: {to: SINK, value: 1n, data: '0x'}},
	{
		label: 'calldata (5 non-zero, 3 zero)',
		tx: {to: SINK, value: 0n, data: '0x0102030405000000'},
	},
	{label: 'create (8 bytes of initcode)', tx: {data: '0x6001600155600000'}},
	{
		label: '2930 access list (1 address, 2 keys)',
		type: 'eip2930',
		tx: {
			to: SINK,
			value: 0n,
			data: '0x',
			accessList: [
				{
					address: SINK,
					storageKeys: [`0x${'00'.repeat(32)}`, `0x${'00'.repeat(31)}01`],
				},
			],
		},
	},
];

for (const shape of shapes) {
	// Sign once at a huge gas limit purely to PARSE it and read both candidate
	// figures off the same transaction the node would parse.
	const probeRaw = await account.signTransaction({
		chainId: CHAIN_ID,
		type: shape.type ?? 'eip1559',
		nonce: 0,
		gas: 1_000_000n,
		...(shape.type === 'eip2930'
			? {gasPrice: 10n}
			: {maxFeePerGas: 10n, maxPriorityFeePerGas: 1n}),
		...shape.tx,
	});
	const parsed = createTxFromRLP(hexToBytes(probeRaw), {common});
	const shared = intrinsicGas(
		parsed.data,
		parsed.to === undefined,
		common,
	);
	const own = parsed.getIntrinsicGas();
	console.log(`\n== ${shape.label}`);
	console.log(`   src/intrinsic-gas.ts : ${shared}`);
	console.log(`   tx.getIntrinsicGas() : ${own}`);
	for (const gas of [own - 1n, own]) {
		const raw = await account.signTransaction({
			chainId: CHAIN_ID,
			type: shape.type ?? 'eip1559',
			nonce: 0,
			gas,
			...(shape.type === 'eip2930'
				? {gasPrice: 10n}
				: {maxFeePerGas: 10n, maxPriorityFeePerGas: 1n}),
			...shape.tx,
		});
		console.log(`   gas=${gas}`);
		console.log(`     @ethereumjs/evm : ${await accepts(false, raw)}`);
		console.log(`     revm-wasm       : ${await accepts(true, raw)}`);
	}
}
