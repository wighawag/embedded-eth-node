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
 *   5b. The BLOCK ENVIRONMENT is the node's own and is IDENTICAL on both
 *      engines: a contract reading `BASEFEE` / `PREVRANDAO` / `COINBASE` /
 *      `NUMBER` / `TIMESTAMP` / `GASLIMIT` inside an `eth_call` gets the same
 *      answer either way. Gas cannot see this: those opcodes are
 *      fee-independent, so an engine lying about the block still charges
 *      byte-identical gas.
 *   5c. An `eth_call` from an address that holds NO ETHER still works (the
 *      property the zeroed base fee used to buy), and one from an address that
 *      HOLDS CODE works too (EIP-3607 is a transaction rule, not an execution
 *      rule, and the default engine's `runCall` never enforced it).
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
	decodeFunctionResult,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {counterAbi, counterBytecode} from './counter.js';
import {
	blockEnvProbeAbi,
	blockEnvProbeRuntimeBytecode,
} from './block-env-probe.js';

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

/** Where the block-environment probe's runtime code is placed on both nodes. */
const BLOCK_ENV_PROBE_ADDR = '0x00000000000000000000000000000000b10ce7ee';
/**
 * A block environment BOTH nodes are given verbatim, so the two chains cannot
 * drift on their own (the timestamp is pinned for the same reason: it is
 * otherwise `Date.now()` per node). Every value is distinctive: zero would be
 * indistinguishable from an engine that reads nothing.
 */
const SHARED_BLOCK_ENV = {
	timestamp: 1_700_000_000n,
	coinbase: '0x00000000000000000000000000000000c0173a5e',
	prevRandao:
		'0x5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed',
} as const;
const SHARED_BASE_FEE = 7_000_000_000n;
/** An address holding no ether at all — the EIP-3607-free unfunded caller. */
const UNFUNDED_CALLER = '0x00000000000000000000000000000000dead0001';

async function nodeWith(
	engine?: ReadEngine,
	extra: Record<string, unknown> = {},
) {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
		engine,
		...extra,
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

	// ---------- CALLERS A SIMULATION MUST SERVE: unfunded, and holding code ----
	// The zeroed base fee existed to keep an `eth_call` from an address holding no
	// ether working (the node defaults `from` to the zero address). Replacing it
	// with `disableBaseFee` + `disableBalanceCheck` has to keep exactly that, so
	// the same read is made from a FUNDED address, from an UNFUNDED one, and from
	// an address that HOLDS CODE — the last being EIP-3607, which revm enforces on
	// a transaction and `@ethereumjs/evm`'s `runCall` never enforced at all.
	for (const ctx of [def, revm]) {
		await ctx.node.request({
			method: 'evm_setCode',
			params: [BLOCK_ENV_PROBE_ADDR, blockEnvProbeRuntimeBytecode],
		});
	}
	// A PURE function (`sumTo(4)` == 0+1+2+3 == 6), so the answer cannot depend on
	// which node's state the call ran against: by this point the revm node carries
	// an extra mined `increment()` from the section above, and a storage read would
	// compare the two chains rather than the two engines.
	const pureCallData = encodeFunctionData({
		abi: counterAbi,
		functionName: 'sumTo',
		args: [4n],
	});
	const callers: Record<string, string> = {
		funded: account.address,
		unfunded: UNFUNDED_CALLER,
		// An address that holds code, i.e. the EIP-3607 case: smart-account /
		// ERC-4337 flows, multicall aggregators, any UI previewing what one contract
		// sees when called by another.
		contract: BLOCK_ENV_PROBE_ADDR,
	};
	const callerResults: Record<string, string> = {};
	const callerGas: Record<string, string> = {};
	const callerErrors: Record<string, string> = {};
	for (const [who, from] of Object.entries(callers)) {
		for (const [label, ctx] of [
			['default', def],
			['revm', revm],
		] as const) {
			const p = {from, to: deployed[label], data: pureCallData};
			try {
				callerResults[`${who}.${label}`] = String(
					await ctx.node.request({method: 'eth_call', params: [p]}),
				);
				callerGas[`${who}.${label}`] = String(
					await ctx.node.request({method: 'eth_estimateGas', params: [p]}),
				);
			} catch (e) {
				// Recorded rather than thrown: a refusal here is the DIVERGENCE this
				// test is looking for, and the spec should report which caller failed
				// on which engine rather than one opaque stack.
				callerErrors[`${who}.${label}`] = String((e as Error)?.message ?? e);
			}
		}
	}
	out.callerResults = callerResults;
	out.callerGas = callerGas;
	out.callerErrors = callerErrors;
	out.callerResultsMatch = Object.keys(callers).every(
		(who) => callerResults[`${who}.default`] === callerResults[`${who}.revm`],
	);
	out.callerGasMatches = Object.keys(callers).every(
		(who) => callerGas[`${who}.default`] === callerGas[`${who}.revm`],
	);
	// ...and every caller sees the SAME contract answer: who asks cannot change
	// what a view function returns.
	out.callerResultsAgree = Object.keys(callers).every(
		(who) => callerResults[`${who}.revm`] === callerResults['funded.revm'],
	);

	// ---------- the BLOCK ENVIRONMENT, engine against engine ----------
	// Two nodes given the SAME block environment verbatim, so any difference in
	// what a contract reads is the ENGINE. This is the bar the gas gate cannot be:
	// BASEFEE and friends are fee-independent, so an engine running a read against
	// a block the node never had charges byte-identical gas for it.
	const blockEnvNodes = {
		default: await nodeWith(undefined, {
			blockEnv: SHARED_BLOCK_ENV,
			baseFeePerGas: SHARED_BASE_FEE,
		}),
		revm: await nodeWith(await createRevmEngine({wasm: bundlerResolvedWasm}), {
			blockEnv: SHARED_BLOCK_ENV,
			baseFeePerGas: SHARED_BASE_FEE,
		}),
	};
	const blockEnvData = encodeFunctionData({
		abi: blockEnvProbeAbi,
		functionName: 'env',
	});
	const blockEnvReads: Record<string, string> = {};
	for (const [label, ctx] of Object.entries(blockEnvNodes)) {
		await ctx.node.request({
			method: 'evm_setCode',
			params: [BLOCK_ENV_PROBE_ADDR, blockEnvProbeRuntimeBytecode],
		});
		// One mined block, so the read runs against a block carrying the configured
		// environment (genesis carries neither coinbase nor prevRandao).
		await ctx.node.mine();
		blockEnvReads[label] = String(
			await ctx.node.request({
				method: 'eth_call',
				// No `from`: the zero address, i.e. the unfunded default, reading a
				// block whose base fee is 7 gwei.
				params: [{to: BLOCK_ENV_PROBE_ADDR, data: blockEnvData}],
			}),
		);
	}
	out.blockEnvReads = blockEnvReads;
	out.blockEnvMatches = blockEnvReads.default === blockEnvReads.revm;
	const decoded = decodeFunctionResult({
		abi: blockEnvProbeAbi,
		functionName: 'env',
		data: blockEnvReads.revm as `0x${string}`,
	});
	out.blockEnvOnRevm = {
		basefee: decoded[0].toString(),
		prevrandao: '0x' + decoded[1].toString(16).padStart(64, '0'),
		coinbase: decoded[2].toLowerCase(),
		number: decoded[3].toString(),
		timestamp: decoded[4].toString(),
		gaslimit: decoded[5].toString(),
	};
	out.blockEnvExpected = {
		basefee: SHARED_BASE_FEE.toString(),
		prevrandao: SHARED_BLOCK_ENV.prevRandao,
		coinbase: SHARED_BLOCK_ENV.coinbase,
		number: '1',
		timestamp: SHARED_BLOCK_ENV.timestamp.toString(),
		gaslimit: '30000000',
	};
	await blockEnvNodes.default.node.dispose();
	await blockEnvNodes.revm.node.dispose();

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
