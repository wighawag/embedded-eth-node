/**
 * engine.ts — the node-side half of the engine seam: the DEFAULT read engine
 * (`@ethereumjs/evm` via `runCall`), plus {@link connectReadEngine}, the one
 * place an engine is brought up.
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
import type {
	ReadCallRequest,
	ReadCallResult,
	ReadEngine,
	ReadEngineContext,
} from './types.js';

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

/**
 * Bring an engine up for this node, or FAIL THE WHOLE CONSTRUCTION.
 *
 * THE POINT OF THIS FUNCTION IS THE ABSENCE OF A FALLBACK. Every other outcome
 * here is a silent lie: a consumer who passed a revm engine and was quietly
 * given `@ethereumjs/evm` instead would get a node that comes up, answers every
 * call correctly, and runs an order of magnitude slower than they believe. They
 * would measure it, be confused, and have no signal to follow. So there is no
 * `catch` that continues, no default substituted on failure, and no partially
 * connected engine: if the engine cannot serve this node, `createNode()` throws
 * (honest edge — see `docs/adr/0004-no-account-or-signing-methods.md` for the
 * same convention on the RPC surface).
 *
 * Two ways an injected engine fails, both landing here at construction rather
 * than at the first opcode:
 *  1. it is not a `ReadEngine` at all (a stray object, a module namespace, a
 *     forgotten `await` on `createRevmEngine()`) — otherwise the node comes up
 *     and dies at the first `eth_call` with a `not a function` TypeError that
 *     reads like a node bug;
 *  2. its `connect(context)` throws, either because it cannot initialise (no
 *     wasm, no memory) or because it refuses this node's configuration (the
 *     revm engine refuses `stateMode:'trie'`, having no synchronous view of a
 *     `MerkleStateManager` to read through).
 *
 * The engine's own message is preserved verbatim inside the thrown error's
 * message (not only as `cause`), because the engine is the only party that
 * knows WHY, and browser consoles routinely show a message without its cause.
 */
export async function connectReadEngine(
	engine: ReadEngine,
	context: ReadEngineContext,
): Promise<void> {
	if (typeof engine?.call !== 'function' || typeof engine?.id !== 'string') {
		throw new Error(
			`embedded-eth-node: the value passed as \`engine\` is not a ReadEngine — it must have a string \`id\` and a \`call(request)\` method (got ${describe(engine)}). ` +
				`The node does NOT fall back to the default @ethereumjs/evm engine, because a node running an engine you did not ask for is indistinguishable from one that works. ` +
				`If you built it with an async factory (e.g. \`createRevmEngine()\`), await it first.`,
		);
	}
	try {
		await engine.connect?.(context);
	} catch (err) {
		throw new Error(
			`embedded-eth-node: the read engine '${engine.id}' could not be connected, so the node was NOT created. ` +
				`It is deliberately NOT replaced by the default @ethereumjs/evm engine: that node would work, return correct results, and run at a completely different speed from the one you asked for, silently. ` +
				`Fix the configuration (this node is stateMode:'${context.stateMode}') or pass a different engine. Cause: ${message(err)}`,
			{cause: err},
		);
	}
}

/** A short, safe rendering of whatever was passed as an engine. */
function describe(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value !== 'object') return typeof value;
	if (typeof (value as ReadEngine).id === 'string') {
		return `an object with id '${(value as ReadEngine).id}' and no call()`;
	}
	return `an object with keys [${Object.keys(value as object).join(', ')}]`;
}

function message(err: unknown): string {
	return String((err as Error)?.message ?? err);
}
