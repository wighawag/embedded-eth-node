/**
 * engine.ts — the DEFAULT read engine: `@ethereumjs/evm` via `runCall`.
 *
 * This is the engine the node uses when the consumer supplies none, and it is
 * exactly what the node's pure-read helper used to do inline. Everything
 * `@ethereumjs/evm` needs in order to make a call READ-ONLY lives HERE rather
 * than in the node above the seam — the checkpoint/revert and the EIP-2929
 * warm/access reset are both requirements of this EVM, not of "a read". An engine
 * that is structurally incapable of committing (revm's `call`) needs neither, and
 * the checkpoint is not free: `SimpleStateManager.checkpointSync()` copies all
 * three state maps and clones every account (0.384 ms per call at 2002 accounts,
 * larger than the whole revm read it would be wrapping). See
 * `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md`.
 */
import type {EVMInterface} from '@ethereumjs/evm';
import type {StateManagerInterface} from '@ethereumjs/common';
import type {ReadCallRequest, ReadCallResult, ReadEngine} from './types.js';

/** The default engine's stable identifier, as reported by `node.readEngine.id`. */
export const ETHEREUMJS_ENGINE_ID = '@ethereumjs/evm';

/**
 * Wrap the node's own `@ethereumjs/evm` as a read engine. Built by the node (it
 * needs the VM's EVM and the node's state manager), so it never needs `connect`.
 */
export function createEthereumjsReadEngine(deps: {
	evm: EVMInterface;
	stateManager: StateManagerInterface;
}): ReadEngine {
	const {evm, stateManager} = deps;
	return {
		id: ETHEREUMJS_ENGINE_ID,
		async call(request: ReadCallRequest): Promise<ReadCallResult> {
			// eth_call / eth_estimateGas must NEVER mutate state. runCall on a CREATE
			// bumps the caller nonce (for address derivation) and writes storage, so we
			// checkpoint the state manager and revert after — reads stay pure.
			//
			// CRITICAL: runCall (unlike runTx) does NOT reset the EVM journal's
			// warm/access (EIP-2929) tracking or the EIP-2200 original-storage cache
			// between calls — only runTx calls journal.cleanup(). Without resetting them
			// here, slot warmth + "original value" leak from one pure call into the next,
			// so the SECOND+ eth_estimateGas for a warm SSTORE comes back ~2000 gas too
			// low (warm/dirty pricing instead of SSTORE_RESET). viem then uses that
			// under-estimate as the tx gas LIMIT and the real tx runs OUT OF GAS. Reset
			// the per-tx EVM state before each call so every estimate is computed from a
			// clean baseline, exactly as a fresh transaction would see it. (cleanJournal
			// + originalStorageCache.clear() reset only the warm/access bookkeeping; they
			// do NOT mutate account state.)
			evm.journal?.cleanJournal?.();
			stateManager.originalStorageCache?.clear?.();
			await stateManager.checkpoint();
			try {
				const res = await evm.runCall({
					caller: request.from,
					to: request.to,
					data: request.data,
					value: request.value,
					gasLimit: request.gasLimit,
					block: request.block as any,
				});
				return {
					returnValue: res.execResult.returnValue,
					executionGasUsed: res.execResult.executionGasUsed,
					error: res.execResult.exceptionError?.error,
				};
			} finally {
				await stateManager.revert();
			}
		},
	};
}
