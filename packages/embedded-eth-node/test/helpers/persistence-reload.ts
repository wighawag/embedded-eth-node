/**
 * persistence-reload.ts — prove the slim node's IndexedDB persistence survives a
 * REAL page reload (not just a same-context dump/load), AND that eth_getLogs still
 * works after reload.
 *
 *   - phase 'write': create a node wired to createIndexedDBPersistence(), deploy a
 *     Counter, send a few increment() txs (each emits an Incremented event), and a
 *     value transfer. Persistence auto-saves to IndexedDB after each mined tx. We
 *     return the pre-reload facts (number, logs count, a balance) so the test can
 *     compare them to the post-reload read.
 *   - phase 'read' (after page.reload(), which WIPES all JS state): create a FRESH
 *     node with the SAME persistence adapter. It auto-loads from IndexedDB on
 *     creation. We then re-query everything THROUGH the freshly-loaded node:
 *     contract storage (number()), account balance, AND eth_getLogs — asserting
 *     the events (address/topics/data/logIndex/blockNumber) survived the reload.
 *
 * This is the canonical dapp scenario: persist a local chain to IndexedDB, reload
 * the tab, keep playing and keep querying event logs.
 */
import {
	createNode,
	createIndexedDBPersistence,
	type SlimNode,
} from '../../src/index.js';
import {
	createWalletClient,
	createPublicClient,
	custom,
	parseAbiItem,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {counterAbi, counterBytecode} from './counter.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const DB_NAME = 'slim-reload-test';
const account = privateKeyToAccount(PK);
const chain = {
	id: CHAIN_ID,
	name: 'slim',
	nativeCurrency: {name: 'E', symbol: 'E', decimals: 18},
	rpcUrls: {default: {http: []}},
} as const;
const XFER_TO = '0x000000000000000000000000000000000000feed';
const INCREMENTED = parseAbiItem('event Incremented(uint256 newValue)');

function clientsFor(node: SlimNode) {
	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	return {
		pub: createPublicClient({chain, transport}),
		wallet: createWalletClient({account, chain, transport}),
		node,
	};
}

export interface WriteResult {
	address: string;
	number: string;
	logCount: number;
	firstLogTopics: string[];
	blockNumber: number;
	feedBalance: string;
}

/** phase 'write': build state + persist to IndexedDB, then report pre-reload facts. */
export async function persistWrite(): Promise<WriteResult> {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		persistence: createIndexedDBPersistence({db: DB_NAME}),
		initialBalances: {[account.address]: 10n ** 24n},
	});
	const {pub, wallet} = clientsFor(node);

	const deployHash = await wallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const address = (await pub.getTransactionReceipt({hash: deployHash}))
		.contractAddress!;

	// 3 increments (each emits Incremented) + a value transfer.
	for (let i = 0; i < 3; i++) {
		const h = await wallet.writeContract({
			address,
			abi: counterAbi,
			functionName: 'increment',
		});
		await pub.getTransactionReceipt({hash: h});
	}
	const xfer = await wallet.sendTransaction({to: XFER_TO, value: 7777n});
	await pub.getTransactionReceipt({hash: xfer});

	const number = (
		await pub.readContract({address, abi: counterAbi, functionName: 'number'})
	).toString();
	const logs = await pub.getLogs({
		address,
		event: INCREMENTED,
		fromBlock: 0n,
		toBlock: 'latest',
	});
	const feedBalance = (await pub.getBalance({address: XFER_TO})).toString();
	const blockNumber = Number(await pub.getBlockNumber());

	await node.dispose();
	return {
		address,
		number,
		logCount: logs.length,
		firstLogTopics: logs[0]?.topics ?? [],
		blockNumber,
		feedBalance,
	};
}

export interface ReadResult {
	loaded: boolean;
	number: string;
	blockNumber: number;
	feedBalance: string;
	// eth_getLogs AFTER reload:
	logCount: number;
	logIndexesOrdered: boolean;
	logBlockNumbersPresent: boolean;
	addressFilteredCount: number; // getLogs filtered by the contract address
	topicFilteredCount: number; // getLogs filtered by Incremented topic0
	lastEventValue: string; // decoded newValue of the last Incremented (== number)
}

/** phase 'read' (after reload): fresh node auto-loads IndexedDB; re-query all. */
export async function persistRead(address: string): Promise<ReadResult> {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		persistence: createIndexedDBPersistence({db: DB_NAME}),
		// NOTE: no initialBalances — state must come ENTIRELY from IndexedDB.
	});
	const {pub} = clientsFor(node);

	const blockNumber = Number(await pub.getBlockNumber());
	const loaded = blockNumber > 0; // genesis-only would be 0

	const number = (
		await pub.readContract({
			address: address as `0x${string}`,
			abi: counterAbi,
			functionName: 'number',
		})
	).toString();
	const feedBalance = (await pub.getBalance({address: XFER_TO})).toString();

	// eth_getLogs through the freshly-loaded node, three ways:
	const all = await pub.getLogs({fromBlock: 0n, toBlock: 'latest'});
	const byAddr = await pub.getLogs({
		address: address as `0x${string}`,
		fromBlock: 0n,
		toBlock: 'latest',
	});
	const byTopic = await pub.getLogs({
		event: INCREMENTED,
		fromBlock: 0n,
		toBlock: 'latest',
	});

	// logIndex is WITHIN a block (correct EVM semantics); auto-mine puts each tx in
	// its own block, so the global order is by (blockNumber, logIndex). Assert that
	// tuple is strictly increasing across the returned logs.
	let ordered = true;
	for (let i = 1; i < byAddr.length; i++) {
		const prev =
			(BigInt(byAddr[i - 1].blockNumber ?? 0n) << 32n) +
			BigInt(byAddr[i - 1].logIndex ?? 0);
		const cur =
			(BigInt(byAddr[i].blockNumber ?? 0n) << 32n) +
			BigInt(byAddr[i].logIndex ?? 0);
		if (cur <= prev) ordered = false;
	}
	const blockNumbersPresent = byAddr.every(
		(l) => l.blockNumber != null && l.blockNumber > 0n,
	);
	const lastEventValue =
		byTopic.length > 0
			? BigInt(
					(byTopic[byTopic.length - 1] as any).args?.newValue ?? 0n,
				).toString()
			: '0';

	await node.dispose();
	return {
		loaded,
		number,
		blockNumber,
		feedBalance,
		logCount: all.length,
		logIndexesOrdered: ordered,
		logBlockNumbersPresent: blockNumbersPresent,
		addressFilteredCount: byAddr.length,
		topicFilteredCount: byTopic.length,
		lastEventValue,
	};
}
