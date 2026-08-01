/**
 * revm-engine.ts — the `embedded-eth-node/revm` engine, driven in a real browser
 * against the DEFAULT `@ethereumjs/evm` engine on the same state.
 *
 * What this pins:
 *   1. A node built with `createRevmEngine({wasm})` runs its reads on revm and
 *      says so (`node.readEngine.id`).
 *   2. `eth_call` and `eth_estimateGas` return the SAME return data and the SAME
 *      gas as the default engine, for the same calls on the same state — and the
 *      execution gas matches the reference numbers (`number()` 2446,
 *      `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 + its result hash), so a
 *      wrong answer is obviously wrong rather than plausibly wrong.
 *   3. The engine reads the node's AUTHORITATIVE state: a transaction mined by
 *      the node is visible to the next revm `eth_call` with no sync step.
 *   4. `eth_call` on revm cannot mutate state: a call that WOULD write leaves the
 *      node's storage untouched, and the store's write methods throw.
 *   5. `BLOCKHASH` answers with the node's real block hashes (the read engine
 *      context carries block access; an unwired `getBlockHash` would silently
 *      answer zero).
 *   6. Both wasm delivery shapes work: a bundler-resolved asset and a
 *      runtime-fetched URL, through the same code path.
 *   7. `stateMode:'trie'` is REFUSED at construction, naming the reason, rather
 *      than constructing and failing at the first opcode.
 *   8. One engine instance serves ONE node: handing the same engine to a second
 *      `createNode()` is refused, rather than silently re-pointing the first
 *      node's reads at the second node's state.
 */
import {createNode} from '../../src/index.js';
import {createRevmEngine, REVM_ENGINE_ID} from '../../src/revm.js';
import {SimpleStateManagerStore} from '../../src/revm-state-store.js';
import type {ReadEngine} from '../../src/index.js';
// The BUNDLER-RESOLVED delivery shape: the build resolves the `.wasm` out of the
// `revm-wasm` package and puts it IN the build (esbuild's `binary` loader here;
// Vite's `?arraybuffer`, webpack's `asset/inline`), so the page fetches nothing
// and the consumer hard-codes no path.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';
import {
	createWalletClient,
	createPublicClient,
	custom,
	encodeFunctionData,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {counterAbi, counterBytecode} from './counter.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
const chain = {
	id: CHAIN_ID,
	name: 'slim',
	nativeCurrency: {name: 'E', symbol: 'E', decimals: 18},
	rpcUrls: {default: {http: []}},
} as const;

/** Mirrors the node's own intrinsic-gas formula, so a comparison is meaningful. */
function intrinsicGas(dataHex: string, isCreate: boolean): bigint {
	const hex = dataHex.startsWith('0x') ? dataHex.slice(2) : dataHex;
	let gas = 21_000n;
	let bytes = 0;
	for (let i = 0; i < hex.length; i += 2) {
		bytes++;
		gas += hex.slice(i, i + 2) === '00' ? 4n : 16n;
	}
	if (isCreate) gas += 32_000n + BigInt(Math.ceil(bytes / 32)) * 2n;
	return gas;
}

/**
 * Runtime bytecode returning `blockhash(number - 1)`.
 * PUSH1 01, NUMBER, SUB, BLOCKHASH, PUSH0, MSTORE, PUSH1 20, PUSH0, RETURN.
 */
const BLOCKHASH_PROBE_CODE = '0x60014303405f5260205ff3';
const BLOCKHASH_PROBE_ADDR = '0x00000000000000000000000000000000000b1a5e';

async function nodeWith(engine?: ReadEngine) {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
		engine,
	});
	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	return {
		node,
		pub: createPublicClient({chain, transport}),
		wallet: createWalletClient({account, chain, transport}),
	};
}

export async function runRevmEngineChecks(params: {runtimeWasmUrl: string}) {
	const out: Record<string, unknown> = {};

	// ---------- delivery shape 1: a BUNDLER-RESOLVED asset ----------
	const fromAsset = await createRevmEngine({wasm: bundlerResolvedWasm});
	// ---------- delivery shape 2: a RUNTIME-FETCHED URL ----------
	const fromUrl = await createRevmEngine({
		wasm: new URL(params.runtimeWasmUrl),
	});

	const def = await nodeWith();
	const revm = await nodeWith(fromAsset);
	out.defaultEngineId = def.node.readEngine.id;
	out.revmEngineId = revm.node.readEngine.id;
	out.revmEngineIdExpected = REVM_ENGINE_ID;

	// Deploy the SAME contract on both nodes, through viem — which estimates gas
	// first, so the CREATE-shaped read path runs on revm too.
	const deployed: Record<string, `0x${string}`> = {};
	for (const [label, ctx] of [
		['default', def],
		['revm', revm],
	] as const) {
		const hash = await ctx.wallet.deployContract({
			abi: counterAbi,
			bytecode: counterBytecode,
			args: [],
		});
		const rcpt = await ctx.pub.getTransactionReceipt({hash});
		deployed[label] = rcpt.contractAddress!;
	}
	out.sameDeployAddress = deployed.default === deployed.revm;

	// ---------- results + gas, engine against engine ----------
	const calls: {name: string; data: `0x${string}`}[] = [
		{
			name: 'number',
			data: encodeFunctionData({abi: counterAbi, functionName: 'number'}),
		},
		{
			name: 'sumTo2000',
			data: encodeFunctionData({
				abi: counterAbi,
				functionName: 'sumTo',
				args: [2000n],
			}),
		},
		{
			name: 'keccakLoop2000',
			data: encodeFunctionData({
				abi: counterAbi,
				functionName: 'keccakLoop',
				args: [2000n],
			}),
		},
		{
			name: 'increment',
			data: encodeFunctionData({abi: counterAbi, functionName: 'increment'}),
		},
	];
	const callResults: Record<string, string> = {};
	const estimates: Record<string, string> = {};
	const executionGas: Record<string, string> = {};
	for (const {name, data} of calls) {
		for (const [label, ctx] of [
			['default', def],
			['revm', revm],
		] as const) {
			const p = {from: account.address, to: deployed[label], data};
			callResults[`${name}.${label}`] = String(
				await ctx.node.request({method: 'eth_call', params: [p]}),
			);
			const est = String(
				await ctx.node.request({method: 'eth_estimateGas', params: [p]}),
			);
			estimates[`${name}.${label}`] = est;
			executionGas[`${name}.${label}`] = (
				BigInt(est) - intrinsicGas(data, false)
			).toString();
		}
	}
	out.callResults = callResults;
	out.estimates = estimates;
	out.executionGas = executionGas;
	out.resultsMatch = calls.every(
		({name}) => callResults[`${name}.default`] === callResults[`${name}.revm`],
	);
	out.gasMatches = calls.every(
		({name}) => estimates[`${name}.default`] === estimates[`${name}.revm`],
	);

	// ---------- the engine reads the node's AUTHORITATIVE state ----------
	const incrementData = encodeFunctionData({
		abi: counterAbi,
		functionName: 'increment',
	});
	const txHash = await revm.wallet.sendTransaction({
		to: deployed.revm,
		data: incrementData,
	});
	out.txStatus = (await revm.pub.getTransactionReceipt({hash: txHash})).status;
	// No sync step of any kind between the transaction and this read.
	out.numberAfterTx = String(
		await revm.pub.readContract({
			address: deployed.revm,
			abi: counterAbi,
			functionName: 'number',
		}),
	);

	// ---------- a read cannot mutate ----------
	const storageBefore = await revm.node.request({
		method: 'eth_getStorageAt',
		params: [deployed.revm, '0x0', 'latest'],
	});
	await revm.node.request({
		method: 'eth_call',
		params: [{from: account.address, to: deployed.revm, data: incrementData}],
	});
	const storageAfter = await revm.node.request({
		method: 'eth_getStorageAt',
		params: [deployed.revm, '0x0', 'latest'],
	});
	out.callDidNotMutateState = storageBefore === storageAfter;
	out.storageAfterCall = String(storageAfter);
	// ...and the store revm reads through cannot write AT ALL: all five write
	// methods throw, so a commit could never be silent.
	const readOnlyStore = new SimpleStateManagerStore();
	out.writeMethodsThrow = (
		[
			'setAccount',
			'setCode',
			'setStorage',
			'clearStorage',
			'removeAccount',
		] as const
	).every((m) => {
		try {
			(readOnlyStore[m] as () => void)();
			return false;
		} catch {
			return true;
		}
	});

	// ---------- BLOCKHASH is wired to the node's blocks ----------
	for (const ctx of [def, revm]) {
		await ctx.node.request({
			method: 'evm_setCode',
			params: [BLOCKHASH_PROBE_ADDR, BLOCKHASH_PROBE_CODE],
		});
	}
	// The two nodes are separate chains, so their block hashes differ: each is
	// checked against ITS OWN chain rather than against each other.
	for (const [label, ctx] of [
		['default', def],
		['revm', revm],
	] as const) {
		// A block MINED AFTER the engine connected — the context must expose the
		// node's live blocks, not a snapshot taken at construction.
		await ctx.node.mine();
		const latest = Number(
			await ctx.node.request({method: 'eth_blockNumber', params: []}),
		);
		const previous: any = await ctx.node.request({
			method: 'eth_getBlockByNumber',
			params: ['0x' + (latest - 1).toString(16), false],
		});
		out[`blockHashExpected.${label}`] = previous.hash;
		out[`blockHash.${label}`] = String(
			await ctx.node.request({
				method: 'eth_call',
				params: [{to: BLOCKHASH_PROBE_ADDR, data: '0x'}],
			}),
		);
	}

	// ---------- the OTHER delivery shape works too ----------
	const urlNode = await nodeWith(fromUrl);
	await urlNode.node.request({
		method: 'evm_setCode',
		params: [BLOCKHASH_PROBE_ADDR, BLOCKHASH_PROBE_CODE],
	});
	out.runtimeUrlEngineId = urlNode.node.readEngine.id;
	// One block, so `blockhash(number - 1)` names the genesis block rather than
	// underflowing past the start of the chain.
	await urlNode.node.mine();
	const genesis: any = await urlNode.node.request({
		method: 'eth_getBlockByNumber',
		params: ['0x0', false],
	});
	out.runtimeUrlCallExpected = genesis.hash;
	out.runtimeUrlCall = String(
		await urlNode.node.request({
			method: 'eth_call',
			params: [{to: BLOCKHASH_PROBE_ADDR, data: '0x'}],
		}),
	);
	await urlNode.node.dispose();

	// ---------- a mode the engine cannot serve is refused LOUDLY ----------
	try {
		const trieNode = await createNode({
			chainId: CHAIN_ID,
			stateMode: 'trie',
			engine: await createRevmEngine({wasm: bundlerResolvedWasm}),
		});
		out.trieRefusal = 'DID_NOT_THROW';
		await trieNode.dispose();
	} catch (e) {
		out.trieRefusal = String((e as Error)?.message ?? e);
	}

	// ---------- one engine, one node ----------
	// `fromAsset` is already bound to the `revm` node. Re-using it would rebind
	// its store to the second node's state, and the FIRST node would then answer
	// every read from the second node's state — plausible values, no error.
	try {
		const secondNode = await createNode({chainId: CHAIN_ID, engine: fromAsset});
		out.reuseRefusal = 'DID_NOT_THROW';
		await secondNode.dispose();
	} catch (e) {
		out.reuseRefusal = String((e as Error)?.message ?? e);
	}
	// ...and the first node still reads ITS OWN state afterwards.
	out.numberAfterReuseAttempt = String(
		await revm.pub.readContract({
			address: deployed.revm,
			abi: counterAbi,
			functionName: 'number',
		}),
	);

	await def.node.dispose();
	await revm.node.dispose();
	return out;
}
