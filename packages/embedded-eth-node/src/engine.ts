/**
 * engine.ts — the node-side half of the engine seam: the DEFAULT engine
 * (`@ethereumjs/evm` via `runCall` for reads, `@ethereumjs/vm`'s `runTx` for
 * transactions), plus {@link connectEngine}, the one place an engine is brought
 * up.
 *
 * This is the engine the node uses when the consumer supplies none, and it is
 * exactly what the node's pure-read helper and its mining loop used to do inline.
 * Everything `@ethereumjs/vm` needs in order to make a call READ-ONLY lives HERE
 * rather than in the node above the seam — the checkpoint/revert and the EIP-2929
 * warm/access reset are both requirements of this EVM, not of "a read". An engine
 * that is structurally incapable of committing (revm's `call`) needs neither, and
 * the checkpoint is not free: `SimpleStateManager.checkpointSync()` copies all
 * three state maps and clones every account (0.384 ms per call at 2002 accounts,
 * larger than the whole revm read it would be wrapping). See
 * `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md`.
 *
 * The same rule decides where the TRANSACTION half's ethereumjs-specific settings
 * live: inside this module, at `transact` below.
 */
import {runTx, type VM} from '@ethereumjs/vm';
import type {StateManagerInterface} from '@ethereumjs/common';
import type {TypedTransaction} from '@ethereumjs/tx';
import type {
	Engine,
	EngineContext,
	ReadCallRequest,
	ReadCallResult,
	TransactionRequest,
	TransactionResult,
} from './types.js';

/** The default engine's stable identifier, as reported by `node.engine.id`. */
export const ETHEREUMJS_ENGINE_ID = '@ethereumjs/evm';

/**
 * Wrap the node's own `@ethereumjs/vm` as an engine, covering BOTH operations.
 * Built by the node (it needs the VM and the node's state manager), so it never
 * needs `connect`.
 */
export function createEthereumjsEngine(deps: {
	vm: VM;
	stateManager: StateManagerInterface;
}): Engine {
	const {vm, stateManager} = deps;
	const evm = vm.evm;
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

		async transact(request: TransactionRequest): Promise<TransactionResult> {
			// THE TWO SKIP FLAGS LIVE HERE, and nowhere else. They are what the node has
			// always passed `runTx`, they are load-bearing (a mined transaction is
			// validated differently without them), and they are `@ethereumjs/vm`'s OWN
			// vocabulary:
			//
			//   skipBlockGasLimitValidation  the node mines one block per transaction and
			//                                lets a client set any gas limit it likes;
			//                                `runTx` otherwise refuses a transaction whose
			//                                gas limit exceeds the block's.
			//   skipHardForkValidation       skips re-checking the transaction's own
			//                                hardfork-activation rules; the node builds
			//                                every block on the ONE `Common` it created,
			//                                so there is no second fork for a transaction
			//                                to be valid under.
			//
			// WHY NOT A NEUTRAL REQUEST FIELD. Two reasons, and the second is the one
			// that decides it. (1) They are one EVM's concepts: an engine that is not
			// `@ethereumjs/*` has no `runTx` to hand them to, so a field on
			// `TransactionRequest` would be a field every other engine must read and
			// ignore. (2) Worse, it would be a PROMISE the next engine cannot keep:
			// `revm-wasm` expresses the block-gas-limit relaxation as `disableBlockGasLimit`
			// and REFUSES to combine it with committing, so an engine asked to honour a
			// neutral `skipBlockGasLimitValidation` could only throw. A request field that
			// one engine must refuse is not a neutral request field.
			//
			// The node loses nothing by their living here: it builds blocks at
			// `blockGasLimit` and pins the fork itself, so what these buy is
			// `@ethereumjs/vm`'s validation matching the node's own configuration. An
			// engine with no equivalent simply does not have the checks to skip.
			//
			// NOTE that the conformance battery's reference `runTx` passes the same two
			// flags, so dropping one here would NOT show up as a battery failure.
			const res = await runTx(vm, {
				tx: request.tx,
				block: request.block,
				skipBlockGasLimitValidation: true,
				skipHardForkValidation: true,
			});
			return {
				status: (res.receipt as any).status === 0 ? 0 : 1,
				// `totalGasSpent` is NET of refunds (`gasRefund` is already subtracted),
				// which is what a receipt reports and what the sender paid for.
				gasUsed: res.totalGasSpent,
				// The base fee of the block this transaction is IN, which is the node's
				// own (it builds every block with one). `?? 0n` covers a pre-London header,
				// where there is no base fee to add and a legacy transaction's price is its
				// `gasPrice` regardless.
				effectiveGasPrice: effectiveGasPrice(
					request.tx,
					request.block.header.baseFeePerGas ?? 0n,
				),
				logs: (res.execResult.logs ?? []).map(([address, topics, data]) => ({
					address,
					topics,
					data,
				})),
				logsBloom: res.bloom.bitvector,
				createdAddress: res.createdAddress?.bytes,
			};
		},
	};
}

/**
 * Legacy-safe effective gas price: what THIS engine charged the sender per gas.
 *
 * It lives behind the seam because the engine that executed the transaction is the
 * engine that charged it, so the fee arithmetic has one implementation per engine
 * and none in the node — an engine reporting a price it did not charge is a bug in
 * that engine, not a disagreement between the node and itself.
 *
 * Type-0 (legacy) txs have no `maxFeePerGas`, so reading it unconditionally throws
 * ("Cannot mix BigInt and other types"). Branch on the field so legacy receipts
 * compute their `effectiveGasPrice` correctly.
 */
function effectiveGasPrice(tx: TypedTransaction, blockBaseFee: bigint): bigint {
	const anyTx = tx as any;
	if (anyTx.maxFeePerGas !== undefined && anyTx.maxFeePerGas !== null) {
		const maxFee: bigint = anyTx.maxFeePerGas;
		const maxPrio: bigint = anyTx.maxPriorityFeePerGas ?? 0n;
		const tip =
			maxFee - blockBaseFee < maxPrio ? maxFee - blockBaseFee : maxPrio;
		return tip + blockBaseFee;
	}
	return anyTx.gasPrice as bigint;
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
 * Three ways an injected engine fails, all landing here at construction rather
 * than at the first opcode:
 *  1. it is not an `Engine` at all (a stray object, a module namespace, a
 *     forgotten `await` on `createRevmEngine()`) — otherwise the node comes up
 *     and dies at the first `eth_call` with a `not a function` TypeError that
 *     reads like a node bug;
 *  2. it implements only HALF the seam: no usable `transact`. There is no second
 *     engine to mine on, so this is a missing capability the node cannot supply;
 *  3. its `connect(context)` throws, either because it cannot initialise (no
 *     wasm, no memory) or because it refuses this node's configuration (the
 *     revm engine refuses `stateMode:'trie'`, having no synchronous view of a
 *     `MerkleStateManager` to read through).
 *
 * The engine's own message is preserved verbatim inside the thrown error's
 * message (not only as `cause`), because the engine is the only party that
 * knows WHY, and browser consoles routinely show a message without its cause.
 */
export async function connectEngine(
	engine: Engine,
	context: EngineContext,
): Promise<void> {
	if (typeof engine?.call !== 'function' || typeof engine?.id !== 'string') {
		throw new Error(
			`embedded-eth-node: the value passed as \`engine\` is not an Engine — it must have a string \`id\` and a \`call(request)\` method (got ${describe(engine)}). ` +
				`The node does NOT fall back to the default @ethereumjs/evm engine, because a node running an engine you did not ask for is indistinguishable from one that works. ` +
				`If you built it with an async factory (e.g. \`createRevmEngine()\`), await it first.`,
		);
	}
	// `transact` IS REQUIRED, and this is the guard that says so at construction.
	// It was briefly optional — for exactly as long as the shipped revm engine had
	// no write half — and an engine that omitted it had its transactions mined on
	// the node's own `@ethereumjs/vm`. That fallback is GONE: a node must run ONE
	// EVM, so `node.engine` names the engine that answered its reads AND executed
	// its transactions, and a receipt can be attributed to it.
	//
	// MISSING and BROKEN are refused together, in the same words, because they are
	// the same mistake from the node's point of view (a half-built engine) and
	// neither can be served: there is no second engine to fall back to, and one
	// substituted silently is the lie `connectEngine` exists to refuse.
	if (typeof (engine as Engine).transact !== 'function') {
		throw new Error(
			`embedded-eth-node: the engine '${engine.id}' has no usable \`transact\` method (got ${typeof engine.transact}). ` +
				`An Engine implements BOTH operations — \`call\` for reads and \`transact\` to execute and commit a signed transaction — because the node executes its transactions on the engine you passed. ` +
				`It is deliberately NOT filled in with the default @ethereumjs/evm engine: a node running one EVM for reads and another for transactions has two chances to disagree with itself, and a receipt from it cannot be attributed to the engine ${'`node.engine`'} names.`,
		);
	}
	try {
		await engine.connect?.(context);
	} catch (err) {
		throw new Error(
			`embedded-eth-node: the engine '${engine.id}' could not be connected, so the node was NOT created. ` +
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
	if (typeof (value as Engine).id === 'string') {
		return `an object with id '${(value as Engine).id}' and no call()`;
	}
	return `an object with keys [${Object.keys(value as object).join(', ')}]`;
}

function message(err: unknown): string {
	return String((err as Error)?.message ?? err);
}
