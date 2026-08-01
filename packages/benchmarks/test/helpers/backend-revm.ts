/**
 * backend-revm.ts — revm (Rust) compiled to WebAssembly, driving EVERYTHING.
 *
 * No @ethereumjs/* anywhere in this backend: revm executes the deployment, the
 * state-changing transactions and the reads, and owns the state via its own
 * commit path. That makes every row comparable, and puts the WRITE path under the
 * cross-backend gas gate rather than only the read path.
 *
 * HOW THE THREE PATHS DIFFER — one entry point each:
 *   deploy      `create()`     `to` ignored, `data` is init code, commits
 *   sendCall    `transact()`   state written back through the store
 *   staticCall  `call()`       read-only; structurally cannot commit
 *
 * `call()` never commits whatever the options say, which is the property worth
 * having: `eth_call` is incapable of writing.
 *
 * THE WASM IS AN ORDINARY DEPENDENCY. It comes from `revm-wasm` on npm (MIT, zero
 * runtime dependencies, prebuilt `.wasm` in the tarball), so this row runs on a
 * fresh clone and in CI with no build step. The package also owns the outcome
 * decoding, the account packing and the pointer-level host, none of which are
 * this repo's business.
 *
 * READING THE WRITE ROWS FAIRLY. revm's `transact()` takes `from` DIRECTLY: it
 * never recovers a sender, because in revm that is the caller's job. So `deploy`
 * and `callAvg` here involve NO secp256k1 at all, and the honest comparison for
 * them is the `embedded-eth-node-fabricated` row (which also skips both signing
 * and recovery), NOT the default `embedded-eth-node` row, which pays ~1.3ms to
 * sign plus ~2ms to recover. Comparing against the default row would credit revm
 * with a saving that is really just the absence of signature work.
 *
 * (Sender recovery is still available: `Revm.recoverSigner()` runs the same k256
 * code the `0x01` precompile does, measured at ~4.3x `@noble/curves`. It is
 * simply not part of `transact()`.)
 *
 * STATE LIVES IN JS, in the package's `MemoryStore` — plain `Map`s, like the ones
 * embedded-eth-node uses. The wasm reads and writes through synchronous host
 * functions taking integer pointers into linear memory, so nothing is serialised
 * per access.
 *
 * WHY THE GAS GATE IS THE POINT. Two EVMs that agree on every return value can
 * still disagree on gas, and then they disagree about where execution runs OUT of
 * gas — a state fork for anyone replaying the chain. `evm.spec.ts` asserts
 * execution gas is IDENTICAL across every backend, so this file is subject to
 * that check on both the read and the write path.
 */
import {
	createRevm,
	KECCAK_EMPTY,
	MemoryStore,
	Spec,
	type Outcome,
	type Revm,
} from 'revm-wasm';
import type {EvmBackend} from './scenario.js';
import {intrinsicGasForCall, DEPLOYER} from './scenario.js';
import {compiledRevmModule} from './revm-wasm-module.js';

const CHAIN_ID = 1n;

const BLOCK = {
	number: 12345n,
	timestamp: 1_700_000_000n,
	gasLimit: 30_000_000n,
	coinbase: hexToBytes('0x00000000000000000000000000000000c0173a5e'),
};
const GAS_LIMIT = 25_000_000n;
/** The deployer is the only pre-funded account, as in every other backend. */
const DEPLOYER_BALANCE = 10n ** 24n;

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

const DEPLOYER_ADDR = hexToBytes(DEPLOYER);

export function makeRevmBackend(): EvmBackend {
	let evm: Revm | undefined;
	let store: MemoryStore | undefined;

	/**
	 * The sender's on-chain nonce, read from the state the commits update.
	 *
	 * `transact()` and `create()` check the nonce by default, which is the right
	 * default (a transaction executed without the check is silently replayable) and
	 * means the write paths have to carry a real one. Reads do not: `call()` leaves
	 * the check off, which is `eth_call` semantics.
	 */
	const senderNonce = (): bigint =>
		store!.getAccount(DEPLOYER_ADDR)?.nonce ?? 0n;

	function checked(out: Outcome, label: string): Outcome {
		if (!out.success)
			throw new Error(`revm ${out.status} on ${label}: ${out.error ?? ''}`);
		return out;
	}

	/**
	 * One read. Kept on the default (full-state) path rather than
	 * `returnState: false`: the lighter path skips building the state map and is
	 * worth roughly 0.9 microseconds per call, which would make these rows
	 * incomparable to every number measured before this backend moved to the
	 * published package. It is an `eth_call` optimisation, not a benchmark one.
	 */
	function read(
		to: `0x${string}`,
		data: `0x${string}`,
		label: string,
	): Outcome {
		return checked(
			evm!.call({
				from: DEPLOYER_ADDR,
				to: hexToBytes(to),
				data: hexToBytes(data),
				gasLimit: GAS_LIMIT,
			}),
			label,
		);
	}

	return {
		name: 'revm-wasm (full: CREATE + committing txs + eth_call)',

		async setup() {
			// Fresh state per run; the deployer is the only pre-funded account.
			store = new MemoryStore();
			store.setAccount(DEPLOYER_ADDR, {
				balance: DEPLOYER_BALANCE,
				nonce: 0n,
				codeHash: KECCAK_EMPTY,
			});
			evm = await createRevm({
				// Compiled ONCE per page and shared with the node's revm-engine row;
				// see ./revm-wasm-module.ts. Each run still gets its own instance.
				wasm: await compiledRevmModule(),
				state: store,
				spec: Spec.CANCUN,
				chainId: CHAIN_ID,
				block: BLOCK,
			});
		},

		async deploy(bytecode) {
			// `create()`: `to` is ignored, `data` is the init code, and it commits, so
			// the deployed account, its code and its storage land in the store.
			//
			// Fees are deliberately left at zero. The gate compares EXECUTION gas,
			// which is fee-independent, and charging a fee would make this backend's
			// balances diverge from the other backends' for no measurement benefit.
			const out = checked(
				evm!.create({
					from: DEPLOYER_ADDR,
					data: hexToBytes(bytecode),
					gasLimit: GAS_LIMIT,
					nonce: senderNonce(),
				}),
				'deploy',
			);
			const created = out.stateChanges?.find((c) => c.created);
			if (!created) throw new Error('revm deploy reported no created account');
			return bytesToHex(created.address) as `0x${string}`;
		},

		async sendCall(to, data) {
			checked(
				evm!.transact({
					from: DEPLOYER_ADDR,
					to: hexToBytes(to),
					data: hexToBytes(data),
					gasLimit: GAS_LIMIT,
					nonce: senderNonce(),
				}),
				`sendCall ${data.slice(0, 10)}`,
			);
		},

		async staticCall(to, data) {
			return bytesToHex(
				read(to, data, `staticCall ${data.slice(0, 10)}`).returnData,
			) as `0x${string}`;
		},

		// revm charges intrinsic gas exactly as the node-driven backends'
		// `eth_estimateGas` does, so the same subtraction yields the EXECUTION gas
		// the raw-EVM backends report. This is what the equality gate compares.
		async staticCallGas(to, data) {
			const out = read(to, data, `staticCallGas ${data.slice(0, 10)}`);
			return out.gasUsed - intrinsicGasForCall(data);
		},
	};
}
