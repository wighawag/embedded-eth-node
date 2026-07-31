/**
 * backend-revm.ts — revm (Rust) compiled to WebAssembly, driving EVERYTHING.
 *
 * No @ethereumjs/* anywhere in this backend: revm executes the deployment, the
 * state-changing transactions and the reads, and owns the state via its own
 * commit path. That makes every row comparable, and puts the WRITE path under the
 * cross-backend gas gate rather than only the read path.
 *
 * (It was a read-only hybrid until the spike gained logs, code bytes for created
 * accounts, and an explicit commit path. Those were exactly the three things
 * missing for transaction execution.)
 *
 * HOW THE THREE PATHS DIFFER — only by a flag word:
 *   deploy      CREATE | COMMIT   `to` ignored, `data` is init code
 *   sendCall    COMMIT            state written back to the host maps
 *   staticCall  0                 read-only; cannot mutate anything
 *
 * Commit is never implicit. `eth_call` passes 0 and is structurally incapable of
 * writing, which is the property worth having.
 *
 * READING THE WRITE ROWS FAIRLY. revm's `transact()` takes `caller` DIRECTLY: it
 * never recovers a sender, because in revm that is the caller's job. So `deploy`
 * and `callAvg` here involve NO secp256k1 at all, and the honest comparison for
 * them is the `embedded-eth-node-fabricated` row (which also skips both signing
 * and recovery), NOT the default `embedded-eth-node` row, which pays ~1.3ms to
 * sign plus ~2ms to recover. Comparing against the default row would credit revm
 * with a saving that is really just the absence of signature work.
 *
 * (Sender recovery is still available from this module: the spike exports
 * `ecrecover` directly, measured at ~4.3x `@noble/curves`. It is simply not part
 * of `transact()`.)
 *
 * STATE LIVES IN JS, in the same plain `Map`s embedded-eth-node uses. The wasm
 * reads through five synchronous imported functions and writes back through five
 * more, all taking integer pointers into linear memory, so nothing is serialised
 * per access. Growing state is the host's problem, not the module's.
 *
 * WHY THE GAS GATE IS THE POINT. Two EVMs that agree on every return value can
 * still disagree on gas, and then they disagree about where execution runs OUT of
 * gas — a state fork for anyone replaying the chain. `evm.spec.ts` asserts
 * execution gas is IDENTICAL across every backend, so this file is subject to
 * that check on both the read and the write path.
 *
 * Artifacts are vendored by `scripts/vendor-revm.mjs` (gitignored). When absent
 * the imports resolve to a stub and the spec skips this backend.
 */
// @ts-ignore - generated wasm-bindgen glue, no types
import initRevm, {call_persistent} from '../../vendor/revm/evm.js';
// @ts-ignore - hand-written synchronous host, no types
import {setMemory, setHost, makeState} from '../../vendor/revm/eeth_host.js';
import {keccak_256} from '@noble/hashes/sha3.js';
import type {EvmBackend} from './scenario.js';
import {intrinsicGasForCall, DEPLOYER} from './scenario.js';

const CHAIN_ID = 1;
const SPEC_CANCUN = 11; // revm SpecId::CANCUN (FRONTIER = 0)

// Outcome flag word, mirroring the spike's `flags` module.
const COMMIT = 1;
const CREATE = 2;
// CHECK_NONCE is OFF by default in the spike, because parts 1-2 ran everything
// with nonce checking disabled. That default is an `eth_call` semantic: without
// it a replayed transaction succeeds. A transaction path must set it, so the two
// write paths here do, and `deploy`/`sendCall` therefore have to carry a real
// nonce (tracked below, incremented by the commit).
const CHECK_NONCE = 8;

// Per-account flag bits in the outcome blob.
const F_CREATED = 4;
const F_CODE_CHANGED = 8;

const BLOCK = {
	number: 12345n,
	timestamp: 1_700_000_000n,
	gasLimit: 30_000_000n,
	coinbase: '0x00000000000000000000000000000000c0173a5e',
};
const GAS_LIMIT = 25_000_000n;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function hexToBytes(hex: string): Uint8Array {
	const h = hex.replace(/^0x/, '');
	const out = new Uint8Array(h.length >> 1);
	for (let i = 0; i < out.length; i++)
		out[i] = parseInt(h.substr(i * 2, 2), 16);
	return out;
}
function bytesToHex(b: Uint8Array): string {
	let s = '0x';
	for (const x of b) s += x.toString(16).padStart(2, '0');
	return s;
}
function padLeft(b: Uint8Array, n: number): Uint8Array {
	if (b.length >= n) return b.slice(b.length - n);
	const out = new Uint8Array(n);
	out.set(b, n - b.length);
	return out;
}
/** lowercase hex without 0x — the key format `eeth_host.js` builds from memory. */
const key = (hex: string) => hex.replace(/^0x/, '').toLowerCase();

interface Outcome {
	success: boolean;
	status: string;
	gasUsed: bigint;
	returnData: Uint8Array;
	created: string | null;
}

/**
 * Decode the outcome blob, format v3.
 *
 * The head (status | gasUsed | totalGasSpent | refunded | returnData) has sat at
 * the same offsets since v1, which is why this decoder survived two format
 * changes while only reading gas. Everything after it has moved twice:
 *
 *   v2 inserted the LOG LIST before the accounts
 *   v3 inserts a 256-byte LOGS BLOOM after the logs, but ONLY when the log count
 *      is non-zero, and appends a 16-byte effective gas price after the accounts
 *
 * The conditional bloom is the sharp edge: a call that emits no logs has no
 * bloom, so a decoder that always skips 256 bytes works on exactly the calls
 * that are easiest to test with. We only need the created address, but the log
 * list and bloom still have to be walked to find where the accounts start.
 */
function decodeOutcome(buf: Uint8Array): Outcome {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let o = 0;
	const status = buf[o];
	o += 1;
	const gasUsed = dv.getBigUint64(o, true);
	o += 8 + 8 + 8; // gasUsed | totalGasSpent | refunded
	const retLen = dv.getUint32(o, true);
	o += 4;
	const returnData = buf.slice(o, o + retLen);
	o += retLen;

	// logs: [20] address, u8 topicCount, [32]*n topics, u32 dataLen + bytes
	const nLogs = dv.getUint32(o, true);
	o += 4;
	for (let i = 0; i < nLogs; i++) {
		o += 20;
		const nTopics = buf[o];
		o += 1 + nTopics * 32;
		const dataLen = dv.getUint32(o, true);
		o += 4 + dataLen;
	}
	// v3: the 256-byte receipts bloom follows the logs, but only if there were any.
	if (nLogs > 0) o += 256;

	// accounts: [20] address, u8 flags, [32] balance, u64 nonce, [32] codeHash,
	//           if flags&8: u32 codeLen + bytes; then u32 slotCount + slots
	const nAcc = dv.getUint32(o, true);
	o += 4;
	let created: string | null = null;
	for (let i = 0; i < nAcc; i++) {
		const address = bytesToHex(buf.slice(o, o + 20));
		o += 20;
		const flags = buf[o];
		o += 1 + 32 + 8 + 32; // flags | balance | nonce | codeHash
		if (flags & F_CODE_CHANGED) {
			const codeLen = dv.getUint32(o, true);
			o += 4 + codeLen;
		}
		const nSlots = dv.getUint32(o, true);
		o += 4 + nSlots * 64;
		if (flags & F_CREATED) created = address;
	}

	return {
		success: status === 0,
		status: ['success', 'revert', 'halt', 'validation-error'][status],
		gasUsed,
		returnData,
		created,
	};
}

/** keccak256("") — the code hash of any account with no code. */
const KECCAK_EMPTY = keccak_256(new Uint8Array(0));

/** Pack into the 72-byte layout the wasm reads directly. */
function packAccount(balance: bigint, nonce: bigint, codeHash: Uint8Array) {
	const packed = new Uint8Array(72);
	let h = balance.toString(16);
	if (h.length % 2) h = '0' + h;
	packed.set(padLeft(hexToBytes(h), 32), 0);
	let n = nonce;
	for (let i = 0; i < 8; i++) {
		packed[32 + i] = Number(n & 0xffn);
		n >>= 8n;
	}
	packed.set(codeHash, 40);
	return packed;
}

/**
 * The optional trailing `extra` blob (format v3), carrying the transaction-level
 * fields that do not fit in the positional arguments.
 *
 * We only need the NONCE here. Fees are deliberately left at zero: the gate
 * compares EXECUTION gas, which is fee-independent, and charging a fee would make
 * this backend's balances diverge from the other backends' for no measurement
 * benefit. (The fee path itself is proven in the spike: a value transfer charges
 * value + gasUsed * effectiveGasPrice and credits the coinbase the tip.)
 *
 * Layout: u8 version | u8 present | u8 txType | u8 reserved | [16] gasPrice |
 *         [16] maxPriorityFee | [16] maxFeePerBlobGas | u64 basefee |
 *         u64 nonce | u64 excessBlobGas | u32 accessList | u32 blobs | u32 auths
 */
function encodeExtra(nonce: bigint): Uint8Array {
	const buf = new Uint8Array(88);
	const dv = new DataView(buf.buffer);
	buf[0] = 1; // version
	// present = 0: no priority fee, no explicit tx type, no excess blob gas.
	// gasPrice / maxPriorityFee / maxFeePerBlobGas / basefee all stay zero.
	dv.setBigUint64(60, nonce, true); // after 4 + 48 bytes, past basefee
	// trailing u32 counts (access list, blob hashes, authorizations) stay zero
	return buf;
}

let initialised = false;

export function makeRevmBackend(): EvmBackend {
	// Mirrors the sender's on-chain nonce. Only advanced by committing calls,
	// because only those increment it in host state.
	let nonce = 0n;

	function run(
		to: string,
		data: `0x${string}`,
		flags: number,
		label: string,
	): Outcome {
		const committing = (flags & COMMIT) !== 0;
		const out = call_persistent(
			padLeft(hexToBytes(DEPLOYER), 20),
			padLeft(hexToBytes(to), 20),
			hexToBytes(data),
			GAS_LIMIT,
			new Uint8Array(32),
			SPEC_CANCUN,
			BigInt(CHAIN_ID),
			BLOCK.number,
			BLOCK.timestamp,
			BLOCK.gasLimit,
			padLeft(hexToBytes(BLOCK.coinbase), 20),
			committing ? flags | CHECK_NONCE : flags,
			committing ? encodeExtra(nonce) : undefined,
		) as Uint8Array;
		const r = decodeOutcome(out);
		if (!r.success) throw new Error(`revm ${r.status} on ${label}`);
		if (committing) nonce += 1n;
		return r;
	}

	return {
		name: 'revm-wasm (full: CREATE + committing txs + eth_call)',

		async setup() {
			if (!initialised) {
				// `--target web` glue: fetch + instantiate, then hand the host the
				// module's linear memory so state reads are answered in place.
				const exports = await initRevm({
					module_or_path: new URL('evm_bg.wasm', location.href),
				});
				setMemory(exports.memory);
				initialised = true;
			}
			// Fresh state per run; the deployer is the only pre-funded account.
			nonce = 0n;
			const state = makeState();
			state.accounts.set(
				key(DEPLOYER),
				packAccount(10n ** 24n, 0n, KECCAK_EMPTY),
			);
			setHost(state);
		},

		async deploy(bytecode) {
			// CREATE: `to` is ignored and `data` is the init code. COMMIT so the
			// deployed account, its code and its storage land in host state.
			const r = run(ZERO_ADDR, bytecode, CREATE | COMMIT, 'deploy');
			if (!r.created)
				throw new Error('revm deploy reported no created account');
			return r.created as `0x${string}`;
		},

		async sendCall(to, data) {
			run(to, data, COMMIT, `sendCall ${data.slice(0, 10)}`);
		},

		async staticCall(to, data) {
			// flags = 0: structurally incapable of mutating state.
			return bytesToHex(
				run(to, data, 0, `staticCall ${data.slice(0, 10)}`).returnData,
			) as `0x${string}`;
		},

		// revm charges intrinsic gas exactly as the node-driven backends'
		// `eth_estimateGas` does, so the same subtraction yields the EXECUTION gas
		// the raw-EVM backends report. This is what the equality gate compares.
		async staticCallGas(to, data) {
			const r = run(to, data, 0, `staticCallGas ${data.slice(0, 10)}`);
			return r.gasUsed - intrinsicGasForCall(data);
		},
	};
}
