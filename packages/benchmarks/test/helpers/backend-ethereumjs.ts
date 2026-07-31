/**
 * backend-ethereumjs.ts — two raw `@ethereumjs/*` backends sharing one code path,
 * differing only in the knobs the ethereumjs team's own perf meta-issue (#3227)
 * and EthWorks profiling flag as the hotspots:
 *
 *   - DEFAULT ("the floor"): `MerkleStateManager` (trie-backed; every commit does
 *     RLP-encode + keccak + a state-root walk) and we call `getStateRoot()` after
 *     each state-changing call (simulating canonical-state bookkeeping a naive
 *     integration does). This is what you get if you wire ethereumjs up the
 *     obvious way.
 *   - TUNED ("be better at ethereumjs"): `SimpleStateManager` (plain Maps, NO trie,
 *     NO state root), no per-step hook, and keccak swapped to an explicit noble
 *     impl via `Common.customCrypto`. We never compute a state root.
 *
 * Both drive the EVM through `EVM.runCall` directly — the realistic low-level path
 * for a client-side game/simulation that doesn't need signed txs, nonces, or a
 * mempool. (Going through `runTx`/full blocks adds ecrecover + block plumbing,
 * which #3227 shows dominates real block time but is irrelevant to local sim.)
 */
import {createEVM, type EVM} from '@ethereumjs/evm';
import {SimpleStateManager, MerkleStateManager} from '@ethereumjs/statemanager';
import {Common, Mainnet, Hardfork} from '@ethereumjs/common';
import {
	createAddressFromString,
	Account,
	hexToBytes,
	bytesToHex,
	type Address,
} from '@ethereumjs/util';
import {keccak_256} from '@noble/hashes/sha3.js';
import {encodeDeployData} from 'viem';
import type {EvmBackend} from './scenario.js';
import {DEPLOYER} from './scenario.js';
import {counterAbi} from './counter.js';

type Mode = 'default' | 'tuned';

function makeBackend(mode: Mode): EvmBackend {
	let evm: EVM;
	let sm: SimpleStateManager | MerkleStateManager;
	let caller: Address;
	const trackStateRoot = mode === 'default';

	/**
	 * Reset the per-transaction EVM bookkeeping before an isolated read.
	 *
	 * `runCall` (unlike `runTx`) does NOT clear the journal's EIP-2929 warm/access
	 * set or the EIP-2200 original-storage cache between calls — only `runTx` calls
	 * `journal.cleanup()`. Without this reset, slot warmth LEAKS from one call into
	 * the next, so the 2nd+ `number()` read is charged a WARM SLOAD (100) instead of
	 * a COLD one (2100) and reports 2000 gas too little.
	 *
	 * Measured, on this exact backend: 2446 gas on the first call, then 446 forever.
	 * The node backends (which each run an isolated `eth_call`) correctly report
	 * 2446 every time. The cross-backend gas-equality assertion in evm.spec.ts is
	 * what surfaced this.
	 *
	 * So this is not a tuning knob: without it the raw backends are executing a
	 * DIFFERENT, non-spec gas schedule from every other backend, which makes both
	 * the gas numbers and the read-heavy timings meaningless as a comparison.
	 * (`cleanJournal` + `originalStorageCache.clear()` touch only warm/access
	 * bookkeeping; they do NOT mutate account state.)
	 */
	function resetPerTxState() {
		(evm as any).journal?.cleanJournal?.();
		(sm as any).originalStorageCache?.clear?.();
	}

	return {
		name:
			mode === 'default'
				? 'ethereumjs @ethereumjs/evm (MerkleStateManager + state-root)'
				: 'ethereumjs @ethereumjs/evm (SimpleStateManager, no trie/no root, noble keccak)',

		async setup() {
			if (mode === 'tuned') {
				sm = new SimpleStateManager();
				// Explicit keccak swap. noble is already the default in v10, but pinning
				// it here documents the lever and guards against a slower fallback.
				const common = new Common({
					chain: Mainnet,
					hardfork: Hardfork.Cancun,
					customCrypto: {keccak256: (msg: Uint8Array) => keccak_256(msg)},
				});
				evm = await createEVM({stateManager: sm, common});
			} else {
				sm = new MerkleStateManager();
				evm = await createEVM({stateManager: sm});
			}
			caller = createAddressFromString(DEPLOYER);
			await sm.putAccount(caller, new Account(0n, 10n ** 21n));
		},

		async deploy(bytecode) {
			const data = encodeDeployData({abi: counterAbi, bytecode});
			const res = await evm.runCall({
				caller,
				to: undefined,
				data: hexToBytes(data),
				gasLimit: 10_000_000n,
			});
			if (res.execResult.exceptionError) {
				throw new Error(
					'deploy reverted: ' + res.execResult.exceptionError.error,
				);
			}
			if (trackStateRoot) await sm.getStateRoot();
			return res.createdAddress!.toString() as `0x${string}`;
		},

		async sendCall(to, data) {
			const res = await evm.runCall({
				caller,
				to: createAddressFromString(to),
				data: hexToBytes(data),
				gasLimit: 5_000_000n,
			});
			if (res.execResult.exceptionError) {
				throw new Error(
					'call reverted: ' + res.execResult.exceptionError.error,
				);
			}
			// The "naive" integration recomputes the canonical state root each tx.
			if (trackStateRoot) await sm.getStateRoot();
		},

		async staticCall(to, data) {
			resetPerTxState();
			const res = await evm.runCall({
				caller,
				to: createAddressFromString(to),
				data: hexToBytes(data),
				gasLimit: 30_000_000n,
			});
			return bytesToHex(res.execResult.returnValue) as `0x${string}`;
		},

		// Raw EVM: `executionGasUsed` IS the execution gas, no intrinsic to subtract
		// (runCall is below the transaction layer, so it never charges intrinsic).
		async staticCallGas(to, data) {
			resetPerTxState();
			const res = await evm.runCall({
				caller,
				to: createAddressFromString(to),
				data: hexToBytes(data),
				gasLimit: 30_000_000n,
			});
			return res.execResult.executionGasUsed;
		},
	};
}

export const makeEthereumjsDefaultBackend = () => makeBackend('default');
export const makeEthereumjsTunedBackend = () => makeBackend('tuned');
