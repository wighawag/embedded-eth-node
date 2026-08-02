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
 *
 * ONE ENGINE PER NODE. The returned engine binds to the first node it is given
 * to and REFUSES a second, because rebinding would silently re-point the first
 * node's reads at the second node's state. To pay the wasm compilation only
 * once, compile it yourself and pass the same `WebAssembly.Module` to each
 * `createRevmEngine()` call — that is what the `wasm` option accepting a
 * compiled module is for.
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
			// `request.gasLimit + intrinsic`, passed WHOLE: `disableBlockGasLimit`
			// below removes the block-limit check that used to force a cap here
			// (`CallerGasLimitMoreThanBlock`), and with it the divergence window where
			// a call needing within `intrinsic` gas of the entire block gas limit ran
			// out of gas on revm and completed on the default engine.
			const blockGasLimit = header.gasLimit;
			const gasLimit = request.gasLimit + intrinsic;

			const block = {
				number: header.number,
				timestamp: header.timestamp,
				gasLimit: blockGasLimit,
				coinbase: header.coinbase.bytes,
				// THE NODE'S REAL BASE FEE, because a contract can read it. `BASEFEE`
				// inside a view function must report the block the node actually has;
				// the validation the real value would otherwise trip is turned off
				// explicitly below (`disableBaseFee`) rather than bought with a zeroed
				// base fee, which is a lie the contract sees.
				baseFeePerGas: header.baseFeePerGas ?? 0n,
				// PREVRANDAO. Post-Merge it IS `mixHash` (the node writes
				// `NodeOptions.blockEnv.prevRandao` there and pins difficulty to 0), and
				// `mixHash` is read rather than the `prevRandao` getter because that
				// getter throws on a pre-Merge fork, which SPEC_BY_HARDFORK still maps.
				prevRandao: header.mixHash,
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
				// THE SIMULATION SWITCHES, and they are the whole reason this engine can
				// pass an honest block environment. Each one turns off a TRANSACTION
				// validity rule that a READ is not subject to, and every real client
				// turns the same ones off to serve `eth_call`:
				//
				//  disableBaseFee       the read's gas price is 0 and the block's base
				//                       fee is not (`GasPriceLessThanBasefee`). This is
				//                       ALSO what keeps a read from an unfunded address
				//                       working, see `disableBalanceCheck` below;
				//  disableBlockGasLimit the node's default read budget IS the block gas
				//                       limit, and revm charges intrinsic gas out of the
				//                       transaction limit while `@ethereumjs/evm`'s
				//                       `runCall` charges none, so the equivalent budget
				//                       is `gasLimit + intrinsic` — which is over the
				//                       block limit by exactly `intrinsic`
				//                       (`CallerGasLimitMoreThanBlock`);
				//  disableEip3607       EIP-3607 rejects a caller that holds code, which
				//                       is a rule about SENDING a transaction. Simulating
				//                       from a contract address is ordinary practice
				//                       (smart accounts, ERC-4337, multicall
				//                       aggregators), and `@ethereumjs/evm`'s `runCall`
				//                       never enforced it, so without this the two
				//                       engines disagree about whether the call runs.
				//
				// They are simulation-only: `revm-wasm` REFUSES to combine any of them
				// with committing (a committed transaction from a contract address is one
				// the chain would reject). This engine only ever reads, so that constraint
				// is structural here, but a future WRITE path must not reach for them.
				//
				// AND THE ONE THAT IS DELIBERATELY NOT SET: `disableBalanceCheck`.
				// Relaxing a TRANSACTION's validity rules must not relax the VALUE
				// TRANSFER. geth's `eth_call` skips the fee checks and still fails an
				// unaffordable value with `ErrInsufficientBalance`, and
				// `@ethereumjs/evm` agrees (`_reduceSenderBalance` throws
				// `insufficient balance`). The switch would raise the caller's balance
				// to at least `value`, so a value-bearing read would succeed here and
				// fail on the default engine: the same class of lie as the zeroed base
				// fee, and just as invisible to a gas bar, since a rejected read charges
				// no gas at all.
				//
				// It is not needed for the property it was taken for, and that is
				// MEASURED, not assumed (probe + numbers:
				// docs/spikes/revm-wasm-upgrade-honest-block-environment/). A read has no
				// gas price (`ReadCallRequest` carries none, so it is 0), which reduces
				// revm's demand from `gasLimit * gasPrice + value` to exactly `value`.
				// A zero-value read from an address holding no ether (the node defaults
				// `from` to the zero address) therefore passes the check untouched, and
				// the only case the switch would change is precisely the one that must
				// fail. If a gas price is ever plumbed into a read, revisit this: the
				// answer is then `disableBaseFee`-style relief for the FEE half only,
				// never a fabricated balance.
				disableBaseFee: true,
				disableBlockGasLimit: true,
				disableEip3607: true,
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
