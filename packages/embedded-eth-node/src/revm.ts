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
 *
 * AND WHICH FORKS. It serves the hardforks whose transaction costing the node's
 * own arithmetic reproduces AND the PROTOCOL agrees with
 * (`REVM_SPEC_BY_HARDFORK` — Shanghai and Cancun today), and refuses the rest BY
 * NAME at construction (`REVM_REFUSED_HARDFORKS`): Prague and Osaka ABOVE that
 * range, because `./intrinsic-gas.ts` does not compute the EIP-7623 calldata
 * floor that revm enforces; Berlin, London and Paris BELOW it, because both this
 * node and revm charge EIP-3860's initcode word cost there and EIP-3860 did not
 * exist until Shanghai. See ADR 0008.
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
 * ethereumjs hardfork name -> revm spec: the hardforks this engine ADMITS.
 *
 * The node runs Cancun today and nothing here can change that, so this table is
 * a GUARD rather than a feature: if the node's hardfork ever moves, an engine
 * that silently kept running Cancun rules would charge different gas from the
 * default engine and nothing would say so.
 *
 * WHAT MAKES A FORK ADMISSIBLE is not that revm has a spec for it, and it is not
 * that the node and revm AGREE about it either. Agreement is necessary and not
 * sufficient: everything the node computes ABOUT a transaction — today the
 * shared intrinsic-gas arithmetic in ./intrinsic-gas.ts, and the read budget
 * assembled in `call` below — must (a) still agree with what revm ENFORCES under
 * that spec, and (b) be what the PROTOCOL charges at that fork, judged by
 * something that is neither of the two. Clause (b) is not decoration: the engine
 * SUBTRACTS `intrinsicGas()` from what revm spent and the node adds the same
 * number back, so the two sides agree about intrinsic gas by construction and a
 * term that is wrong at a fork is wrong on both sides at once.
 *
 * Prague and Osaka fail (a); Berlin, London and Paris failed (b), which is why
 * they are no longer here. See {@link REVM_REFUSED_HARDFORKS} and
 * `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`.
 * Anything not in either table is refused by name.
 */
export const REVM_SPEC_BY_HARDFORK: Readonly<Record<string, SpecName>> = {
	shanghai: 'SHANGHAI',
	cancun: 'CANCUN',
};

/**
 * The one reason Berlin, London and Paris are refused, shared because it IS one
 * reason: they all predate EIP-3860.
 *
 * The subtle part, and the reason this is a refusal rather than a fork gate in
 * ./intrinsic-gas.ts: gating the term would move the DEFAULT engine's estimate
 * and could not move revm's (the engine subtracts the node's intrinsic gas from
 * `totalGasSpent` and the node adds it straight back), so the gate on its own
 * converts an agreed wrong number into a cross-engine gas DIVERGENCE. The node
 * cannot make these forks correct while running on this artifact, by any change
 * to its own arithmetic — which is what makes refusing them the honest answer
 * rather than the lazy one.
 */
const PRE_EIP_3860 =
	`it predates EIP-3860 (Shanghai) and both sides charge it there anyway: ` +
	`this node's shared intrinsic-gas arithmetic (src/intrinsic-gas.ts) adds the ` +
	`initcode word cost of ceil(len/32) * 2 to every CREATE with no hardfork gate, ` +
	`and revm-wasm charges the same cost under this spec — so the two AGREE on a ` +
	`number the protocol does not charge, and eth_estimateGas for a deployment ` +
	`over-charges by 2 gas per initcode word (3072 gas for a maximum-size ` +
	`initcode) against what this node's own transaction path would spend. Gating ` +
	`the term would not fix it, only split the two engines: revm charges it either ` +
	`way. Measured in ` +
	`docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`;

/**
 * Hardforks revm HAS a spec for and this engine still refuses, each with the
 * reason quoted verbatim in the refusal.
 *
 * These are the silent-wrong-answer cases, and they come in two shapes.
 *
 * ABOVE the admitted range (Prague, Osaka), revm ENFORCES rules the node's own
 * arithmetic does not implement, so `eth_estimateGas` could return a number the
 * engine that produced it would REJECT — and viem uses that number as the
 * transaction's gas limit.
 *
 * BELOW it (Berlin, London, Paris), the node and revm agree perfectly and are
 * both wrong about the PROTOCOL: they charge EIP-3860's initcode word cost on
 * forks that predate EIP-3860. Nothing is rejected and no invariant between the
 * two engines trips — which is precisely why the fork has to be refused rather
 * than watched, because there is no later point at which anything would notice.
 *
 * Either way a loud refusal at construction is the honest edge (ADR 0004); a
 * plausible estimate is not.
 *
 * To admit one of these, make the node's arithmetic BOTH agree with revm under
 * that spec AND match the protocol at that fork — for the forks above, implement
 * the missing rule in ./intrinsic-gas.ts and in the read budget here; for the
 * forks below, note that no change to this node alone can do it — then prove it
 * against the engine and move the entry to {@link REVM_SPEC_BY_HARDFORK}. The
 * measurements behind each line are in
 * `docs/spikes/prague-intrinsic-gas-floor-or-refuse/` and
 * `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`.
 */
export const REVM_REFUSED_HARDFORKS: Readonly<Record<string, string>> = {
	berlin: PRE_EIP_3860,
	london: PRE_EIP_3860,
	paris: PRE_EIP_3860,
	prague:
		`revm enforces the EIP-7623 calldata floor (a transaction pays at least ` +
		`21000 + 10 gas per calldata token, tokens being 1 per zero byte and 4 per ` +
		`non-zero byte) and this node's shared intrinsic-gas arithmetic ` +
		`(src/intrinsic-gas.ts) computes only the pre-Prague formula, so ` +
		`eth_estimateGas would return a gas limit revm itself rejects with ` +
		`GasFloorMoreThanGasLimit for a calldata-heavy call — and a client uses an ` +
		`estimate as the transaction's gas limit`,
	osaka:
		`it inherits Prague's EIP-7623 calldata floor, which src/intrinsic-gas.ts ` +
		`does not compute, and adds the EIP-7825 transaction gas limit cap of ` +
		`16777216, which is below the node's default read budget of 30000000 — so ` +
		`an ordinary eth_call would be rejected outright with TxGasLimitGreaterThanCap`,
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
			// A HARDFORK THIS ENGINE CANNOT COST, refused the same way and for the same
			// reason as the state mode above: revm would run it and charge rules the
			// node's own arithmetic does not implement. Unreachable while the node is
			// pinned to Cancun, which is the point — it fires the day that moves,
			// rather than letting `eth_estimateGas` return a number this engine would
			// then reject.
			const hardfork = context.common.hardfork();
			const refused = REVM_REFUSED_HARDFORKS[hardfork];
			if (refused !== undefined) {
				throw new Error(
					`embedded-eth-node/revm: the revm engine does not admit hardfork '${hardfork}': ` +
						`${refused}. Use a hardfork this engine costs correctly ` +
						`(${Object.keys(REVM_SPEC_BY_HARDFORK).join(', ')}), or the default ` +
						`@ethereumjs/evm engine. See ` +
						`docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md.`,
				);
			}
			const mapped = REVM_SPEC_BY_HARDFORK[hardfork];
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
				// getter throws on a pre-Merge fork. Every admitted fork is post-Merge
				// today, so that is belt and braces — but it costs nothing and the
				// admitted set has moved twice already.
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
