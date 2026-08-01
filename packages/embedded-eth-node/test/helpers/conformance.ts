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
 * same steps run with an injected read engine, so `embedded-eth-node/revm` faces
 * this bar rather than a softer one of its own. Only the READ path changes with
 * the engine — `eth_call` return data and `eth_estimateGas` — because
 * transactions run on `@ethereumjs/vm` whatever engine is installed. The engine
 * is built PER NODE by a factory, not shared: an engine instance serves exactly
 * one node (the revm engine refuses a second `createNode()` outright), and the
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
import {encodeFunctionData, encodeDeployData} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {
	createNode,
	type ReadEngine,
	type SlimNode,
	type StateMode,
} from '../../src/index.js';
import {counterAbi, counterBytecode} from './counter.js';
import {probeAbi, probeBytecode} from './probe.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const BASE_FEE = 1_000_000_000n;
const GENESIS_BALANCE = 10n ** 24n;
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
export type EngineFactory = () => Promise<ReadEngine>;

export interface BatteryReport {
	stateMode: StateMode;
	/** Which EVM answered the READ path, as the node itself reports it. */
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

	const engineId = node.readEngine.id;
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
 * Run the SAME battery with an injected read engine, in the one state mode that
 * engine serves, and record its refusal of the others.
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
