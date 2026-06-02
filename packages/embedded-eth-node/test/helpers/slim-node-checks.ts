/**
 * slim-node-checks.ts — in-browser correctness + honesty assertions for the node,
 * covering the common in-browser-node pitfalls and proving it does NOT have them:
 *   1. LEGACY (type-0) tx receipt does NOT crash (the effectiveGasPrice pitfall).
 *   2. EIP-1559 receipt has effectiveGasPrice too.
 *   3. Account/signing methods fail LOUDLY (method-not-found), never fake success.
 *   4. dump/load persistence round-trips (state survives into a fresh node).
 */
import {
	createNode,
	createMemoryPersistence,
	RpcError,
} from '../../src/index.js';
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

	await node.dispose();
	await node2.dispose();
	return out;
}
