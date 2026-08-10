/**
 * conformance.ts — DIFFERENTIAL conformance of the slim node's receipt/RPC layer
 * against a trusted reference EVM running the SAME signed txs, in real Chromium.
 *
 * WHY differential (not ethereum/tests fixtures): GeneralStateTests /
 * execution-spec-tests verify a tx by comparing the post-state Merkle-Patricia
 * TRIE ROOT (+ keccak(RLP(logs))). The default slim node (`stateMode:'none'`,
 * SimpleStateManager) has NO trie/root on purpose and throws on getStateRoot, so
 * those fixtures cannot validate it without reintroducing a trie — and VMTests
 * (the one trie-free format) is frozen at Homestead. The legacy effectiveGasPrice
 * bug this node guards against is a RECEIPT/RPC-layer concern none of them cover.
 * See the package README "On comprehensive EVM test fixtures".
 *
 * The reference here is the SAME engine (@ethereumjs/vm runTx) WITH a trie-backed
 * MerkleStateManager, set up BY HAND with the same Common (Cancun, chainId 31337,
 * noble keccak), same baseFee and same genesis balances — the closest in-process
 * oracle. We run a battery of signed raw txs through BOTH:
 *   1. the slim node (eth_sendRawTransactionSync -> receipt; eth_call -> output),
 *   2. the reference runTx,
 * and assert field-by-field equality of receipt / logs / return-data / estimateGas
 * / post-state reads. We run it against BOTH slim-node state modes ('none' AND
 * 'trie') so the cheap default fast path is covered too.
 *
 * The battery is ENGINE-PARAMETERISED (see {@link runConformanceOnEngine}): the
 * same steps run with an injected engine, so `embedded-eth-node/revm` faces this
 * bar rather than a softer one of its own — and it faces the WHOLE of it, because
 * an engine implements both halves of the seam: every signed transaction below is
 * executed and committed by the installed engine, and every receipt and
 * post-state read is diffed against the reference all the same. The engine is
 * built PER NODE by a factory, not shared: an engine instance serves exactly one
 * node (the revm engine refuses a second `createNode()` outright), and the
 * battery builds two.
 */
import {createVM, runTx, type VM} from '@ethereumjs/vm';
import {MerkleStateManager} from '@ethereumjs/statemanager';
import {Common, Mainnet, Hardfork} from '@ethereumjs/common';
import {createBlock, type Block} from '@ethereumjs/block';
import {createTxFromRLP, type TypedTransaction} from '@ethereumjs/tx';
import {
	createAddressFromString,
	Account,
	hexToBytes,
	bytesToHex,
	setLengthLeft,
	bigIntToBytes,
	type PrefixedHexString,
} from '@ethereumjs/util';
import {keccak_256} from '@noble/hashes/sha3.js';
import {encodeFunctionData, encodeDeployData, decodeFunctionResult} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {
	createNode,
	type Engine,
	type SlimNode,
	type StateMode,
} from '../../src/index.js';
import {counterAbi, counterBytecode} from './counter.js';
import {probeAbi, probeBytecode} from './probe.js';
import {
	blockEnvProbeAbi,
	blockEnvProbeRuntimeBytecode,
} from './block-env-probe.js';
import {classifyValueRead, OK, REJECTED} from './affordability.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const BASE_FEE = 1_000_000_000n;

/**
 * The block-environment step's fixtures: a coinbase and a prevRandao no engine
 * could produce by accident, so "it read zero" and "it read the node's value"
 * are never the same answer.
 */
const BLOCK_ENV_PROBE_ADDR = '0x00000000000000000000000000000000b10ce7ee';
const BLOCK_ENV_COINBASE = '0x00000000000000000000000000000000c0173a5e';
const BLOCK_ENV_PREV_RANDAO =
	'0x5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed';
const GENESIS_BALANCE = 10n ** 24n;

/**
 * The value-bearing-read step's fixtures: a plain codeless address to send to,
 * and a sender that holds nothing at all on either chain.
 */
const VALUE_SINK_ADDR = '0x0000000000000000000000000000000000005151';
const UNFUNDED_SENDER = '0x00000000000000000000000000000000dead0001';
/**
 * The value-bearing step's NEGATIVE CONTROL callee: runtime code that reverts
 * WITH one byte of return data (`PUSH1 ff, PUSH0, MSTORE8, PUSH1 01, PUSH0,
 * REVERT`). It fails the same call the same way a refused transfer does — an
 * engine failure, JSON-RPC code 3 — and is told apart by the CALLEE ANSWER in
 * its return data, which a refused transfer never produces.
 */
const REVERT_WITH_REASON_ADDR = '0x000000000000000000000000000000000bad0bad';
const REVERT_WITH_REASON_CODE = '0x60ff5f5360015ffd';
/** The node's default `from` when an `eth_call` names no sender. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * The block-gas-limit step's fixtures: the gas limits and the two nodes are
 * chosen so that the SAME transaction is refused on one node and mined on the
 * other, and the only difference between the nodes is the configured
 * `blockGasLimit`.
 */
const DEFAULT_BLOCK_GAS_LIMIT = 30_000_000n;
const RAISED_BLOCK_GAS_LIMIT = 60_000_000n;
/** Above the default limit, below the raised one: the divergent transaction. */
const OVER_DEFAULT_TX_GAS = 40_000_000n;
/** Above BOTH, so the raised node refuses it against its OWN configured limit. */
const OVER_RAISED_TX_GAS = RAISED_BLOCK_GAS_LIMIT + 1n;
const account = privateKeyToAccount(PK);

function hx(b: Uint8Array): string {
	return bytesToHex(b) as string;
}

// ---------------------------------------------------------------------------
// Reference EVM: SAME @ethereumjs/vm engine, hand-wired with a trie-backed state
// manager. This is the in-process oracle the slim node is diffed against.
// ---------------------------------------------------------------------------
interface RefReceipt {
	status: 0 | 1;
	gasUsed: bigint;
	cumulativeGasUsed: bigint;
	contractAddress: string | null;
	effectiveGasPrice: bigint;
	type: number;
	logsBloom: string;
	logs: {
		address: string;
		topics: string[];
		data: string;
		logIndex: number;
		transactionIndex: number;
	}[];
}

class Reference {
	common: Common;
	sm: MerkleStateManager;
	vm!: VM;
	latest = 0;
	parentHash: Uint8Array;
	private blocks = new Map<number, Block>();

	constructor() {
		this.common = new Common({
			chain: {...Mainnet, chainId: CHAIN_ID, name: 'reference'},
			hardfork: Hardfork.Cancun,
			customCrypto: {keccak256: (m: Uint8Array) => keccak_256(m)},
		});
		this.sm = new MerkleStateManager();
		this.parentHash = hexToBytes(`0x${'00'.repeat(32)}`);
	}

	async setup() {
		const self = this;
		const mockBlockchain: any = {
			getBlock: async (n: bigint | Uint8Array) => {
				const num = n instanceof Uint8Array ? self.latest : Number(n);
				return self.blocks.get(num) ?? self.blocks.get(self.latest)!;
			},
			putBlock: async () => {},
			shallowCopy() {
				return mockBlockchain;
			},
		};
		this.vm = await createVM({
			common: this.common,
			stateManager: this.sm,
			blockchain: mockBlockchain,
		});
		await this.sm.putAccount(
			createAddressFromString(account.address),
			new Account(0n, GENESIS_BALANCE),
		);
		const genesis = createBlock(
			{
				header: {
					number: 0n,
					gasLimit: 30_000_000n,
					baseFeePerGas: BASE_FEE,
					timestamp: 0n,
				},
			},
			{common: this.common},
		);
		this.blocks.set(0, genesis);
		this.parentHash = genesis.hash();
	}

	private effectiveGasPrice(tx: TypedTransaction): bigint {
		const anyTx = tx as any;
		if (anyTx.maxFeePerGas !== undefined && anyTx.maxFeePerGas !== null) {
			const maxFee: bigint = anyTx.maxFeePerGas;
			const maxPrio: bigint = anyTx.maxPriorityFeePerGas ?? 0n;
			const tip = maxFee - BASE_FEE < maxPrio ? maxFee - BASE_FEE : maxPrio;
			return tip + BASE_FEE;
		}
		return anyTx.gasPrice as bigint;
	}

	/** Mine ONE block containing `raws`, returning per-tx reference receipts. */
	async mineBlock(raws: string[]): Promise<RefReceipt[]> {
		const number = BigInt(this.latest + 1);
		const block = createBlock(
			{
				header: {
					number,
					gasLimit: 30_000_000n,
					baseFeePerGas: BASE_FEE,
					parentHash: this.parentHash,
					timestamp: 0n,
				},
			},
			{common: this.common},
		);
		const out: RefReceipt[] = [];
		let cumulative = 0n;
		let txIndex = 0;
		let logCounter = 0;
		for (const raw of raws) {
			const tx = createTxFromRLP(hexToBytes(raw as PrefixedHexString), {
				common: this.common,
			});
			const res = await runTx(this.vm, {
				tx,
				block,
				skipBlockGasLimitValidation: true,
				skipHardForkValidation: true,
			});
			cumulative += res.totalGasSpent;
			const logs = (res.execResult.logs ?? []).map((log) => ({
				address: hx(log[0]),
				topics: log[1].map((t) => hx(t)),
				data: hx(log[2]),
				logIndex: logCounter++,
				transactionIndex: txIndex,
			}));
			out.push({
				status: (res.receipt as any).status === 0 ? 0 : 1,
				gasUsed: res.totalGasSpent,
				cumulativeGasUsed: cumulative,
				contractAddress: res.createdAddress
					? res.createdAddress.toString()
					: null,
				effectiveGasPrice: this.effectiveGasPrice(tx),
				type: (tx as any).type ?? 0,
				logsBloom: hx(res.bloom.bitvector),
				logs,
			});
			txIndex++;
		}
		this.blocks.set(Number(number), block);
		this.latest = Number(number);
		this.parentHash = block.hash();
		return out;
	}

	/** Pure read: run a call without mutating state (checkpoint/revert). */
	async call(params: {
		to?: string;
		from?: string;
		data?: string;
		value?: bigint;
	}): Promise<{
		returnValue: string;
		totalGasSpent: bigint;
		reverted: boolean;
	}> {
		// Use runTx-equivalent gas accounting by running the call then estimating via
		// a signed-style execution. For return-data + revert we use evm.runCall; for
		// exact gas we rely on runTx in the battery (see estimateGas diff below).
		await this.sm.checkpoint();
		try {
			const res = await this.vm.evm.runCall({
				caller: createAddressFromString(
					params.from ?? '0x0000000000000000000000000000000000000000',
				),
				to: params.to ? createAddressFromString(params.to) : undefined,
				data: params.data
					? hexToBytes(params.data as PrefixedHexString)
					: new Uint8Array(),
				value: params.value ?? 0n,
				gasLimit: 30_000_000n,
				block: this.blocks.get(this.latest) as any,
			});
			return {
				returnValue: hx(res.execResult.returnValue),
				totalGasSpent: res.execResult.executionGasUsed,
				reverted: Boolean(res.execResult.exceptionError),
			};
		} finally {
			await this.sm.revert();
		}
	}

	async getBalance(addr: string): Promise<bigint> {
		return (
			(await this.sm.getAccount(createAddressFromString(addr)))?.balance ?? 0n
		);
	}
	async getNonce(addr: string): Promise<bigint> {
		return (
			(await this.sm.getAccount(createAddressFromString(addr)))?.nonce ?? 0n
		);
	}
	async getCode(addr: string): Promise<string> {
		return hx(await this.sm.getCode(createAddressFromString(addr)));
	}
	async getStorageAt(addr: string, slot: bigint): Promise<string> {
		const val = await this.sm.getStorage(
			createAddressFromString(addr),
			setLengthLeft(bigIntToBytes(slot), 32),
		);
		return hx(setLengthLeft(val, 32));
	}
}

// ---------------------------------------------------------------------------
// The transaction battery is built inline below; each step signs a raw tx (so it
// goes through the exact eth_sendRawTransaction path) and diffs against the ref.
// ---------------------------------------------------------------------------
interface BuildCtx {
	nonce: number;
	counterAddr?: string;
	probeAddr?: string;
}

/** Post-state reads to diff between the slim node and the reference. */
interface ReadSpec {
	balances?: string[];
	nonces?: string[];
	codes?: string[];
	storage?: {addr: string; slot: bigint}[];
}

const COMMON_FEES = {
	maxFeePerGas: 2_000_000_000n,
	maxPriorityFeePerGas: 1_000_000_000n,
} as const;

async function sign1559(args: any): Promise<string> {
	return account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		...COMMON_FEES,
		...args,
	});
}
async function signLegacy(args: any): Promise<string> {
	return account.signTransaction({
		chainId: CHAIN_ID,
		type: 'legacy',
		gasPrice: BASE_FEE,
		...args,
	});
}
async function sign2930(args: any): Promise<string> {
	return account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip2930',
		gasPrice: BASE_FEE,
		accessList: [],
		...args,
	});
}

/**
 * Builds ONE engine for ONE node. `undefined` (or no factory) leaves the node on
 * its default `@ethereumjs/evm` engine, which is what the unparameterised
 * battery runs.
 */
export type EngineFactory = () => Promise<Engine>;

export interface BatteryReport {
	stateMode: StateMode;
	/** Which EVM the node was created with, as the node itself reports it. */
	engineId: string;
	steps: {label: string; mismatches: string[]}[];
	totalMismatches: number;
}

// ---------------------------------------------------------------------------
// Run the WHOLE battery against one slim-node state mode, diffing every step
// against the reference. Returns a structured report of mismatches (empty = pass).
// ---------------------------------------------------------------------------
async function runBattery(
	stateMode: StateMode,
	makeEngine?: EngineFactory,
): Promise<BatteryReport> {
	const node: SlimNode = await createNode({
		chainId: CHAIN_ID,
		stateMode,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: GENESIS_BALANCE},
		engine: await makeEngine?.(),
	});
	const ref = new Reference();
	await ref.setup();

	const ctx: BuildCtx = {nonce: 0};
	const steps: {label: string; mismatches: string[]}[] = [];

	// ---- helpers to compare a mined slim-node receipt against the reference ----
	const cmp = (m: string[], field: string, a: unknown, b: unknown) => {
		const av = typeof a === 'bigint' ? a.toString() : a;
		const bv = typeof b === 'bigint' ? b.toString() : b;
		if (JSON.stringify(av) !== JSON.stringify(bv))
			m.push(`${field}: node=${JSON.stringify(av)} ref=${JSON.stringify(bv)}`);
	};

	/** Mine a SINGLE-tx block through both engines and diff the receipt. */
	async function oneTxBlock(
		label: string,
		raw: string,
		opts: {expectCreate?: boolean} = {},
	) {
		const m: string[] = [];
		const refRcpts = await ref.mineBlock([raw]);
		const r = refRcpts[0];
		const txHash = (await node.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		})) as any;
		// sync path returns the receipt object directly
		const nr = txHash;
		cmp(m, 'status', nr.status, '0x' + r.status.toString(16));
		cmp(m, 'gasUsed', BigInt(nr.gasUsed), r.gasUsed);
		cmp(
			m,
			'cumulativeGasUsed',
			BigInt(nr.cumulativeGasUsed),
			r.cumulativeGasUsed,
		);
		cmp(
			m,
			'contractAddress',
			(nr.contractAddress ?? null)?.toLowerCase?.() ?? null,
			r.contractAddress,
		);
		cmp(
			m,
			'effectiveGasPrice',
			BigInt(nr.effectiveGasPrice),
			r.effectiveGasPrice,
		);
		cmp(m, 'type', BigInt(nr.type), BigInt(r.type));
		cmp(m, 'logsBloom', nr.logsBloom, r.logsBloom);
		cmp(m, 'logCount', nr.logs.length, r.logs.length);
		for (let i = 0; i < Math.max(nr.logs.length, r.logs.length); i++) {
			const nl = nr.logs[i];
			const rl = r.logs[i];
			cmp(m, `log[${i}].address`, nl?.address?.toLowerCase(), rl?.address);
			cmp(
				m,
				`log[${i}].topics`,
				nl?.topics?.map((t: string) => t.toLowerCase()),
				rl?.topics,
			);
			cmp(m, `log[${i}].data`, nl?.data, rl?.data);
			cmp(
				m,
				`log[${i}].logIndex`,
				BigInt(nl?.logIndex ?? -1),
				BigInt(rl?.logIndex ?? -1),
			);
			cmp(
				m,
				`log[${i}].transactionIndex`,
				BigInt(nl?.transactionIndex ?? -1),
				BigInt(rl?.transactionIndex ?? -1),
			);
		}
		if (opts.expectCreate && !nr.contractAddress)
			m.push('expected a created contract address');
		steps.push({label, mismatches: m});
		return nr;
	}

	// view-call return-data diff
	async function viewCallMatches(label: string, to: string, data: string) {
		const m: string[] = [];
		const nodeRet = (await node.request({
			method: 'eth_call',
			params: [{to, data}, 'latest'],
		})) as string;
		const refRet = await ref.call({to, data, from: account.address});
		cmp(m, 'eth_call return-data', nodeRet, refRet.returnValue);
		steps.push({label, mismatches: m});
	}

	// post-state reads diff
	async function readsMatch(label: string, r: ReadSpec) {
		const m: string[] = [];
		for (const addr of r.balances ?? []) {
			const nb = BigInt(
				(await node.request({
					method: 'eth_getBalance',
					params: [addr, 'latest'],
				})) as string,
			);
			cmp(m, `balance(${addr})`, nb, await ref.getBalance(addr));
		}
		for (const addr of r.nonces ?? []) {
			const nn = BigInt(
				(await node.request({
					method: 'eth_getTransactionCount',
					params: [addr, 'latest'],
				})) as string,
			);
			cmp(m, `nonce(${addr})`, nn, await ref.getNonce(addr));
		}
		for (const addr of r.codes ?? []) {
			const nc = (await node.request({
				method: 'eth_getCode',
				params: [addr, 'latest'],
			})) as string;
			cmp(m, `code(${addr})`, nc, await ref.getCode(addr));
		}
		for (const s of r.storage ?? []) {
			const ns = (await node.request({
				method: 'eth_getStorageAt',
				params: [s.addr, '0x' + s.slot.toString(16), 'latest'],
			})) as string;
			cmp(
				m,
				`storage(${s.addr},${s.slot})`,
				ns,
				await ref.getStorageAt(s.addr, s.slot),
			);
		}
		steps.push({label, mismatches: m});
	}

	// === BATTERY ===

	// 1) EIP-1559 (type-2) deploy of the Counter (contract create + code deposit).
	{
		const data = encodeDeployData({
			abi: counterAbi,
			bytecode: counterBytecode,
		});
		const raw = await sign1559({nonce: ctx.nonce, data, gas: 1_000_000n});
		// oneTxBlock mines the SAME raw tx in BOTH the reference and the slim node and
		// diffs the receipt; the created address comes back from the node receipt.
		const nr = await oneTxBlock('1559-deploy(Counter)', raw, {
			expectCreate: true,
		});
		ctx.counterAddr = (nr.contractAddress as string).toLowerCase();
		ctx.nonce++;
		await readsMatch('1559-deploy(Counter) post-state', {
			codes: [ctx.counterAddr],
			nonces: [account.address],
		});
	}

	// 2) EIP-1559 (type-2) contract call: increment() — emits one log, writes storage.
	{
		const data = encodeFunctionData({
			abi: counterAbi,
			functionName: 'increment',
		});
		const raw = await sign1559({
			nonce: ctx.nonce,
			to: ctx.counterAddr,
			data,
			gas: 200_000n,
		});
		await oneTxBlock('1559-call(increment)', raw);
		ctx.nonce++;
		// view: number() == 1
		const view = encodeFunctionData({abi: counterAbi, functionName: 'number'});
		await viewCallMatches(
			'1559-call(increment) view number()',
			ctx.counterAddr!,
			view,
		);
		await readsMatch('1559-call(increment) post-state', {
			storage: [{addr: ctx.counterAddr!, slot: 0n}],
		});
	}

	// 3) EIP-1559 (type-2) value transfer to an EOA.
	{
		const to = '0x00000000000000000000000000000000000000aa';
		const raw = await sign1559({
			nonce: ctx.nonce,
			to,
			value: 12345n,
			gas: 21_000n,
		});
		await oneTxBlock('1559-value-transfer', raw);
		ctx.nonce++;
		await readsMatch('1559-value-transfer post-state', {
			balances: [to, account.address],
		});
	}

	// 4) LEGACY (type-0) value transfer — THE effectiveGasPrice bite, legacy path.
	{
		const to = '0x00000000000000000000000000000000000000bb';
		const raw = await signLegacy({
			nonce: ctx.nonce,
			to,
			value: 99n,
			gas: 21_000n,
		});
		await oneTxBlock('legacy-value-transfer', raw);
		ctx.nonce++;
		await readsMatch('legacy-value-transfer post-state', {balances: [to]});
	}

	// 5) LEGACY (type-0) contract call: add(7) — log + storage, legacy receipt path.
	{
		const data = encodeFunctionData({
			abi: counterAbi,
			functionName: 'add',
			args: [7n],
		});
		const raw = await signLegacy({
			nonce: ctx.nonce,
			to: ctx.counterAddr,
			data,
			gas: 200_000n,
		});
		await oneTxBlock('legacy-call(add)', raw);
		ctx.nonce++;
		await readsMatch('legacy-call(add) post-state', {
			storage: [{addr: ctx.counterAddr!, slot: 0n}],
		});
	}

	// 6) EIP-2930 (type-1) access-list contract call: increment().
	{
		const data = encodeFunctionData({
			abi: counterAbi,
			functionName: 'increment',
		});
		const raw = await sign2930({
			nonce: ctx.nonce,
			to: ctx.counterAddr,
			data,
			gas: 200_000n,
			accessList: [
				{address: ctx.counterAddr!, storageKeys: ['0x' + '00'.repeat(32)]},
			],
		});
		await oneTxBlock('2930-call(increment, access-list)', raw);
		ctx.nonce++;
	}

	// 7) EIP-1559 deploy of the ConformanceProbe (used for revert + multi-log).
	{
		const data = encodeDeployData({
			abi: probeAbi,
			bytecode: probeBytecode,
		});
		const raw = await sign1559({nonce: ctx.nonce, data, gas: 1_000_000n});
		const nr = await oneTxBlock('1559-deploy(Probe)', raw, {
			expectCreate: true,
		});
		ctx.probeAddr = (nr.contractAddress as string).toLowerCase();
		ctx.nonce++;
	}

	// 8) Multi-log tx: emitTwo(a,b) emits TWO events — assert logIndex ordering.
	{
		const data = encodeFunctionData({
			abi: probeAbi,
			functionName: 'emitTwo',
			args: [3n, 4n],
		});
		const raw = await sign1559({
			nonce: ctx.nonce,
			to: ctx.probeAddr,
			data,
			gas: 200_000n,
		});
		const nr = await oneTxBlock('multi-log(emitTwo)', raw);
		const m: string[] = [];
		if (nr.logs.length !== 2) m.push(`expected 2 logs, got ${nr.logs.length}`);
		if (nr.logs.length === 2) {
			if (BigInt(nr.logs[0].logIndex) !== 0n) m.push(`first log logIndex != 0`);
			if (BigInt(nr.logs[1].logIndex) !== 1n)
				m.push(`second log logIndex != 1`);
		}
		steps.push({label: 'multi-log(emitTwo) ordering', mismatches: m});
		ctx.nonce++;
	}

	// 9) Reverting tx: boom() — status 0, gas still charged, no logs.
	{
		const data = encodeFunctionData({abi: probeAbi, functionName: 'boom'});
		const raw = await sign1559({
			nonce: ctx.nonce,
			to: ctx.probeAddr,
			data,
			gas: 200_000n,
		});
		const nr = await oneTxBlock('reverting(boom)', raw);
		const m: string[] = [];
		if (nr.status !== '0x0') m.push(`expected status 0x0, got ${nr.status}`);
		if (BigInt(nr.gasUsed) <= 21_000n)
			m.push(`expected gas > intrinsic on revert`);
		if (nr.logs.length !== 0) m.push(`expected 0 logs on revert`);
		steps.push({label: 'reverting(boom) charges gas, status 0', mismatches: m});
		ctx.nonce++;
	}

	// 10) eth_estimateGas exactness: estimate a fresh increment() and compare to the
	//     reference runTx totalGasSpent for the SAME call mined in the reference.
	{
		const data = encodeFunctionData({
			abi: counterAbi,
			functionName: 'increment',
		});
		// mine in reference to obtain exact totalGasSpent for this call shape/nonce
		const raw = await sign1559({
			nonce: ctx.nonce,
			to: ctx.counterAddr,
			data,
			gas: 200_000n,
		});
		// estimate FIRST (pure, no state change) then mine in both to keep nonces aligned
		const est = (await node.request({
			method: 'eth_estimateGas',
			params: [{from: account.address, to: ctx.counterAddr, data}],
		})) as string;
		const refRcpts = await ref.mineBlock([raw]);
		const m: string[] = [];
		cmp(m, 'estimateGas==refTotalGasSpent', BigInt(est), refRcpts[0].gasUsed);
		// now mine the SAME tx in the node so its nonce advances identically
		await node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
		steps.push({label: 'estimateGas exactness (increment)', mismatches: m});
		ctx.nonce++;
	}

	// 11) Intrinsic-floor + EIP-3860 initcode: deploy with estimateGas exactness on
	//     a CREATE (initcode word cost must be counted). Estimate vs reference runTx.
	{
		const data = encodeDeployData({
			abi: probeAbi,
			bytecode: probeBytecode,
		});
		const raw = await sign1559({nonce: ctx.nonce, data, gas: 1_000_000n});
		const est = (await node.request({
			method: 'eth_estimateGas',
			params: [{from: account.address, data}],
		})) as string;
		const refRcpts = await ref.mineBlock([raw]);
		const m: string[] = [];
		cmp(
			m,
			'estimateGas(CREATE)==refTotalGasSpent',
			BigInt(est),
			refRcpts[0].gasUsed,
		);
		await node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
		steps.push({
			label: 'estimateGas CREATE incl. EIP-3860 initcode',
			mismatches: m,
		});
		ctx.nonce++;
	}

	// 12) Back-to-back txs in ONE block: cumulativeGasUsed accumulation + tx/log
	//     indices. Auto mode mines one block PER tx, so to get two txs in ONE block
	//     we use a fresh manual-mining node: deploy, then queue two calls and mine
	//     a single block. We assert the cumulative/index invariants (the reference
	//     runTx already proved per-tx gas equality in steps above).
	{
		const d1 = encodeFunctionData({abi: counterAbi, functionName: 'increment'});
		const d2 = encodeFunctionData({
			abi: counterAbi,
			functionName: 'add',
			args: [5n],
		});
		const m: string[] = [];
		const node2 = await createNode({
			chainId: CHAIN_ID,
			stateMode,
			miningConfig: {type: 'manual'},
			initialBalances: {[account.address]: GENESIS_BALANCE},
			// Its OWN engine: one engine instance serves one node.
			engine: await makeEngine?.(),
		});
		const depData = encodeDeployData({
			abi: counterAbi,
			bytecode: counterBytecode,
		});
		const depRaw = await sign1559({nonce: 0, data: depData, gas: 1_000_000n});
		await node2.request({method: 'eth_sendRawTransaction', params: [depRaw]});
		await node2.mine();
		// get the deployed addr via the node's block + receipt store
		const bn = (await node2.request({
			method: 'eth_getBlockByNumber',
			params: ['latest', true],
		})) as any;
		const deployedAddr = (
			(await node2.request({
				method: 'eth_getTransactionReceipt',
				params: [bn.transactions[0].hash],
			})) as any
		).contractAddress.toLowerCase();
		const c1 = await sign1559({
			nonce: 1,
			to: deployedAddr,
			data: d1,
			gas: 200_000n,
		});
		const c2 = await sign1559({
			nonce: 2,
			to: deployedAddr,
			data: d2,
			gas: 200_000n,
		});
		await node2.request({method: 'eth_sendRawTransaction', params: [c1]});
		await node2.request({method: 'eth_sendRawTransaction', params: [c2]});
		await node2.mine();
		const blk = (await node2.request({
			method: 'eth_getBlockByNumber',
			params: ['latest', true],
		})) as any;
		const rc1 = (await node2.request({
			method: 'eth_getTransactionReceipt',
			params: [blk.transactions[0].hash],
		})) as any;
		const rc2 = (await node2.request({
			method: 'eth_getTransactionReceipt',
			params: [blk.transactions[1].hash],
		})) as any;
		if (blk.transactions.length !== 2)
			m.push(`expected 2 txs in block, got ${blk.transactions.length}`);
		cmp(m, 'tx0.transactionIndex', BigInt(rc1.transactionIndex), 0n);
		cmp(m, 'tx1.transactionIndex', BigInt(rc2.transactionIndex), 1n);
		cmp(
			m,
			'cumulativeGasUsed accumulation',
			BigInt(rc2.cumulativeGasUsed),
			BigInt(rc1.gasUsed) + BigInt(rc2.gasUsed),
		);
		cmp(
			m,
			'tx0.cumulative==tx0.gasUsed',
			BigInt(rc1.cumulativeGasUsed),
			BigInt(rc1.gasUsed),
		);
		cmp(m, 'tx0.logIndex', BigInt(rc1.logs[0].logIndex), 0n);
		cmp(m, 'tx1.logIndex', BigInt(rc2.logs[0].logIndex), 1n);
		steps.push({
			label: 'back-to-back txs in one block (cumulative + indices)',
			mismatches: m,
		});
		await node2.dispose();
		ctx.nonce += 0; // node2 is independent; ctx.nonce unchanged
	}

	// 13) BLOCK ENVIRONMENT read THROUGH A CONTRACT: BASEFEE / PREVRANDAO /
	//     COINBASE / NUMBER / TIMESTAMP / GASLIMIT.
	//
	//     WHY THIS STEP EXISTS AND NOTHING ELSE COVERS IT. Every one of these
	//     opcodes is fee- and gas-independent: an engine can hand a contract a
	//     completely different block environment while charging byte-identical gas
	//     and returning identical receipts. So the cross-backend gas gate cannot
	//     see it, the receipt diff above cannot see it, and the only instrument
	//     that can is a contract that READS them inside an `eth_call`. (The revm
	//     engine used to zero the base fee to buy `eth_call`-from-an-unfunded-
	//     address, which this step would have caught the day it landed.)
	//
	//     THE ORACLE IS THE NODE'S OWN BLOCK, not the reference EVM: the reference
	//     is a separate chain built by hand with its own timestamps and its own
	//     zero coinbase, so diffing block-environment reads against it would
	//     measure that difference rather than the engine's honesty. What is
	//     diffed is "what the engine told the contract" against "what the node
	//     says the block is" — and because this battery runs on the default engine
	//     (conformance.spec.ts) AND on revm (revm-conformance.spec.ts), holding
	//     both to the same block is exactly a cross-engine diff.
	{
		const m: string[] = [];
		// Its OWN node, so the block environment can carry a distinctive coinbase
		// and prevRandao without perturbing the receipt battery above (and its OWN
		// engine: one engine instance serves one node).
		const node3 = await createNode({
			chainId: CHAIN_ID,
			stateMode,
			miningConfig: {type: 'manual'},
			blockEnv: {
				coinbase: BLOCK_ENV_COINBASE,
				prevRandao: BLOCK_ENV_PREV_RANDAO,
			},
			engine: await makeEngine?.(),
		});
		// The code is PLACED rather than deployed: the read is the whole point, and
		// placing it keeps this step independent of the nonce/receipt sequence above.
		await node3.request({
			method: 'evm_setCode',
			params: [BLOCK_ENV_PROBE_ADDR, blockEnvProbeRuntimeBytecode],
		});
		// One mined block, so the read runs against a block carrying the configured
		// environment (genesis carries neither).
		await node3.mine();
		const head = (await node3.request({
			method: 'eth_getBlockByNumber',
			params: ['latest', false],
		})) as any;
		// No `from`: the default zero address, which holds no ether — the case the
		// zeroed base fee used to buy, now bought by the simulation switches.
		const ret = (await node3.request({
			method: 'eth_call',
			params: [
				{
					to: BLOCK_ENV_PROBE_ADDR,
					data: encodeFunctionData({
						abi: blockEnvProbeAbi,
						functionName: 'env',
					}),
				},
				'latest',
			],
		})) as `0x${string}`;
		const [basefee, prevrandao, coinbase, number, timestamp, gaslimit] =
			decodeFunctionResult({
				abi: blockEnvProbeAbi,
				functionName: 'env',
				data: ret,
			});
		cmp(m, 'BASEFEE', basefee, BigInt(head.baseFeePerGas));
		cmp(m, 'NUMBER', number, BigInt(head.number));
		cmp(m, 'TIMESTAMP', timestamp, BigInt(head.timestamp));
		cmp(m, 'GASLIMIT', gaslimit, BigInt(head.gasLimit));
		// COINBASE and PREVRANDAO are diffed against what the node was CONFIGURED
		// with: `eth_getBlockByNumber` reports neither (its `miner` is a constant
		// zero and it carries no `mixHash`), so the configuration is the only
		// statement of what the block actually is.
		cmp(m, 'COINBASE', coinbase.toLowerCase(), BLOCK_ENV_COINBASE);
		cmp(m, 'PREVRANDAO', prevrandao, BigInt(BLOCK_ENV_PREV_RANDAO));
		// ...and the fixtures really are non-zero, so "reads zero" can never pass
		// this step by coincidence.
		if (basefee === 0n)
			m.push('BASEFEE fixture was zero — step proves nothing');
		if (prevrandao === 0n)
			m.push('PREVRANDAO fixture was zero — step proves nothing');
		steps.push({label: 'block environment through a contract', mismatches: m});
		await node3.dispose();
	}

	// 14) A VALUE-BEARING READ IS STILL SUBJECT TO THE VALUE TRANSFER: an
	//     `eth_call` carrying `value` the sender cannot afford must FAIL, and one
	//     it can afford must SUCCEED, identically on every engine.
	//
	//     WHY THIS STEP EXISTS. `eth_call` semantics relax the TRANSACTION
	//     validity rules (the gas-fee check, the base-fee check, EIP-3607), and
	//     that is what lets a read run from an address holding no ether. They do
	//     NOT relax the transfer itself: geth's `eth_call` still fails an
	//     unaffordable value with `ErrInsufficientBalance`, and `@ethereumjs/evm`
	//     agrees (`_reduceSenderBalance` throws `insufficient balance`). An engine
	//     that fabricates the caller's balance to serve a read would answer a
	//     transfer that could never happen: the same class of lie as the base fee
	//     this battery's block-environment step exists to catch, and just as
	//     invisible to the gas gate, since a validation failure charges no gas at
	//     all on either engine.
	//
	//     THE ORACLE IS ABSOLUTE, not the reference EVM: what is asserted is
	//     whether the READ succeeded or failed, per sender and per value, so both
	//     engines are held to the same statement rather than to each other.
	//
	//     AND A FAILURE IS NOT ACCEPTED ON THE STRENGTH OF HAVING FAILED. Each
	//     negative case must fail in the SHAPE of a refused transfer (an engine
	//     rejection, JSON-RPC code 3, carrying no CALLEE answer), and the
	//     rejection must track the sender's balance TO THE WEI: `value == balance`
	//     succeeds and `value == balance + 1` fails, same sender, same call site.
	//     Nothing but a balance check draws that line, so an unrelated failure (a
	//     param refusal, a construction error, a callee that reverted with a
	//     reason) turns this step RED instead of passing as "it did not succeed".
	//     Two such failures are ISSUED below as negative controls, so the step's
	//     ability to go red for the right reason is demonstrated rather than
	//     asserted.
	//
	//     What is NOT checkable here is the engine's own words for it
	//     (`insufficient balance` / revm's quoted `LackOfFundForMaxFee`): the node
	//     flattens every engine error into one `execution reverted`, so those are
	//     asserted one layer down, at the seam, in ./revm-engine.ts. What DOES
	//     survive is the error's `data`, and it is now the same on both engines
	//     (`0x`): revm used to echo its validation message there, where a client
	//     decodes a revert reason, and `src/revm.ts` drops those bytes instead of
	//     forwarding them — which is why ./affordability.ts no longer needs a
	//     tolerance for engine text and treats ANY return data as the callee's.
	//     The two engines are held to the same bytes, for this call and for a real
	//     revert, in ./revm-engine.ts. See ./affordability.ts for the whole
	//     classification.
	{
		const m: string[] = [];
		const node4 = await createNode({
			chainId: CHAIN_ID,
			stateMode,
			miningConfig: {type: 'manual'},
			initialBalances: {[account.address]: GENESIS_BALANCE},
			engine: await makeEngine?.(),
		});
		// The zero address is the node's default `from` AND its default coinbase,
		// so on a node that has mined priority-fee-paying transactions it holds
		// ether. This node mines nothing, but the fixture is CHECKED rather than
		// assumed: an accidentally funded default sender would make the two cases
		// below pass for the wrong reason.
		const zeroAddressBalance = (await node4.request({
			method: 'eth_getBalance',
			params: [ZERO_ADDRESS, 'latest'],
		})) as string;
		if (BigInt(zeroAddressBalance) !== 0n)
			m.push(
				`default sender (zero address) holds ${zeroAddressBalance}, so its cases prove nothing`,
			);
		// The funded sender's balance is READ rather than assumed, because the
		// boundary cases below are stated in terms of it: the rejection must begin
		// at exactly `balance + 1`, which is only a statement about affordability if
		// `balance` is the node's own number.
		const fundedBalance = BigInt(
			(await node4.request({
				method: 'eth_getBalance',
				params: [account.address, 'latest'],
			})) as string,
		);
		if (fundedBalance !== GENESIS_BALANCE)
			m.push(
				`funded sender holds ${fundedBalance}, expected the genesis balance ${GENESIS_BALANCE}`,
			);
		// A plain value transfer to a CODELESS address, so what is measured is the
		// transfer and nothing a contract might do with it.
		const cases: {label: string; from?: string; value: bigint; ok: boolean}[] =
			[
				// The property the zeroed base fee used to buy, and the one this step
				// must not regress: a read from an address holding no ether.
				{
					label: 'unfunded sender, value 0',
					from: UNFUNDED_SENDER,
					value: 0n,
					ok: true,
				},
				// ...and the node's own default `from`, the zero address.
				{label: 'default sender (zero address), value 0', value: 0n, ok: true},
				{
					label: 'funded sender, affordable value',
					from: account.address,
					value: 1n,
					ok: true,
				},
				// The WHOLE balance, to the wei: the last value the sender can afford,
				// and the case that makes the rejection below a statement about
				// affordability rather than about value-bearing reads in general.
				{
					label: 'funded sender, value == balance',
					from: account.address,
					value: fundedBalance,
					ok: true,
				},
				// The three a fabricated balance would wrongly answer.
				{
					label: 'unfunded sender, value 1 wei',
					from: UNFUNDED_SENDER,
					value: 1n,
					ok: false,
				},
				{
					label: 'default sender (zero address), value 1 wei',
					value: 1n,
					ok: false,
				},
				// ...and the other side of the wei-exact boundary: one wei more than
				// the sender holds, same sender, same call site.
				{
					label: 'funded sender, value == balance + 1',
					from: account.address,
					value: fundedBalance + 1n,
					ok: false,
				},
			];
		/** One `eth_call` at this step's call site, classified (./affordability.ts). */
		const readWith = (p: Record<string, unknown>) =>
			classifyValueRead(() =>
				node4.request({method: 'eth_call', params: [p, 'latest']}),
			);
		for (const c of cases) {
			const outcome = await readWith({
				...(c.from ? {from: c.from} : {}),
				to: VALUE_SINK_ADDR,
				value: '0x' + c.value.toString(16),
			});
			cmp(m, `eth_call: ${c.label}`, outcome, c.ok ? OK : REJECTED);
		}
		// ---- NEGATIVE CONTROLS: the step must be able to go RED ----
		// Two REAL failures at the SAME call site, neither of them a refused
		// transfer. Under the bare `catch` this step used to have, both classified
		// as "failed" and would have satisfied any negative case above. Each must
		// now classify as ITSELF — neither `ok` nor a rejection — or this step is
		// back to proving only that something threw.
		await node4.request({
			method: 'evm_setCode',
			params: [REVERT_WITH_REASON_ADDR, REVERT_WITH_REASON_CODE],
		});
		const controls: {label: string; params: Record<string, unknown>}[] = [
			{
				// A malformed sender: the node refuses to parse it, long before any
				// engine sees a transfer.
				label: 'malformed sender address',
				params: {from: '0xnotanaddress', to: VALUE_SINK_ADDR, value: '0x1'},
			},
			{
				// A callee that REVERTS WITH A REASON, from a sender who can afford
				// the value: an engine failure (code 3) like the real rejection, told
				// apart by the return data a refused transfer never produces.
				label: 'callee reverts with return data',
				params: {
					from: account.address,
					to: REVERT_WITH_REASON_ADDR,
					value: '0x1',
				},
			},
		];
		for (const control of controls) {
			const outcome = await readWith(control.params);
			if (outcome === OK || outcome === REJECTED)
				m.push(
					`negative control '${control.label}' classified as '${outcome}', so an unrelated failure would pass this step`,
				);
		}
		steps.push({label: 'value-bearing read affordability', mismatches: m});
		await node4.dispose();
	}

	// 15) THE BLOCK GAS LIMIT IS ENFORCED, AND `blockGasLimit` IS WHAT LIFTS IT.
	//
	//     WHY THIS STEP EXISTS. The node used to hand `@ethereumjs/vm`'s `runTx` a
	//     `skipBlockGasLimitValidation`, so a transaction whose gas limit exceeded
	//     the block's was MINED on the default engine, while revm, which expresses
	//     that relaxation as a simulation switch and refuses to combine any
	//     simulation switch with committing, REJECTED the very same transaction
	//     (`CallerGasLimitMoreThanBlock`). Same node, same transaction, two answers
	//     depending on which engine was installed: the two-EVMs-disagreeing failure
	//     the engine seam exists to remove.
	//
	//     THE ORACLE IS ABSOLUTE, NOT THE REFERENCE EVM, and here that is not a
	//     preference but a requirement: this battery's reference `runTx` passes
	//     `skipBlockGasLimitValidation` itself (see {@link Reference.mineBlock}), so
	//     a diff of node-against-reference is structurally blind to exactly this
	//     bug. What is asserted is the NODE's own answer (refused / mined) per
	//     engine, and because this battery runs on the default engine
	//     (conformance.spec.ts) AND on revm (revm-conformance.spec.ts), holding both
	//     to the same absolute statement is what makes it a cross-engine bar.
	//
	//     AND THE REFUSAL IS READ, NOT JUST COUNTED. "It threw" is not evidence: a
	//     malformed transaction, an unaffordable one or a construction error would
	//     all throw at the same call site. The refusal must NAME the transaction's
	//     gas limit, the block gas limit it exceeded, and `blockGasLimit` as the
	//     knob that raises it. The second node proves that naming is not a
	//     hardcoded 30000000, because the same words come back with the CONFIGURED
	//     limit in them.
	{
		const m: string[] = [];
		/** One submission, as either the mined receipt's status or the refusal text. */
		const sendTx = async (n: SlimNode, raw: string) => {
			try {
				const rcpt = (await n.request({
					method: 'eth_sendRawTransactionSync',
					params: [raw],
				})) as any;
				return {outcome: `mined ${String(rcpt?.status)}`, message: ''};
			} catch (e) {
				const message = String((e as Error)?.message ?? e);
				return {outcome: 'refused', message};
			}
		};
		const blockNumberOf = async (n: SlimNode) =>
			BigInt(
				(await n.request({method: 'eth_blockNumber', params: []})) as string,
			);
		const nonceOf = async (n: SlimNode) =>
			BigInt(
				(await n.request({
					method: 'eth_getTransactionCount',
					params: [account.address, 'latest'],
				})) as string,
			);

		// ---- a node at the DEFAULT block gas limit refuses the over-limit tx ----
		const nodeDefault = await createNode({
			chainId: CHAIN_ID,
			stateMode,
			miningConfig: {type: 'auto'},
			initialBalances: {[account.address]: GENESIS_BALANCE},
			engine: await makeEngine?.(),
		});
		// The default is READ back off the node's own block rather than assumed, so
		// the numbers the refusal is checked for are the node's and not this file's.
		const genesisGasLimit = BigInt(
			(
				(await nodeDefault.request({
					method: 'eth_getBlockByNumber',
					params: ['latest', false],
				})) as any
			).gasLimit,
		);
		cmp(m, 'default blockGasLimit', genesisGasLimit, DEFAULT_BLOCK_GAS_LIMIT);
		const overLimitRaw = await sign1559({
			nonce: 0,
			to: VALUE_SINK_ADDR,
			value: 1n,
			gas: OVER_DEFAULT_TX_GAS,
		});
		const refused = await sendTx(nodeDefault, overLimitRaw);
		cmp(m, 'over-limit tx at the default limit', refused.outcome, 'refused');
		/**
		 * A word the refusal must contain, reported AS THE REFUSAL when it does not:
		 * `false` says nothing about which engine's error text came back instead,
		 * which is the one thing a reader of this mismatch needs.
		 */
		const names = (text: string, word: string) =>
			text.includes(word) ? 'named' : `NOT named, refusal was: ${text}`;
		cmp(
			m,
			"refusal names the tx's gas limit",
			names(refused.message, String(OVER_DEFAULT_TX_GAS)),
			'named',
		);
		cmp(
			m,
			'refusal names the block gas limit exceeded',
			names(refused.message, String(DEFAULT_BLOCK_GAS_LIMIT)),
			'named',
		);
		cmp(
			m,
			'refusal names `blockGasLimit` as the knob',
			names(refused.message, 'blockGasLimit'),
			'named',
		);
		// A REFUSED TRANSACTION IS NOT A HALF-MINED ONE: no block, no nonce advance.
		cmp(
			m,
			'no block was mined for the refused tx',
			await blockNumberOf(nodeDefault),
			0n,
		);
		cmp(m, 'sender nonce after the refusal', await nonceOf(nodeDefault), 0n);
		// ...and the node is still perfectly able to mine a transaction that FITS, so
		// the refusal above is about this transaction's gas limit and not about the
		// node having broken.
		const withinRaw = await sign1559({
			nonce: 0,
			to: VALUE_SINK_ADDR,
			value: 1n,
			gas: 21_000n,
		});
		cmp(
			m,
			'within-limit tx at the default limit',
			(await sendTx(nodeDefault, withinRaw)).outcome,
			'mined 0x1',
		);
		await nodeDefault.dispose();

		// ---- ...and a node CONFIGURED for it mines the very same transaction ----
		const nodeRaised = await createNode({
			chainId: CHAIN_ID,
			stateMode,
			miningConfig: {type: 'auto'},
			blockGasLimit: RAISED_BLOCK_GAS_LIMIT,
			initialBalances: {[account.address]: GENESIS_BALANCE},
			engine: await makeEngine?.(),
		});
		cmp(
			m,
			'over-limit tx on a node configured for it',
			(await sendTx(nodeRaised, overLimitRaw)).outcome,
			'mined 0x1',
		);
		// THE BLOCK REALLY IS THAT BIG: the permissiveness is a property of the
		// block, not a per-transaction exemption. Read twice: off the RPC block, and
		// (the only reading a contract can act on) through `GASLIMIT` inside the EVM.
		const raisedHead = (await nodeRaised.request({
			method: 'eth_getBlockByNumber',
			params: ['latest', false],
		})) as any;
		cmp(
			m,
			'RPC block gasLimit',
			BigInt(raisedHead.gasLimit),
			RAISED_BLOCK_GAS_LIMIT,
		);
		await nodeRaised.request({
			method: 'evm_setCode',
			params: [BLOCK_ENV_PROBE_ADDR, blockEnvProbeRuntimeBytecode],
		});
		const raisedEnv = decodeFunctionResult({
			abi: blockEnvProbeAbi,
			functionName: 'env',
			data: (await nodeRaised.request({
				method: 'eth_call',
				params: [
					{
						to: BLOCK_ENV_PROBE_ADDR,
						data: encodeFunctionData({
							abi: blockEnvProbeAbi,
							functionName: 'env',
						}),
					},
					'latest',
				],
			})) as `0x${string}`,
		});
		cmp(m, 'GASLIMIT through a contract', raisedEnv[5], RAISED_BLOCK_GAS_LIMIT);
		// ...and the refusal moved WITH the configuration rather than staying at a
		// hardcoded 30000000: ONE GAS above the configured limit is refused, naming
		// THAT limit.
		const wayOverRaw = await sign1559({
			nonce: 1,
			to: VALUE_SINK_ADDR,
			value: 1n,
			gas: OVER_RAISED_TX_GAS,
		});
		const refusedRaised = await sendTx(nodeRaised, wayOverRaw);
		cmp(m, 'tx above the RAISED limit', refusedRaised.outcome, 'refused');
		cmp(
			m,
			'refusal names the CONFIGURED block gas limit',
			names(refusedRaised.message, String(RAISED_BLOCK_GAS_LIMIT)),
			'named',
		);
		await nodeRaised.dispose();
		steps.push({
			label: 'block gas limit refuses an over-limit tx; blockGasLimit lifts it',
			mismatches: m,
		});
	}

	const engineId = node.engine.id;
	await node.dispose();

	const totalMismatches = steps.reduce((n, s) => n + s.mismatches.length, 0);
	return {stateMode, engineId, steps, totalMismatches};
}

export async function runConformance(): Promise<{
	none: BatteryReport;
	trie: BatteryReport;
}> {
	// Cover BOTH the default fast path ('none') and the trie path ('trie').
	const none = await runBattery('none');
	const trie = await runBattery('trie');
	return {none, trie};
}

export interface EngineConformanceReport {
	/** The battery, run in the one mode this engine serves. */
	served: BatteryReport;
	/**
	 * The modes this engine REFUSES, with the error it refused with. Recorded
	 * rather than assumed: it is the refusal that decides which mode keeps its
	 * default-engine coverage, so a mode that silently stopped being refused
	 * (and therefore silently stopped being covered by anyone) is visible here.
	 */
	refusals: {stateMode: StateMode; error: string}[];
	totalMismatches: number;
}

/**
 * Run the SAME battery with an injected engine, in the one state mode that engine
 * serves, and record its refusal of the others.
 *
 * Deliberately NOT "run every mode on every engine": an engine that cannot serve
 * a mode must say so at construction, and covering it anyway would mean either
 * relaxing an assertion or running the mode on the default engine while claiming
 * the engine was under test. The unparameterised {@link runConformance} keeps
 * covering every mode on the default engine, so no mode loses coverage.
 */
export async function runConformanceOnEngine(opts: {
	makeEngine: EngineFactory;
	/** The one mode this engine serves — the battery runs here. */
	serves: StateMode;
	/** Modes this engine must refuse AT CONSTRUCTION, naming the reason. */
	refuses: StateMode[];
}): Promise<EngineConformanceReport> {
	const refusals: {stateMode: StateMode; error: string}[] = [];
	for (const stateMode of opts.refuses) {
		try {
			const n = await createNode({
				chainId: CHAIN_ID,
				stateMode,
				engine: await opts.makeEngine(),
			});
			refusals.push({stateMode, error: 'DID_NOT_THROW'});
			await n.dispose();
		} catch (e) {
			refusals.push({stateMode, error: String((e as Error)?.message ?? e)});
		}
	}
	const served = await runBattery(opts.serves, opts.makeEngine);
	return {served, refusals, totalMismatches: served.totalMismatches};
}
