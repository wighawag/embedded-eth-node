/**
 * revm.ts — `embedded-eth-node/revm`: a READ engine backed by `revm-wasm`.
 *
 * ```ts
 * import {createNode} from 'embedded-eth-node';
 * import {createRevmEngine} from 'embedded-eth-node/revm';
 * import {wasmUrl} from 'revm-wasm/wasm-url';           // bundler-resolved asset
 *
 * const node = await createNode({engine: await createRevmEngine({wasm: wasmUrl})});
 * ```
 *
 * OPT-IN, AND IN ITS OWN ENTRY POINT. The core never imports this module, so a
 * consumer who does not import it ships no revm (ADR 0006, and the bundle-size
 * assertion in `packages/benchmarks/test/evm.spec.ts` enforces it). `revm-wasm`
 * is nevertheless a plain `dependency`: a JS-only consumer pays install bytes
 * and ZERO bundle bytes.
 *
 * SCOPE: reads only — `eth_call`, `eth_estimateGas` and `eth_fillTransaction`'s
 * estimation. Transactions run on `@ethereumjs/vm` whatever engine is installed,
 * which is why the node calls this its `readEngine`. `Revm#call` is structurally
 * incapable of committing, so this engine needs neither the checkpoint/revert
 * nor the EIP-2929 reset the default `@ethereumjs/evm` engine pays for.
 *
 * WASM DELIVERY IS ONE CODE PATH. `revm-wasm` accepts bytes, a `URL`, a string,
 * a `Response` or an already-compiled `WebAssembly.Module`, so whatever the
 * caller has (a bundler-resolved asset, a URL fetched at runtime, a module
 * compiled once and reused) is passed straight through. NOTE FOR NODE: the
 * `revm-wasm/wasm-url` export is a `file:` URL, and Node's `fetch` cannot
 * resolve that scheme — in Node, read the bytes first
 * (`readFileSync(fileURLToPath(wasmUrl))`) and pass those. In a browser the URL
 * works as-is.
 *
 * WHAT IT COSTS. State is read through `SimpleStateManager`'s public checkpoint
 * stacks (see ./revm-state-store.ts and ADR 0005), which is the only synchronous
 * view of the node's state that exists — so this engine serves `stateMode:'none'`
 * ONLY, and refuses `'trie'` at construction rather than at the first opcode.
 */
import type {SimpleStateManager} from '@ethereumjs/statemanager';
import {createRevm, type SpecName, type WasmSource} from 'revm-wasm';
import type {Revm} from 'revm-wasm';
import {intrinsicGas} from './intrinsic-gas.js';
import {SimpleStateManagerStore} from './revm-state-store.js';
import type {
	ReadCallRequest,
	ReadCallResult,
	ReadEngine,
	ReadEngineContext,
} from './types.js';

/** This engine's stable identifier, as reported by `node.readEngine.id`. */
export const REVM_ENGINE_ID = 'revm-wasm';

export interface RevmEngineOptions {
	/**
	 * The `revm-wasm` module: bytes, a `URL`, a string URL, a `Response`, or an
	 * already-compiled `WebAssembly.Module` (the one to prefer when several nodes
	 * share one compilation). Passed through to `revm-wasm` untouched.
	 */
	wasm: WasmSource;
}

/**
 * ethereumjs hardfork name -> revm spec.
 *
 * The node runs Cancun today and nothing here can change that, so this table is
 * a GUARD rather than a feature: if the node's hardfork ever moves, an engine
 * that silently kept running Cancun rules would charge different gas from the
 * default engine and nothing would say so. Only the forks whose names both
 * projects agree on are listed; anything else is refused by name.
 */
const SPEC_BY_HARDFORK: Record<string, SpecName> = {
	berlin: 'BERLIN',
	london: 'LONDON',
	paris: 'MERGE',
	shanghai: 'SHANGHAI',
	cancun: 'CANCUN',
	prague: 'PRAGUE',
	osaka: 'OSAKA',
};

/**
 * Build a revm-backed read engine.
 *
 * The wasm is fetched and compiled HERE, so a consumer can start the download
 * while the UI paints and hand the finished engine to `createNode()` afterwards.
 * The engine binds to the node's state later, through the seam's
 * `connect(context)` hook (ADR 0006: an injected engine exists before the node
 * does, so it cannot capture anything at construction).
 */
export async function createRevmEngine(
	options: RevmEngineOptions,
): Promise<ReadEngine> {
	// The store is created UNBOUND: `createRevm` needs its store at instantiation
	// time, and the node's state manager does not exist yet. It reads nothing
	// until `connect` binds it, and throws if asked to.
	const store = new SimpleStateManagerStore();
	const revm: Revm = await createRevm({wasm: options.wasm, state: store});

	let spec: SpecName = 'CANCUN';
	let chainId = 1n;

	return {
		id: REVM_ENGINE_ID,

		connect(context: ReadEngineContext): void {
			// A MODE THIS ENGINE CANNOT SERVE, refused out loud and at construction.
			// `MerkleStateManager` has no synchronous view of state at any depth, and
			// revm's reads must be synchronous, so there is nothing to reach through
			// to. A consumer who asked for revm and silently got something else would
			// measure the wrong thing forever, so this throws out of `createNode()`
			// rather than at the first opcode. See ADR 0005.
			if (context.stateMode !== 'none') {
				throw new Error(
					`embedded-eth-node/revm: the revm engine cannot serve stateMode:'${context.stateMode}'. ` +
						`It reads the node's state SYNCHRONOUSLY through SimpleStateManager's ` +
						`checkpoint stacks (stateMode:'none'), and MerkleStateManager has no ` +
						`synchronous view at any depth — revm's interpreter has no suspension ` +
						`point to await a trie read at. Use stateMode:'none' with this engine, ` +
						`or the default @ethereumjs/evm engine with stateMode:'trie'. See ` +
						`docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md.`,
				);
			}
			const hardfork = context.common.hardfork();
			const mapped = SPEC_BY_HARDFORK[hardfork];
			if (mapped === undefined) {
				throw new Error(
					`embedded-eth-node/revm: no revm spec is known for hardfork '${hardfork}'. ` +
						`Running a read on a different fork from the transactions would charge ` +
						`different gas without saying so.`,
				);
			}
			spec = mapped;
			chainId = context.common.chainId();
			// The one cast: `StateManagerInterface` does not declare the stacks, but
			// `'none'` mode IS `SimpleStateManager`. Cast to the REAL type (never to
			// `any`) so every field access below is still typechecked and a rename in
			// `@ethereumjs/statemanager` is a compile error here. `bind` also asserts
			// the shape at runtime, which is the half the compiler cannot see.
			store.bind(context.stateManager as unknown as SimpleStateManager, {
				blockHash: context.getBlockHash,
			});
		},

		async call(request: ReadCallRequest): Promise<ReadCallResult> {
			store.beginCall();
			const isCreate = request.to === undefined;
			const intrinsic = intrinsicGas(request.data, isCreate);
			const header = request.block.header;

			// GAS BUDGETS, and why they are not the obvious mapping. The node hands an
			// engine the gas available to EXECUTION (it adds intrinsic gas itself, on
			// top of what the engine reports), and `@ethereumjs/evm`'s `runCall` gives
			// all of it to execution because it charges no intrinsic gas. revm charges
			// intrinsic out of the TRANSACTION gas limit, so the equivalent budget is
			// `request.gasLimit + intrinsic` — capped at the block gas limit, because
			// revm rejects a transaction whose gas limit exceeds the block's
			// (`CallerGasLimitMoreThanBlock`) and the node's default read budget is
			// exactly the block gas limit. The cap only bites for a call that needs
			// within `intrinsic` gas of the whole block limit.
			const blockGasLimit = header.gasLimit;
			const gasLimit =
				request.gasLimit + intrinsic > blockGasLimit
					? blockGasLimit
					: request.gasLimit + intrinsic;

			const block = {
				number: header.number,
				timestamp: header.timestamp,
				gasLimit: blockGasLimit,
				coinbase: header.coinbase.bytes,
				// BASE FEE IS ZERO FOR A READ, deliberately. revm validates the
				// transaction's gas price against the block's base fee and the caller's
				// balance against `gasLimit * gasPrice`, and an `eth_call` from an
				// unfunded address (the node defaults `from` to the zero address) must
				// still work. Every real client disables those checks for `eth_call`;
				// `revm-wasm@0.1.0` exposes no such flag, so a zero base fee with a zero
				// gas price is the way to get the same effect. The visible consequence is
				// that the BASEFEE opcode reads 0 inside a revm read, where the default
				// engine reports the block's real base fee.
				baseFeePerGas: 0n,
				...(header.excessBlobGas !== undefined
					? {excessBlobGas: header.excessBlobGas}
					: {}),
			};

			const common = {
				from: request.from.bytes,
				data: request.data,
				value: request.value,
				gasLimit,
				spec,
				chainId,
				block,
				// Logs and the post-state map are not part of a read's answer, and
				// building them costs ~0.9 microseconds per call.
				returnState: false,
			};

			// A CREATE-shaped read (`eth_estimateGas` for a deployment) has to go
			// through `create`, where `data` is init code — `call` would treat it as
			// calldata to the zero address and return a plausible, wrong estimate.
			// `commit: false` + `checkNonce: false` make it the simulation `eth_call`
			// semantics ask for; the store's write methods throw, so a commit that
			// slipped through would be loud rather than silent.
			const outcome = isCreate
				? revm.create({...common, commit: false, checkNonce: false})
				: revm.call({...common, to: request.to!.bytes});

			// EXECUTION gas, matching what `@ethereumjs/evm` reports: gas spent BEFORE
			// refunds (revm's `gasUsed` is net of them, `totalGasSpent` is not), less
			// the intrinsic gas the node adds back itself.
			const spent = outcome.totalGasSpent;
			return {
				returnValue: outcome.returnData,
				executionGasUsed: spent > intrinsic ? spent - intrinsic : 0n,
				error: outcome.success
					? undefined
					: (outcome.error ?? `revm ${outcome.status}`),
			};
		},
	};
}
