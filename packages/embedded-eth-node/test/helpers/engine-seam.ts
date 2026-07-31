/**
 * engine-seam.ts — the EVM engine seam: the node's READ path runs on an ENGINE,
 * and with no engine supplied that engine is `@ethereumjs/evm` behaving exactly
 * as it did before the seam existed.
 *
 * What this pins:
 *   1. The DEFAULT engine is `@ethereumjs/evm`, named on the node as the READ
 *      engine (transactions run on `@ethereumjs/vm` whatever the engine is).
 *   2. All THREE read-path callers (`eth_call`, `eth_estimateGas` and
 *      `eth_fillTransaction`'s gas estimation) go through the engine — proven by
 *      an injected stub engine whose answers show up in all three.
 *   3. `eth_estimateGas` keeps its split: the ENGINE reports EXECUTION gas and
 *      the NODE adds intrinsic gas.
 *   4. A reverting engine result still surfaces as a real execution-reverted
 *      JSON-RPC error (code 3) carrying the return data.
 *   5. Transactions do NOT go through the read engine — the stub sees no extra
 *      call when a signed tx is mined, which is exactly why the node names it
 *      `readEngine` and not `engine`.
 *   6. The default engine keeps the EIP-2929 warm/access reset AND the
 *      checkpoint/revert that the pure-read path has always done: a repeated
 *      `eth_estimateGas` for a warm SSTORE returns the SAME number (dropping the
 *      reset makes the second one ~2000 gas too low), and an `eth_call` that
 *      would write leaves state untouched.
 */
import {createNode} from '../../src/index.js';
import type {
	ReadEngine,
	ReadCallRequest,
	ReadCallResult,
} from '../../src/index.js';
import {bytesToHex, hexToBytes} from '@ethereumjs/util';
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

/** The stub's fixed answers — values no real EVM would produce for these calls. */
const STUB_RETURN = ('0x' + '2a'.repeat(32)) as `0x${string}`;
const STUB_EXECUTION_GAS = 12_345n;
/** Intrinsic gas for a call with EMPTY calldata: base only, no per-byte cost. */
const INTRINSIC_EMPTY_CALL = 21_000n;

const TARGET = '0x0000000000000000000000000000000000001234';

export async function runEngineSeamChecks() {
	const out: Record<string, unknown> = {};

	// ---------- 1) the DEFAULT engine ----------
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
	});
	out.defaultReadEngineId = node.readEngine.id;

	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	const pub = createPublicClient({chain, transport});
	const wallet = createWalletClient({account, chain, transport});

	const deployHash = await wallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const address = (await pub.getTransactionReceipt({hash: deployHash}))
		.contractAddress!;
	const incrementData = encodeFunctionData({
		abi: counterAbi,
		functionName: 'increment',
	});

	// 6a) EIP-2929 reset: estimating the same warm SSTORE twice must give the SAME
	// number. Without the reset the second estimate is ~2000 gas too low, and viem
	// would use it as a gas LIMIT for the real tx (which then runs out of gas).
	const estimateIncrement = async () =>
		String(
			await node.request({
				method: 'eth_estimateGas',
				params: [{from: account.address, to: address, data: incrementData}],
			}),
		);
	out.estimateIncrement1 = await estimateIncrement();
	out.estimateIncrement2 = await estimateIncrement();
	out.estimateIncrementStable =
		out.estimateIncrement1 === out.estimateIncrement2;

	// 6b) purity: an eth_call that WOULD write leaves state alone.
	const readNumber = async () =>
		(
			await pub.readContract({address, abi: counterAbi, functionName: 'number'})
		).toString();
	const numberBefore = await readNumber();
	await node.request({
		method: 'eth_call',
		params: [{from: account.address, to: address, data: incrementData}],
	});
	const numberAfter = await readNumber();
	out.callDidNotMutateState = numberBefore === numberAfter;
	out.number = numberAfter;

	await node.dispose();

	// ---------- 2) an INJECTED engine ----------
	const seen: {to?: string; data: string; gasLimit: string}[] = [];
	let connectedStateMode: string | undefined;
	let connectedStateManagerUsable = false;
	let connectCount = 0;

	const stub: ReadEngine = {
		id: 'test-stub',
		connect(ctx) {
			connectCount++;
			connectedStateMode = ctx.stateMode;
			connectedStateManagerUsable =
				typeof ctx.stateManager?.getAccount === 'function';
		},
		async call(req: ReadCallRequest): Promise<ReadCallResult> {
			seen.push({
				to: req.to?.toString(),
				data: bytesToHex(req.data),
				gasLimit: req.gasLimit.toString(),
			});
			return {
				returnValue: hexToBytes(STUB_RETURN),
				executionGasUsed: STUB_EXECUTION_GAS,
			};
		},
	};

	const stubNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
		engine: stub,
	});
	out.stubReadEngineId = stubNode.readEngine.id;
	out.stubConnectCount = connectCount;
	out.stubConnectedStateMode = connectedStateMode;
	out.stubConnectedStateManagerUsable = connectedStateManagerUsable;

	// eth_call -> the engine's return data, verbatim.
	out.stubCallResult = await stubNode.request({
		method: 'eth_call',
		params: [{from: account.address, to: TARGET}],
	});
	out.stubCallExpected = STUB_RETURN;
	// eth_estimateGas -> engine EXECUTION gas + node intrinsic gas.
	out.stubEstimate = await stubNode.request({
		method: 'eth_estimateGas',
		params: [{from: account.address, to: TARGET}],
	});
	out.stubEstimateExpected =
		'0x' + (STUB_EXECUTION_GAS + INTRINSIC_EMPTY_CALL).toString(16);
	// eth_fillTransaction -> the same estimate on the filled `gas` field.
	const filled = (await stubNode.request({
		method: 'eth_fillTransaction',
		params: [{from: account.address, to: TARGET}],
	})) as {tx: {gas: string}};
	out.stubFilledGas = filled.tx.gas;
	out.stubCallsSeen = seen.length; // the three read-path callers, once each

	// 5) a TRANSACTION does not touch the read engine (it runs on @ethereumjs/vm).
	const stubTransport = custom(
		{request: ({method, params}: any) => stubNode.request({method, params})},
		{retryCount: 0},
	);
	const stubPub = createPublicClient({chain, transport: stubTransport});
	const stubWallet = createWalletClient({
		account,
		chain,
		transport: stubTransport,
	});
	const txHash = await stubWallet.sendTransaction({
		to: TARGET,
		value: 1n,
		gas: 21_000n,
	});
	const rcpt = await stubPub.getTransactionReceipt({hash: txHash});
	out.stubTxStatus = rcpt.status;
	out.stubTxGasUsed = rcpt.gasUsed.toString();
	out.stubCallsAfterTx = seen.length;
	out.stubTargetBalance = (
		await stubPub.getBalance({address: TARGET})
	).toString();

	await stubNode.dispose();

	// ---------- 3) a REVERTING engine result stays an honest error ----------
	const revertingNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		engine: {
			id: 'test-reverting',
			async call(): Promise<ReadCallResult> {
				return {
					returnValue: hexToBytes('0xdeadbeef'),
					executionGasUsed: 7n,
					error: 'revert',
				};
			},
		},
	});
	try {
		await revertingNode.request({
			method: 'eth_call',
			params: [{from: account.address, to: TARGET}],
		});
		out.revertingCall = 'DID_NOT_THROW';
	} catch (e: any) {
		out.revertingCall = `threw:${e?.code ?? '?'}:${e?.data ?? '?'}`;
	}
	await revertingNode.dispose();

	return out;
}
