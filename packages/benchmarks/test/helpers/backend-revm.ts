/**
 * backend-revm.ts — revm (Rust) compiled to WebAssembly, driving the READ path.
 *
 * WHAT THIS IS, PRECISELY. It is a HYBRID, and deliberately so:
 *
 *   writes (deploy, sendCall)  -> embedded-eth-node / @ethereumjs/vm, as usual
 *   reads  (staticCall, gas)   -> revm-wasm
 *
 * That is not a shortcut, it is the integration actually being evaluated. The
 * revm spike is READ-ONLY: `call_persistent` returns state changes but never
 * commits them to the host, and the outcome blob carries a code HASH rather than
 * code, so a deployment cannot be reconstructed from it. The proposed use is
 * exactly this shape anyway — keep @ethereumjs/vm's `runTx` for transactions
 * (where ecrecover dominates and the interpreter is ~6% of the time) and put revm
 * behind `eth_call`, where the interpreter is ~100% of the time and where an
 * on-chain game's frame budget is actually spent.
 *
 * READ THE ROWS ACCORDINGLY:
 *   MEANINGFUL for revm : read, compute, keccak, frame, floor, and the gas gate
 *   NOT meaningful      : coldStart, deploy, callAvg
 * The write rows run on @ethereumjs/vm PLUS a full host-state resync after every
 * write, so they are strictly slower than the plain `embedded-eth-node` row and
 * say nothing about revm. Compare only the read rows.
 *
 * WHY THE GAS GATE IS THE POINT. The spike measured that dropping precompiles
 * from the wasm build CHANGES GAS (an omitted precompile address stops being
 * pre-warmed, so touching it costs +2500 for a cold access). Two EVMs that agree
 * on every return value can still disagree on gas, and a client replaying the
 * chain would then fork. `evm.spec.ts` asserts execution gas is IDENTICAL across
 * every backend, so wiring revm in here subjects it to exactly that check.
 *
 * Artifacts are vendored by `scripts/vendor-revm.mjs` (gitignored). When they are
 * absent the imports resolve to a stub and this backend is skipped by the spec.
 */
// @ts-ignore - generated wasm-bindgen glue, no types
import initRevm, {call_persistent} from '../../vendor/revm/evm.js';
// @ts-ignore - hand-written synchronous host, no types
import {setMemory, setHost} from '../../vendor/revm/eeth_host.js';
import {createNode, type SlimNode} from 'embedded-eth-node';
import {
	createWalletClient,
	createPublicClient,
	custom,
	type WalletClient,
	type PublicClient,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {
	createAccountFromRLP,
	hexToBytes,
	setLengthLeft,
} from '@ethereumjs/util';
import type {EvmBackend} from './scenario.js';
import {intrinsicGasForCall} from './scenario.js';
import {counterAbi} from './counter.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 1; // revm chain id used by the spike fixtures
const SPEC_CANCUN = 11; // revm SpecId::CANCUN (FRONTIER = 0)

const account = privateKeyToAccount(PK);
const chain = {
	id: CHAIN_ID,
	name: 'revm-hybrid',
	nativeCurrency: {name: 'E', symbol: 'E', decimals: 18},
	rpcUrls: {default: {http: []}},
} as const;

const BLOCK = {
	number: 12345n,
	timestamp: 1_700_000_000n,
	gasLimit: 30_000_000n,
	coinbase: '0x00000000000000000000000000000000c0173a5e',
};

function bytes20(hex: string): Uint8Array {
	return setLengthLeft(hexToBytes(hex as `0x${string}`), 20);
}
function bytes32(hex: string): Uint8Array {
	return setLengthLeft(hexToBytes(hex as `0x${string}`), 32);
}
/** lowercase hex, no 0x — the key format `eeth_host.js` builds from memory. */
function key(hex: string): string {
	return hex.replace(/^0x/, '').toLowerCase();
}

/** Decode the compact outcome blob (see the spike's `encode_outcome`). */
function decodeOutcome(buf: Uint8Array): {
	success: boolean;
	status: string;
	gasUsed: bigint;
	returnData: Uint8Array;
} {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let o = 0;
	const status = buf[o];
	o += 1;
	const gasUsed = dv.getBigUint64(o, true);
	o += 8 + 8 + 8; // gasUsed | totalGasSpent | refunded
	const retLen = dv.getUint32(o, true);
	o += 4;
	const returnData = buf.slice(o, o + retLen);
	return {
		success: status === 0,
		status: ['success', 'revert', 'halt', 'validation-error'][status],
		gasUsed,
		returnData,
	};
}

export function makeRevmBackend(): EvmBackend {
	let node: SlimNode;
	let wallet: WalletClient;
	let pub: PublicClient;
	let ready = false;

	/**
	 * Mirror the node's state into revm's host maps.
	 *
	 * `dumpState()` is the node's own serialisation, so this stays on the public
	 * surface rather than reaching into the state manager. Accounts arrive as RLP
	 * and are repacked into the 72-byte layout the wasm reads directly
	 * (balance BE 32 | nonce LE 8 | codeHash 32).
	 *
	 * Called after every write, which is why the write rows are not comparable.
	 */
	async function syncHostState() {
		const dump = await node.dumpState();
		const state = {
			accounts: new Map<string, Uint8Array>(),
			code: new Map<string, Uint8Array>(),
			storage: new Map<string, Uint8Array>(),
		};
		for (const [addr, accHex] of Object.entries(dump.accounts)) {
			const acc = createAccountFromRLP(hexToBytes(accHex as `0x${string}`));
			const packed = new Uint8Array(72);
			packed.set(setLengthLeft(bigintToBytes(acc.balance), 32), 0);
			let n = acc.nonce;
			for (let i = 0; i < 8; i++) {
				packed[32 + i] = Number(n & 0xffn);
				n >>= 8n;
			}
			packed.set(acc.codeHash, 40);
			state.accounts.set(key(addr), packed);
		}
		for (const [addr, codeHex] of Object.entries(dump.code)) {
			const code = hexToBytes(codeHex as `0x${string}`);
			const acc = dump.accounts[addr];
			if (!acc) continue;
			const codeHash = createAccountFromRLP(
				hexToBytes(acc as `0x${string}`),
			).codeHash;
			state.code.set(key(bytesToHexStr(codeHash)), code);
		}
		for (const [addr, slots] of Object.entries(dump.storage)) {
			for (const [slot, val] of Object.entries(slots)) {
				// ethereumjs stores storage values RLP-trimmed; revm wants 32 bytes.
				state.storage.set(
					key(addr) + key(bytesToHexStr(bytes32(slot))),
					bytes32(val),
				);
			}
		}
		setHost(state);
	}

	function revmCall(to: `0x${string}`, data: `0x${string}`) {
		const out = call_persistent(
			bytes20(account.address),
			bytes20(to),
			hexToBytes(data),
			25_000_000n,
			new Uint8Array(32),
			SPEC_CANCUN,
			BigInt(CHAIN_ID),
			BLOCK.number,
			BLOCK.timestamp,
			BLOCK.gasLimit,
			bytes20(BLOCK.coinbase),
		) as Uint8Array;
		return decodeOutcome(out);
	}

	return {
		name: 'revm-wasm reads (hybrid: @ethereumjs/vm writes, revm eth_call)',

		async setup() {
			node = await createNode({
				chainId: CHAIN_ID,
				miningConfig: {type: 'auto'},
				initialBalances: {[account.address]: 10n ** 24n},
			});
			const transport = custom(
				{request: ({method, params}) => node.request({method, params})},
				{retryCount: 0},
			);
			wallet = createWalletClient({account, chain, transport});
			pub = createPublicClient({chain, transport});

			if (!ready) {
				// `--target web` glue: fetch + instantiate, then hand the host the
				// module's linear memory so it can answer state reads in place.
				const exports = await initRevm({
					module_or_path: new URL('evm_bg.wasm', location.href),
				});
				setMemory(exports.memory);
				ready = true;
			}
			await syncHostState();
		},

		async deploy(bytecode) {
			const hash = await wallet.deployContract({
				account,
				chain,
				abi: counterAbi,
				bytecode,
			});
			const receipt = await pub.getTransactionReceipt({hash});
			await syncHostState();
			return receipt.contractAddress as `0x${string}`;
		},

		async sendCall(to, data) {
			const raw = await account.signTransaction({
				chainId: CHAIN_ID,
				nonce: await pub.getTransactionCount({address: account.address}),
				to,
				data,
				gas: 200_000n,
				maxFeePerGas: 2_000_000_000n,
				maxPriorityFeePerGas: 1_000_000_000n,
				type: 'eip1559',
			});
			await node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
			await syncHostState();
		},

		async staticCall(to, data) {
			const r = revmCall(to, data);
			if (!r.success) {
				throw new Error(`revm ${r.status} on ${to} ${data.slice(0, 10)}`);
			}
			return bytesToHexStr(r.returnData) as `0x${string}`;
		},

		// revm's `transact()` charges intrinsic gas, exactly as the node-driven
		// backends' `eth_estimateGas` does, so the same subtraction yields the
		// EXECUTION gas the raw-EVM backends report. This is the number the
		// cross-backend equality assertion compares.
		async staticCallGas(to, data) {
			const r = revmCall(to, data);
			if (!r.success) {
				throw new Error(`revm ${r.status} on ${to} ${data.slice(0, 10)}`);
			}
			return r.gasUsed - intrinsicGasForCall(data);
		},
	};
}

function bigintToBytes(v: bigint): Uint8Array {
	let h = v.toString(16);
	if (h.length % 2) h = '0' + h;
	return hexToBytes(('0x' + h) as `0x${string}`);
}

function bytesToHexStr(b: Uint8Array): string {
	let s = '0x';
	for (const x of b) s += x.toString(16).padStart(2, '0');
	return s;
}
