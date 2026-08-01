/**
 * slim-node-checks.ts — in-browser correctness + honesty assertions for the node,
 * covering the common in-browser-node pitfalls and proving it does NOT have them:
 *   1. LEGACY (type-0) tx receipt does NOT crash (the effectiveGasPrice pitfall).
 *   2. EIP-1559 receipt has effectiveGasPrice too.
 *   3. Account/signing methods fail LOUDLY (method-not-found), never fake success.
 *   4. dump/load persistence round-trips (state survives into a fresh node).
 *   6. The ENGINE seam's honest edges: an engine that cannot start, or cannot
 *      serve the node's configuration, takes construction DOWN — the node never
 *      quietly substitutes the default engine — and an engine handed to the
 *      Worker client is refused by name rather than by an opaque DataCloneError.
 */
import {
	createNode,
	createMemoryPersistence,
	RpcError,
} from '../../src/index.js';
import type {ReadCallResult, ReadEngine} from '../../src/index.js';
import {createWorkerNode} from '../../src/worker-client.js';
import {createWalletClient, createPublicClient, custom, parseGwei} from 'viem';
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

export async function slimNodeHonestyChecks() {
	const persistence = createMemoryPersistence();
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		persistence,
		initialBalances: {[account.address]: 10n ** 24n},
	});
	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	const pub = createPublicClient({chain, transport});
	const wallet = createWalletClient({account, chain, transport});

	const out: Record<string, unknown> = {};

	// deploy + increments
	const deployHash = await wallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const deployRcpt = await pub.getTransactionReceipt({hash: deployHash});
	const address = deployRcpt.contractAddress!;
	for (let i = 0; i < 3; i++) {
		const h = await wallet.writeContract({
			address,
			abi: counterAbi,
			functionName: 'increment',
		});
		await pub.getTransactionReceipt({hash: h});
	}
	out.number = (
		await pub.readContract({address, abi: counterAbi, functionName: 'number'})
	).toString();
	out.eip1559ReceiptHasEffGasPrice = deployRcpt.effectiveGasPrice != null;

	// 1) LEGACY tx receipt must not crash.
	try {
		const legacyHash = await wallet.sendTransaction({
			to: '0x0000000000000000000000000000000000000001',
			value: 1n,
			gas: 21_000n,
			gasPrice: parseGwei('1'),
			type: 'legacy',
		});
		const r = await pub.getTransactionReceipt({hash: legacyHash});
		out.legacyReceipt = {
			ok: true,
			type: r.type,
			effectiveGasPrice: r.effectiveGasPrice.toString(),
		};
	} catch (e) {
		out.legacyReceipt = {ok: false, error: String((e as Error)?.message ?? e)};
	}

	// 3) honest gaps
	const probeGap = async (method: string, params: unknown[]) => {
		try {
			await node.request({method, params});
			return 'DID_NOT_THROW';
		} catch (e: any) {
			return `threw:${e?.code ?? '?'}`;
		}
	};
	out.gap_eth_sendTransaction = await probeGap('eth_sendTransaction', [
		{from: account.address, to: account.address},
	]);
	out.gap_eth_accounts = await probeGap('eth_accounts', []);
	out.gap_personal_sign = await probeGap('personal_sign', [
		'0x',
		account.address,
	]);
	out.gap_unknown_method = await probeGap('eth_totallyMadeUp', []);

	// 4) dump/load persistence round-trip into a FRESH node.
	const dumped = await node.dumpState();
	const node2 = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
	});
	await node2.loadState(dumped);
	const pub2 = createPublicClient({
		chain,
		transport: custom(
			{request: ({method, params}: any) => node2.request({method, params})},
			{retryCount: 0},
		),
	});
	out.restoredNumber = (
		await pub2.readContract({address, abi: counterAbi, functionName: 'number'})
	).toString();
	out.restoredBlockNumber = Number(await pub2.getBlockNumber());

	// 5) optional state-root mode: 'none' has no root (throws); 'trie' produces a
	// REAL Merkle-Patricia root, and both modes agree on the computed result.
	out.noneModeStateRoot = node.stateMode === 'none' ? 'none' : 'unexpected';
	let noneThrows = false;
	try {
		await node.getStateRoot();
	} catch (e) {
		noneThrows = e instanceof RpcError && e.code === -32004;
	}
	out.noneModeGetStateRootThrows = noneThrows;

	const trieNode = await createNode({
		chainId: CHAIN_ID,
		stateMode: 'trie',
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
	});
	const trieTransport = custom(
		{request: ({method, params}: any) => trieNode.request({method, params})},
		{retryCount: 0},
	);
	const triePub = createPublicClient({chain, transport: trieTransport});
	const trieWallet = createWalletClient({
		account,
		chain,
		transport: trieTransport,
	});
	const trieDeploy = await trieWallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const trieAddr = (await triePub.getTransactionReceipt({hash: trieDeploy}))
		.contractAddress!;
	for (let i = 0; i < 3; i++) {
		const h = await trieWallet.writeContract({
			address: trieAddr,
			abi: counterAbi,
			functionName: 'increment',
		});
		await triePub.getTransactionReceipt({hash: h});
	}
	out.trieModeNumber = (
		await triePub.readContract({
			address: trieAddr,
			abi: counterAbi,
			functionName: 'number',
		})
	).toString();
	const trieRoot = await trieNode.getStateRoot();
	out.trieModeStateRoot = trieRoot;
	out.trieModeRootIsReal =
		/^0x[0-9a-f]{64}$/.test(trieRoot) && trieRoot !== '0x' + '00'.repeat(32);
	// block header carries the real root in trie mode, zero in none mode
	const trieBlock = await triePub.getBlock();
	out.trieBlockStateRootMatches = trieBlock.stateRoot === trieRoot;
	const noneBlock = await pub.getBlock();
	out.noneBlockStateRootIsZero = noneBlock.stateRoot === '0x' + '00'.repeat(32);
	await trieNode.dispose();

	// 6) THE ENGINE SEAM'S HONEST EDGES.
	//
	// The read path runs on an injected engine, and the failure that matters here
	// is a SILENT FALLBACK: a consumer who asked for revm and was quietly given
	// `@ethereumjs/evm` would get a node that works, returns correct results, and
	// is an order of magnitude slower than they believe — with no signal at all.
	// So every way an engine can fail to come up has to be loud, at construction.
	Object.assign(out, await engineSeamHonestyChecks());

	await node.dispose();
	await node2.dispose();
	return out;
}

/** The exact cause a failing engine reports, so we can find it in the error. */
const ENGINE_INIT_CAUSE = 'test-engine: the wasm module never arrived';

/** An engine that dies during `connect` — the "failed to initialise" case. */
const engineThatCannotStart: ReadEngine = {
	id: 'test-engine-that-cannot-start',
	connect() {
		throw new Error(ENGINE_INIT_CAUSE);
	},
	async call(): Promise<ReadCallResult> {
		throw new Error('unreachable: this engine never connected');
	},
};

/**
 * An engine that serves `stateMode:'none'` and REFUSES anything else — the
 * generic "this engine cannot serve your configuration" shape. It is a stub on
 * purpose: `embedded-eth-node/revm` is the real INSTANCE of this (it refuses
 * `'trie'`, asserted in revm-engine.spec.ts); what is pinned here is the
 * node-side mechanism, which any third-party engine relies on.
 */
function makeNoneOnlyEngine(): ReadEngine {
	return {
		id: 'test-engine-none-only',
		connect(ctx) {
			if (ctx.stateMode !== 'none') {
				throw new Error(
					`test-engine-none-only cannot serve stateMode:'${ctx.stateMode}'`,
				);
			}
		},
		async call(): Promise<ReadCallResult> {
			return {returnValue: new Uint8Array(), executionGasUsed: 0n};
		},
	};
}

async function engineSeamHonestyChecks(): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	out.engineInitCause = ENGINE_INIT_CAUSE;

	// Report which engine a node CAME UP on, so a silent fallback would show up as
	// `DID_NOT_THROW:@ethereumjs/evm` rather than as a passing test.
	const probeCreate = async (options: any): Promise<string> => {
		try {
			const n = await createNode(options);
			const id = n.readEngine.id;
			await n.dispose();
			return `DID_NOT_THROW:${id}`;
		} catch (e) {
			return `threw:${String((e as Error)?.message ?? e)}`;
		}
	};

	// 6a) an engine that FAILS TO INITIALISE takes construction with it, naming
	// the cause it reported.
	out.engineInitFailure = await probeCreate({
		chainId: CHAIN_ID,
		engine: engineThatCannotStart,
	});

	// 6b) a configuration THIS engine cannot serve is refused at construction...
	out.engineRefusedMode = await probeCreate({
		chainId: CHAIN_ID,
		stateMode: 'trie',
		engine: makeNoneOnlyEngine(),
	});
	// ...and the SAME engine comes up for the mode it does serve, so the refusal
	// is about the configuration rather than about the engine.
	out.engineServedMode = await probeCreate({
		chainId: CHAIN_ID,
		stateMode: 'none',
		engine: makeNoneOnlyEngine(),
	});

	// 6c) an object that is not a ReadEngine is refused at construction too —
	// otherwise the node comes up and dies at the first `eth_call` with a
	// `not a function` TypeError, which reads like a node bug.
	out.engineNotAnEngine = await probeCreate({
		chainId: CHAIN_ID,
		engine: {id: 'looks-legit-but-has-no-call'} as any,
	});

	// 6d) the WORKER path. `WorkerNodeOptions extends NodeOptions`, so `engine` is
	// structurally in scope there, but comlink structured-clones the options and an
	// engine is a function-bearing object: without a guard this is an opaque
	// `DataCloneError` from inside comlink — the plausible-looking failure the
	// honest-edge convention exists to prevent. A real Worker is supplied so the
	// refusal is demonstrably about the engine and not about a missing worker.
	const blobUrl = URL.createObjectURL(
		new Blob([''], {type: 'text/javascript'}),
	);
	const worker = new Worker(blobUrl);
	try {
		const wnode = await createWorkerNode({
			worker,
			chainId: CHAIN_ID,
			// `engine` is typed `never` on this path, so TypeScript stops it at compile
			// time; the cast is how a JS consumer (who has no compile step) arrives.
			engine: makeNoneOnlyEngine() as never,
		});
		out.workerEngine = `DID_NOT_THROW:${wnode.readEngine.id}`;
	} catch (e) {
		out.workerEngine = `threw:${(e as Error)?.name}:${String(
			(e as Error)?.message ?? e,
		)}`;
	} finally {
		worker.terminate();
		URL.revokeObjectURL(blobUrl);
	}

	return out;
}
