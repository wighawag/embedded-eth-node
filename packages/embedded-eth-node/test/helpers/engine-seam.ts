/**
 * engine-seam.ts — the EVM engine seam: the node's read path AND its transactions
 * run on an ENGINE, and with no engine supplied that engine is `@ethereumjs/evm`
 * behaving exactly as it did before the seam existed.
 *
 * What this pins:
 *   1. The DEFAULT engine is `@ethereumjs/evm`, named on the node as `engine`.
 *   2. All THREE read-path callers (`eth_call`, `eth_estimateGas` and
 *      `eth_fillTransaction`'s gas estimation) go through the engine — proven by
 *      an injected stub engine whose answers show up in all three.
 *   3. `eth_estimateGas` keeps its split: the ENGINE reports EXECUTION gas and
 *      the NODE adds intrinsic gas.
 *   4. A reverting engine result still surfaces as a real execution-reverted
 *      JSON-RPC error (code 3) carrying the return data.
 *   5. An engine that implements ONLY the read half leaves transactions on the
 *      node's own `@ethereumjs/vm` — the read stub sees no extra `call` when a
 *      signed tx is mined, and that tx still produces a real receipt.
 *   6. The default engine keeps the EIP-2929 warm/access reset AND the
 *      checkpoint/revert that the pure-read path has always done: a repeated
 *      `eth_estimateGas` for a warm SSTORE returns the SAME number (dropping the
 *      reset makes the second one ~2000 gas too low), and an `eth_call` that
 *      would write leaves state untouched.
 *   7. THE MINING PATH GOES THROUGH THE ENGINE: an engine that implements
 *      `transact` executes the transaction, and the node's receipt is assembled
 *      from the neutral {@link TransactionResult} it returned — status, gas used,
 *      effective gas price, logs in emission order, the bloom. A stub returning
 *      values no EVM would produce is what tells "the node asked the engine" apart
 *      from "the node ran `runTx` itself and the numbers happen to match".
 */
import {createNode} from '../../src/index.js';
import type {
	Engine,
	ReadCallRequest,
	ReadCallResult,
	TransactionRequest,
	TransactionResult,
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

/**
 * The transacting stub's fixed answers — again, values no real EVM would produce
 * for a 21000-gas transfer, so a receipt carrying them proves the ENGINE executed
 * the transaction and the node built the receipt from what it reported.
 */
const STUB_TX_GAS_USED = 31_337n;
const STUB_TX_EFFECTIVE_GAS_PRICE = 7n;
const STUB_LOG_ADDRESS = '0x00000000000000000000000000000000000000ff';
const STUB_LOG_TOPIC = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const STUB_LOG_DATA = '0xc0ffee' as `0x${string}`;
/** A bloom no EVM would compute for that log: recognisable, and 256 bytes long. */
const STUB_LOGS_BLOOM = ('0x' + 'bb' + '00'.repeat(255)) as `0x${string}`;

export async function runEngineSeamChecks() {
	const out: Record<string, unknown> = {};

	// ---------- 1) the DEFAULT engine ----------
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
	});
	out.defaultEngineId = node.engine.id;

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

	const stub: Engine = {
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
	out.stubEngineId = stubNode.engine.id;
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

	// 5) an engine with NO transaction half leaves the tx on @ethereumjs/vm: the
	// read engine sees no extra call, and the tx is executed and mined as ever.
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

	// ---------- 7) an engine that TRANSACTS owns the mining path ----------
	// The receipt below can only be built from what this stub returned: it never
	// touches state, so `@ethereumjs/vm` cannot have produced any of these numbers.
	const transacted: {
		hash: string;
		sender: string;
		to?: string;
		blockNumber: string;
		gasLimit: string;
	}[] = [];
	const transactingStub: Engine = {
		id: 'test-transacting-stub',
		async call(): Promise<ReadCallResult> {
			return {returnValue: new Uint8Array(), executionGasUsed: 0n};
		},
		async transact(req: TransactionRequest): Promise<TransactionResult> {
			transacted.push({
				hash: bytesToHex(req.tx.hash()),
				sender: req.tx.getSenderAddress().toString(),
				to: (req.tx as any).to?.toString(),
				blockNumber: req.block.header.number.toString(),
				gasLimit: (req.tx as any).gasLimit.toString(),
			});
			return {
				status: 1,
				gasUsed: STUB_TX_GAS_USED,
				effectiveGasPrice: STUB_TX_EFFECTIVE_GAS_PRICE,
				logs: [
					{
						address: hexToBytes(STUB_LOG_ADDRESS),
						topics: [hexToBytes(STUB_LOG_TOPIC)],
						data: hexToBytes(STUB_LOG_DATA),
					},
				],
				logsBloom: hexToBytes(STUB_LOGS_BLOOM),
			};
		},
	};

	const txNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
		engine: transactingStub,
	});
	const txTransport = custom(
		{request: ({method, params}: any) => txNode.request({method, params})},
		{retryCount: 0},
	);
	const txPub = createPublicClient({chain, transport: txTransport});
	const txWallet = createWalletClient({account, chain, transport: txTransport});
	const engineTxHash = await txWallet.sendTransaction({
		to: TARGET,
		value: 1n,
		gas: 21_000n,
	});
	const engineRcpt = await txPub.getTransactionReceipt({hash: engineTxHash});
	out.engineTxSeen = transacted.length;
	out.engineTxHashSeen = transacted[0]?.hash;
	out.engineTxHashExpected = engineTxHash;
	out.engineTxSenderSeen = transacted[0]?.sender;
	out.engineTxSenderExpected = account.address.toLowerCase();
	out.engineTxToSeen = transacted[0]?.to;
	out.engineTxBlockNumberSeen = transacted[0]?.blockNumber;
	out.engineTxGasLimitSeen = transacted[0]?.gasLimit;
	// ...and every receipt field the seam's result owns comes from the engine.
	out.engineRcptStatus = engineRcpt.status;
	out.engineRcptGasUsed = engineRcpt.gasUsed.toString();
	out.engineRcptGasUsedExpected = STUB_TX_GAS_USED.toString();
	out.engineRcptEffectiveGasPrice = engineRcpt.effectiveGasPrice.toString();
	out.engineRcptEffectiveGasPriceExpected =
		STUB_TX_EFFECTIVE_GAS_PRICE.toString();
	out.engineRcptCumulativeGasUsed = engineRcpt.cumulativeGasUsed.toString();
	out.engineRcptContractAddress = engineRcpt.contractAddress ?? null;
	out.engineRcptLogsBloom = engineRcpt.logsBloom;
	out.engineRcptLogsBloomExpected = STUB_LOGS_BLOOM;
	out.engineRcptLogCount = engineRcpt.logs.length;
	out.engineRcptLogAddress = engineRcpt.logs[0]?.address?.toLowerCase();
	out.engineRcptLogAddressExpected = STUB_LOG_ADDRESS;
	out.engineRcptLogTopics = engineRcpt.logs[0]?.topics;
	out.engineRcptLogTopicsExpected = [STUB_LOG_TOPIC];
	out.engineRcptLogData = engineRcpt.logs[0]?.data;
	out.engineRcptLogDataExpected = STUB_LOG_DATA;
	// eth_getLogs reads the same logs out of the block the node built.
	out.engineBlockLogCount = (
		(await txNode.request({
			method: 'eth_getLogs',
			params: [{fromBlock: '0x0', toBlock: 'latest'}],
		})) as unknown[]
	).length;
	// The node's own half is untouched: this engine moved no ether at all, so the
	// balance the node reports is the one its state manager holds.
	out.engineTxTargetBalance = (
		await txPub.getBalance({address: TARGET})
	).toString();

	await txNode.dispose();

	return out;
}
