/**
 * rpc-block.ts — THE RPC BLOCK AND THE EVM DESCRIBE THE SAME BLOCK, ON BOTH SIDES
 * OF A `dumpState` / `loadState` ROUND TRIP.
 *
 * The defect this suite pins: a node created with `blockEnv: {coinbase,
 * prevRandao}` mined blocks whose `COINBASE` / `PREVRANDAO` opcodes returned the
 * configured values while `eth_getBlockByNumber` reported `miner: 0x00…00` and no
 * `mixHash` at all, and whose header `logsBloom` was a hard-coded 256 zero bytes
 * even when the block's receipts carried real ones — so a consumer doing the
 * standard thing (pre-filter blocks by the header bloom, then `eth_getLogs`) saw
 * nothing and had no way to learn why. Three header fields reporting a value the
 * block did not have.
 *
 * WHY THE RELOAD IS THE POINT AND NOT AN EXTRA. The RPC layer reads the
 * SERIALISED header (`SerializedBlock`), and the real coinbase / mixHash live on
 * the `Block` object beside it, so reading them off the block object alone would
 * answer correctly until someone reloaded a persisted state — after which the
 * reconstructed block has neither and the same RPC answers zero. An RPC that is
 * right before a reload and zero after it is worse than one that is uniformly
 * zero, because nothing tells the consumer which side of the trip they are on.
 * So EVERY assertion here is made twice: on the original node and on a fresh node
 * that was built with NO `blockEnv` of its own and knows only what `loadState`
 * gave it. If the reloaded node can still say what the coinbase was, the value
 * really did travel in the dump.
 *
 * ...AND THE EVM SIDE TRAVELS TOO. `eth_call` executes against the STORED `Block`
 * object of the latest block, so the reconstructed block is what a post-reload
 * read sees `COINBASE` / `PREVRANDAO` through. The probe contract is called on
 * both nodes and diffed against what each node's own RPC reports, which is the
 * "the RPC block and the EVM agree" property stated directly.
 *
 * THE THIRD NODE IS AN OLD DUMP. `SerializedBlock` gained these fields
 * BACKWARD-COMPATIBLY (they are optional and the format is still `version: 1`),
 * so a state dumped by the previous version must still load — and must produce a
 * ZERO miner / mixHash rather than an `undefined`-shaped block. Its bloom is the
 * one thing rebuilt rather than defaulted: the receipts are in the dump, so an
 * old dump's blocks can be given the bloom they always should have had.
 *
 * NOT ENGINE-PARAMETERISED, unlike the conformance battery beside it: block
 * construction, the block list and the RPC layer are the NODE's on every engine
 * (CONTEXT.md, *engine*), and what the engines could disagree about here — the
 * block environment a contract reads — is already diffed on both of them by the
 * conformance battery's `block environment through a contract` step. A revm twin
 * of this suite would re-measure the node's own serialisation.
 */
import {createNode, type SlimNode} from '../../src/index.js';
import {
	createWalletClient,
	createPublicClient,
	custom,
	decodeFunctionResult,
	encodeFunctionData,
	keccak256,
	type Hex,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {counterAbi, counterBytecode} from './counter.js';
import {
	blockEnvProbeAbi,
	blockEnvProbeRuntimeBytecode,
} from './block-env-probe.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const GENESIS_BALANCE = 10n ** 24n;

/**
 * The fixtures: a coinbase and a prevRandao no node could produce by accident, so
 * "it reported zero" and "it reported the block's value" are never the same
 * answer. Distinct from the conformance battery's pair on purpose — a suite that
 * shared them could pass on the other one's configuration.
 */
const COINBASE = '0x000000000000000000000000000000000b10c0de';
const PREV_RANDAO =
	'0x1337133713371337133713371337133713371337133713371337133713371337';
const PROBE_ADDR = '0x00000000000000000000000000000000b10ce7ee';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = '0x' + '00'.repeat(32);
const ZERO_BLOOM = '0x' + '00'.repeat(256);

const account = privateKeyToAccount(PK);
const chain = {
	id: CHAIN_ID,
	name: 'slim',
	nativeCurrency: {name: 'E', symbol: 'E', decimals: 18},
	rpcUrls: {default: {http: []}},
} as const;

/**
 * Is `item` (a 20-byte address or a 32-byte topic) in this 256-byte bloom?
 *
 * The M3:2048 membership test itself, written out rather than imported: viem
 * exports no bloom helper, and taking the node's own bloom code as the oracle
 * would make the assertion circular. `keccak256(item)`, then three 11-bit
 * indexes off its first six bytes, counted from the LOW end of the bitvector.
 */
function bloomContains(bloom: string, item: Hex): boolean {
	const bits = hexBytes(bloom);
	if (bits.length !== 256) return false;
	const h = hexBytes(keccak256(item));
	for (let i = 0; i < 3; i++) {
		const loc = ((h[i * 2] << 8) | h[i * 2 + 1]) & 2047;
		const byte = bits[256 - (loc >> 3) - 1];
		if ((byte & (1 << (loc % 8))) === 0) return false;
	}
	return true;
}

function hexBytes(s: string): Uint8Array {
	const body = s.startsWith('0x') ? s.slice(2) : s;
	const out = new Uint8Array(body.length / 2);
	for (let i = 0; i < out.length; i++)
		out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function clientsFor(node: SlimNode) {
	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	return {
		pub: createPublicClient({chain, transport}),
		wallet: createWalletClient({account, chain, transport}),
	};
}

/** Everything one node says about one of its blocks, through the RPC only. */
export interface BlockView {
	number: string;
	miner: string;
	mixHash: string;
	logsBloom: string;
	/** Does the header bloom admit the log this block really carries? */
	bloomAdmitsLogAddress: boolean;
	bloomAdmitsLogTopic: boolean;
}

/** ...and what the EVM tells a contract about the SAME block. */
export interface EvmView {
	coinbase: string;
	prevRandao: string;
}

export interface NodeView {
	genesis: BlockView;
	mined: BlockView;
	evm: EvmView;
	/** Every block 0..latest, as JSON, so the whole RPC block can be diffed. */
	allBlocksJson: string;
}

export interface RpcBlockReport {
	engineId: string;
	configured: {coinbase: string; prevRandao: string};
	/**
	 * THE CHAIN CONTINUES FROM THE HEAD IT REPORTS, after a reload. `loadState`
	 * rebuilds a `Block` object per stored header and takes the next block's
	 * `parentHash` from THAT object's own hash, so a reconstruction that dropped a
	 * header field would chain the next block onto a hash no consumer can look up.
	 * Stated through the RPC only, which is where a consumer would meet it.
	 */
	chainContinuesAfterReload: {
		headHashBeforeMining: string;
		newBlockParentHash: string;
		parentIsResolvable: boolean;
	};
	/** The node that mined the blocks, still holding its `blockEnv`. */
	origin: NodeView;
	/** A fresh node with NO `blockEnv`, holding only what `loadState` gave it. */
	reloaded: NodeView;
	/** The same dump with the three fields stripped: a state from the OLD version. */
	oldDump: {
		loads: boolean;
		latestBlockNumber: string;
		miner: string;
		mixHash: string;
		logsBloom: string;
		/** Rebuilt from the receipts the dump does carry, so it is not a lie. */
		bloomAdmitsLogTopic: boolean;
		/** The state still arrived, i.e. the compatibility is real and not a crash. */
		counterNumber: string;
	};
	/** Everything that disagreed. Empty = the two sides of the trip say the same. */
	mismatches: string[];
}

/** The `Incremented(uint256)` topic0 — what a bloom pre-filter would look for. */
const INCREMENTED_TOPIC = keccak256(
	new TextEncoder().encode('Incremented(uint256)'),
);

async function viewBlock(
	node: SlimNode,
	tag: string,
	log: {address?: string} = {},
): Promise<BlockView> {
	const b = (await node.request({
		method: 'eth_getBlockByNumber',
		params: [tag, false],
	})) as any;
	const logsBloom = String(b.logsBloom);
	return {
		number: String(b.number),
		miner: String(b.miner),
		mixHash: String(b.mixHash),
		logsBloom,
		bloomAdmitsLogAddress: log.address
			? bloomContains(logsBloom, log.address as Hex)
			: false,
		bloomAdmitsLogTopic: bloomContains(logsBloom, INCREMENTED_TOPIC),
	};
}

/** What the EVM hands a contract, read through `eth_call` against `latest`. */
async function viewEvm(node: SlimNode): Promise<EvmView> {
	const ret = (await node.request({
		method: 'eth_call',
		params: [
			{
				to: PROBE_ADDR,
				data: encodeFunctionData({abi: blockEnvProbeAbi, functionName: 'env'}),
			},
			'latest',
		],
	})) as Hex;
	const [, prevrandao, coinbase] = decodeFunctionResult({
		abi: blockEnvProbeAbi,
		functionName: 'env',
		data: ret,
	});
	return {
		coinbase: String(coinbase).toLowerCase(),
		prevRandao: `0x${prevrandao.toString(16).padStart(64, '0')}`,
	};
}

async function allBlocksJson(node: SlimNode): Promise<string> {
	const latest = Number(
		BigInt(String(await node.request({method: 'eth_blockNumber', params: []}))),
	);
	const out = [];
	for (let i = 0; i <= latest; i++)
		out.push(
			await node.request({
				method: 'eth_getBlockByNumber',
				params: [`0x${i.toString(16)}`, false],
			}),
		);
	return JSON.stringify(out);
}

async function viewNode(node: SlimNode, counter: string): Promise<NodeView> {
	return {
		genesis: await viewBlock(node, '0x0'),
		mined: await viewBlock(node, 'latest', {address: counter}),
		evm: await viewEvm(node),
		allBlocksJson: await allBlocksJson(node),
	};
}

function cmp(m: string[], label: string, got: unknown, want: unknown): void {
	if (String(got) !== String(want))
		m.push(`${label}: got=${String(got)} want=${String(want)}`);
}

export async function runRpcBlockChecks(): Promise<RpcBlockReport> {
	const mismatches: string[] = [];

	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: GENESIS_BALANCE},
		blockEnv: {coinbase: COINBASE, prevRandao: PREV_RANDAO},
	});
	// PLACED, not deployed: the read is the whole point, and placing it keeps the
	// probe out of the nonce sequence the Counter below occupies.
	await node.request({
		method: 'evm_setCode',
		params: [PROBE_ADDR, blockEnvProbeRuntimeBytecode],
	});

	const {pub, wallet} = clientsFor(node);
	const deployHash = await wallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const counter = String(
		(await pub.getTransactionReceipt({hash: deployHash})).contractAddress,
	);
	// ONE log-emitting transaction, in the LATEST block: the header bloom of that
	// block is what a consumer pre-filters on before calling `eth_getLogs`.
	const incHash = await wallet.writeContract({
		address: counter as `0x${string}`,
		abi: counterAbi,
		functionName: 'increment',
	});
	const incReceipt = await pub.getTransactionReceipt({hash: incHash});
	if (incReceipt.logs.length !== 1)
		mismatches.push(
			`fixture: expected 1 log in the latest block, got ${incReceipt.logs.length}`,
		);

	const origin = await viewNode(node, counter);

	// ---- THE OTHER SIDE OF THE TRIP -----------------------------------------
	// A fresh node with NO blockEnv and NO genesis funding: anything it can say
	// about the coinbase or the prevRandao travelled in the dump.
	const dump = await node.dumpState();
	const reloadedNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
	});
	await reloadedNode.loadState(dump);
	const reloaded = await viewNode(reloadedNode, counter);

	// ...and the reloaded chain CONTINUES from the head it reports.
	const headHashBeforeMining = String(
		(
			(await reloadedNode.request({
				method: 'eth_getBlockByNumber',
				params: ['latest', false],
			})) as any
		).hash,
	);
	const reloadedClients = clientsFor(reloadedNode);
	const nextHash = await reloadedClients.wallet.writeContract({
		address: counter as `0x${string}`,
		abi: counterAbi,
		functionName: 'increment',
	});
	const nextBlockNumber = (
		await reloadedClients.pub.getTransactionReceipt({hash: nextHash})
	).blockNumber;
	const nextBlock = (await reloadedNode.request({
		method: 'eth_getBlockByNumber',
		params: [`0x${nextBlockNumber.toString(16)}`, false],
	})) as any;
	const newBlockParentHash = String(nextBlock.parentHash);
	const parentIsResolvable =
		(await reloadedNode.request({
			method: 'eth_getBlockByHash',
			params: [newBlockParentHash, false],
		})) !== null;
	cmp(
		mismatches,
		'reloaded.nextBlock.parentHash',
		newBlockParentHash,
		headHashBeforeMining,
	);
	if (!parentIsResolvable)
		mismatches.push(
			'reloaded: the block mined after the reload names a parent no lookup resolves',
		);

	// ---- ...and a state dumped by the PREVIOUS version --------------------
	const oldDump = JSON.parse(JSON.stringify(dump));
	for (const b of oldDump.blocks) {
		delete b.miner;
		delete b.mixHash;
		delete b.logsBloom;
	}
	const oldNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
	});
	let loads = true;
	try {
		await oldNode.loadState(oldDump);
	} catch (e) {
		loads = false;
		mismatches.push(`oldDump: loadState threw ${String((e as Error).message)}`);
	}
	const oldLatest = loads
		? await viewBlock(oldNode, 'latest', {address: counter})
		: {
				number: '',
				miner: '',
				mixHash: '',
				logsBloom: '',
				bloomAdmitsLogAddress: false,
				bloomAdmitsLogTopic: false,
			};
	const counterNumber = loads
		? BigInt(
				String(
					await oldNode.request({
						method: 'eth_call',
						params: [
							{
								to: counter,
								data: encodeFunctionData({
									abi: counterAbi,
									functionName: 'number',
								}),
							},
							'latest',
						],
					}),
				),
			).toString()
		: '';

	// ---- the assertions ------------------------------------------------------
	for (const [where, v] of [
		['origin', origin],
		['reloaded', reloaded],
	] as [string, NodeView][]) {
		// (1) THE RPC BLOCK SAYS WHAT THE BLOCK IS.
		cmp(mismatches, `${where}.mined.miner`, v.mined.miner, COINBASE);
		cmp(mismatches, `${where}.mined.mixHash`, v.mined.mixHash, PREV_RANDAO);
		// (2) ...AND THE EVM AGREES WITH IT, about the same block.
		cmp(mismatches, `${where}.evm.coinbase`, v.evm.coinbase, v.mined.miner);
		cmp(
			mismatches,
			`${where}.evm.prevRandao`,
			v.evm.prevRandao,
			v.mined.mixHash,
		);
		// (3) GENESIS CARRIES THE CONFIGURATION TOO — block 0 used to be the one
		//     block that ignored `blockEnv` entirely.
		cmp(mismatches, `${where}.genesis.miner`, v.genesis.miner, COINBASE);
		cmp(mismatches, `${where}.genesis.mixHash`, v.genesis.mixHash, PREV_RANDAO);
		// (4) THE HEADER BLOOM ADMITS THE BLOCK'S OWN LOG, so pre-filtering by it
		//     cannot silently return nothing.
		if (v.mined.logsBloom === ZERO_BLOOM)
			mismatches.push(`${where}.mined.logsBloom is the zero placeholder`);
		if (!v.mined.bloomAdmitsLogAddress)
			mismatches.push(`${where}.mined bloom does not admit the log's address`);
		if (!v.mined.bloomAdmitsLogTopic)
			mismatches.push(`${where}.mined bloom does not admit the log's topic0`);
		// ...and genesis, which has no logs, still reports an empty one.
		cmp(
			mismatches,
			`${where}.genesis.logsBloom`,
			v.genesis.logsBloom,
			ZERO_BLOOM,
		);
	}
	// (5) THE WHOLE RPC BLOCK IS THE SAME ON BOTH SIDES OF THE TRIP, field for
	//     field, for every block — the property that makes the answer independent
	//     of whether a consumer has reloaded.
	if (origin.allBlocksJson !== reloaded.allBlocksJson)
		mismatches.push(
			`the RPC blocks differ across the round trip.\n  origin=${origin.allBlocksJson}\n  reloaded=${reloaded.allBlocksJson}`,
		);

	// (6) AN OLD DUMP STILL LOADS, and reads as ZERO rather than as `undefined`.
	cmp(mismatches, 'oldDump.miner', oldLatest.miner, ZERO_ADDRESS);
	cmp(mismatches, 'oldDump.mixHash', oldLatest.mixHash, ZERO_HASH);
	if (loads && !oldLatest.bloomAdmitsLogTopic)
		mismatches.push(
			"oldDump: the bloom was not rebuilt from the dump's own receipts",
		);
	if (loads && counterNumber !== '1')
		mismatches.push(`oldDump: counter number=${counterNumber} want=1`);

	const report: RpcBlockReport = {
		engineId: node.engine.id,
		configured: {coinbase: COINBASE, prevRandao: PREV_RANDAO},
		chainContinuesAfterReload: {
			headHashBeforeMining,
			newBlockParentHash,
			parentIsResolvable,
		},
		origin,
		reloaded,
		oldDump: {
			loads,
			latestBlockNumber: oldLatest.number,
			miner: oldLatest.miner,
			mixHash: oldLatest.mixHash,
			logsBloom: oldLatest.logsBloom,
			bloomAdmitsLogTopic: oldLatest.bloomAdmitsLogTopic,
			counterNumber,
		},
		mismatches,
	};

	await node.dispose();
	await reloadedNode.dispose();
	await oldNode.dispose();
	return report;
}
