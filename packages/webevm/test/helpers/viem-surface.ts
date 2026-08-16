/**
 * viem-surface.ts — drive the slim node through the call sequences a REAL
 * viem/wagmi app produces, to SURFACE method gaps (any `-32601`) before a real
 * integration hits them. This is a coverage/observability probe, not a
 * correctness oracle (correctness lives in conformance.ts): we intercept every
 * EIP-1193 method viem emits, run the common public/wallet-client actions, and
 * report which methods were called and which were unsupported.
 *
 * Covered actions (the typical dapp lifecycle):
 *   - getChainId / getBlockNumber / getBlock / getGasPrice / estimateFeesPerGas
 *     (the last drives eth_feeHistory + eth_maxPriorityFeePerGas),
 *   - deployContract (signed) + waitForTransactionReceipt (RECEIPT POLLING path),
 *   - readContract (eth_call), simulateContract (eth_call + estimateGas),
 *   - writeContract (signed) + waitForTransactionReceipt,
 *   - getBalance / getTransactionCount / getCode / getStorageAt,
 *   - getTransaction / getTransactionReceipt,
 *   - getLogs (event filter), watchBlocks (newHeads subscription via onNewHead).
 */
import {
	createWalletClient,
	createPublicClient,
	custom,
	parseAbiItem,
	type EIP1193RequestFn,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {createTxFromRLP} from '@ethereumjs/tx';
import {hexToBytes} from '@ethereumjs/util';
import {createNode, type SlimNode} from '../../src/index.js';
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

export interface SurfaceReport {
	/** Every distinct EIP-1193 method viem emitted during the lifecycle. */
	methodsSeen: string[];
	/** Methods that threw -32601 (method-not-found) — the GAPS to be aware of. */
	unsupported: string[];
	/** Methods that threw a NON -32601 error (real failures — should be empty). */
	errored: {method: string; code: unknown; message: string}[];
	/** A few sanity values proving the lifecycle actually ran end-to-end. */
	deployedAddress: string;
	finalNumber: string;
	numberAfterAll: string;
	receiptPollingWorked: boolean;
	watchBlocksFired: boolean;
	callCounts: Record<string, number>;
	rawTxNonces: number[];
	/**
	 * `eth_feeHistory`'s `reward` widths, per block, for a 3-percentile request and
	 * a 1-percentile one: the shape a caller INDEXES, which is what a flat fee
	 * model makes it easy to get wrong (see the call site).
	 */
	feeHistoryRewardWidths: {threePercentiles: number[]; onePercentile: number[]};
}

export async function viemSurfaceProbe(): Promise<SurfaceReport> {
	const node: SlimNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
	});

	const methodsSeen = new Set<string>();
	const unsupported = new Set<string>();
	const errored: {method: string; code: unknown; message: string}[] = [];
	const callCounts: Record<string, number> = {};
	const rawTxNonces: number[] = [];

	// Intercept EVERY method viem sends so we can report the surface it exercised.
	const request: EIP1193RequestFn = (async ({method, params}: any) => {
		methodsSeen.add(method);
		callCounts[method] = (callCounts[method] ?? 0) + 1;
		if (
			method === 'eth_sendRawTransaction' ||
			method === 'eth_sendRawTransactionSync'
		) {
			try {
				const t = createTxFromRLP(hexToBytes((params as any[])[0]));
				rawTxNonces.push(Number((t as any).nonce));
			} catch {
				/* best-effort diagnostic */
			}
		}
		try {
			return await node.request({method, params});
		} catch (e: any) {
			if (e?.code === -32601) unsupported.add(method);
			else
				errored.push({method, code: e?.code, message: String(e?.message ?? e)});
			throw e;
		}
	}) as EIP1193RequestFn;

	const transport = custom({request}, {retryCount: 0});
	const pub = createPublicClient({chain, transport});
	const wallet = createWalletClient({account, chain, transport});

	// --- read-side warmup the way wagmi hooks do on mount ---
	await pub.getChainId();
	await pub.getBlockNumber();
	await pub.getBlock(); // eth_getBlockByNumber(full=false)
	await safe(() => pub.getGasPrice());
	// estimateFeesPerGas drives eth_maxPriorityFeePerGas (EIP-1559).
	await safe(() => pub.estimateFeesPerGas());
	// Explicitly exercise eth_feeHistory too (viem's default fee estimator may not
	// call it, but consumers do — make sure it's covered + answered).
	//
	// AND CHECK THE SHAPE, not just that it answered: `reward` carries ONE entry
	// per REQUESTED PERCENTILE, per block. A response with a single entry however
	// many were asked for is well-formed enough to parse and wrong for anybody who
	// INDEXES it — rocketh asks for three and reads indices 1 and 2, which came back
	// `undefined` and failed as "Cannot mix BigInt and other types" far from here.
	// This node has a flat fee model, so the VALUES are all the same and asserting
	// them would measure nothing; the WIDTHS are the property, and they are read
	// for two different request lengths so that a hardcoded 3 fails too.
	const feeHistory = await safe(() =>
		pub.getFeeHistory({blockCount: 4, rewardPercentiles: [25, 50, 75]}),
	);
	const rewardWidths = (fh: unknown): number[] =>
		((fh as {reward?: unknown[][]} | undefined)?.reward ?? []).map(
			(r) => r.length,
		);
	const feeHistoryRewardWidths = {
		threePercentiles: rewardWidths(feeHistory),
		onePercentile: rewardWidths(
			await safe(() =>
				pub.getFeeHistory({blockCount: 2, rewardPercentiles: [50]}),
			),
		),
	};

	// --- deploy via walletClient (signed) + RECEIPT POLLING (waitFor...) ---
	const deployHash = await wallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const deployRcpt = await pub.waitForTransactionReceipt({hash: deployHash});
	const address = deployRcpt.contractAddress!;
	const receiptPollingWorked = Boolean(address);

	// --- read contract (eth_call) + simulate (eth_call + estimateGas) ---
	await pub.readContract({address, abi: counterAbi, functionName: 'number'});
	await safe(() =>
		pub.simulateContract({
			account,
			address,
			abi: counterAbi,
			functionName: 'increment',
		}),
	);
	await safe(() =>
		pub.estimateContractGas({
			account,
			address,
			abi: counterAbi,
			functionName: 'increment',
		}),
	);

	// --- write (signed) + receipt polling, a couple of times ---
	for (let i = 0; i < 2; i++) {
		const h = await wallet.writeContract({
			address,
			abi: counterAbi,
			functionName: 'increment',
		});
		await pub.waitForTransactionReceipt({hash: h});
	}
	const finalNumber = (
		await pub.readContract({address, abi: counterAbi, functionName: 'number'})
	).toString();

	// --- the rest of the common read surface ---
	await pub.getBalance({address: account.address});
	await pub.getTransactionCount({address: account.address});
	await pub.getBytecode({address}); // eth_getCode
	await safe(() => pub.getStorageAt({address, slot: '0x0'}));
	await pub.getTransaction({hash: deployHash});
	await pub.getTransactionReceipt({hash: deployHash});

	// --- event logs (eth_getLogs) ---
	await pub.getLogs({
		address,
		event: parseAbiItem('event Incremented(uint256 newValue)'),
		fromBlock: 0n,
		toBlock: 'latest',
	});

	// --- watchBlocks (newHeads subscription). viem uses eth_subscribe when the
	//     transport supports it; our node also exposes onNewHead for the comlink
	//     path. We test BOTH: the subscription method surface + an explicit head. ---
	let watchBlocksFired = false;
	const unwatch = pub.watchBlocks({
		onBlock: () => {
			watchBlocksFired = true;
		},
		emitMissed: false,
		emitOnBegin: false,
		// poll:false relies on the node's own head subscription; the custom
		// transport's type insists on poll:true, so cast to allow it.
		poll: false,
	} as unknown as Parameters<typeof pub.watchBlocks>[0]);
	// also register a direct head listener (the API the Worker path uses)
	const off = node.onNewHead(() => {
		watchBlocksFired = true;
	});
	// trigger a head by mining one more tx
	const h = await wallet.writeContract({
		address,
		abi: counterAbi,
		functionName: 'increment',
	});
	await pub.waitForTransactionReceipt({hash: h});
	await new Promise((r) => setTimeout(r, 20));
	unwatch();
	off();

	// Total increments that landed across the whole lifecycle: 2 explicit writes +
	// 1 watchBlocks-trigger write = 3. This is the regression guard for the
	// estimate-leak bug (used to be 1: only the first write survived).
	const numberAfterAll = (
		await pub.readContract({address, abi: counterAbi, functionName: 'number'})
	).toString();

	await node.dispose();

	return {
		methodsSeen: [...methodsSeen].sort(),
		unsupported: [...unsupported].sort(),
		errored,
		deployedAddress: address,
		finalNumber, // number() after the 2 explicit writes (== '2' when healthy)
		numberAfterAll, // number() after all 3 writes (== '3' when healthy)
		receiptPollingWorked,
		watchBlocksFired,
		callCounts,
		rawTxNonces,
		feeHistoryRewardWidths,
	};
}

/** Run an action that MAY hit an unsupported method; swallow -32601 so the probe
 *  keeps going and the gap is captured in `unsupported`. Re-throw real errors. */
async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
	try {
		return await fn();
	} catch (e: any) {
		// viem wraps RPC errors; -32601 may be nested. Detect it loosely.
		const s = JSON.stringify(e?.cause ?? e?.details ?? e?.message ?? '');
		if (
			e?.code === -32601 ||
			s.includes('-32601') ||
			s.includes('method not found') ||
			s.includes('not supported')
		)
			return undefined;
		throw e;
	}
}
