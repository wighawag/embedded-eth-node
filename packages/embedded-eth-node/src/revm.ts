/**
 * revm.ts — `embedded-eth-node/revm`: the node's EVM, backed by `revm-wasm`.
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
 * BOTH HALVES OF THE SEAM. `call` serves `eth_call`, `eth_estimateGas` and
 * `eth_fillTransaction`'s estimation; `transact` executes a signed transaction
 * AND COMMITS it, which is the node's mining path. They are asymmetric in ONE
 * respect and it is a transaction's VALIDITY: `call` relaxes base fee, block gas
 * limit and EIP-3607 because a simulation is not a transaction, and `transact`
 * relaxes NOTHING — `revm-wasm` refuses to combine any of those switches with
 * committing, so the asymmetry is enforced by the binding rather than merely
 * intended. `Revm#call` is additionally incapable of committing whatever its
 * options say, so a read needs neither the checkpoint/revert nor the EIP-2929
 * reset the default `@ethereumjs/evm` engine pays for.
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
 * WHAT IT COSTS. State is read AND WRITTEN through `SimpleStateManager`'s public
 * checkpoint stacks plus the node's own storage overlays (see
 * ./revm-state-store.ts, ADR 0005 for the reach-through and ADR 0010 for the
 * ownership decision), which is the only synchronous view of the node's state
 * that exists — so this engine serves `stateMode:'none'` ONLY, and refuses
 * `'trie'` at construction rather than at the first opcode. THE NODE KEEPS
 * OWNING STATE: nothing is copied into wasm, and a transaction writes back only
 * the accounts it touched and the slots that changed.
 *
 * AND WHICH FORKS. It serves the hardforks whose transaction costing the node's
 * own arithmetic reproduces AND the PROTOCOL agrees with
 * (`REVM_SPEC_BY_HARDFORK` — Berlin through Cancun today), and refuses the rest
 * BY NAME at construction (`REVM_REFUSED_HARDFORKS`): Prague and Osaka, because
 * `./intrinsic-gas.ts` does not compute the EIP-7623 calldata floor that revm
 * enforces. See ADR 0008.
 */
import type {Common} from '@ethereumjs/common';
import type {Block} from '@ethereumjs/block';
import {bigIntToBytes, equalsBytes, generateAddress} from '@ethereumjs/util';
import type {OverlayStorageStateManager} from './state-manager.js';
import {createRevm, type SpecName, type WasmSource} from 'revm-wasm';
import type {BlockEnv, ExecuteOptions, Outcome, Revm} from 'revm-wasm';
import {intrinsicGas} from './intrinsic-gas.js';
import {SimpleStateManagerStore} from './revm-state-store.js';
import type {
	Engine,
	EngineContext,
	ReadCallRequest,
	ReadCallResult,
	TransactionRequest,
	TransactionResult,
} from './types.js';

/** This engine's stable identifier, as reported by `node.engine.id`. */
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
 * Prague and Osaka fail (a). Berlin, London and Paris once failed (b) — both
 * this node and `revm-wasm@0.3.0` charged EIP-3860's initcode word cost there,
 * and EIP-3860 arrived in Shanghai. `revm-wasm@0.3.1` fixed its half, and
 * ./intrinsic-gas.ts now gates the term on the node's `Common`, so all three are
 * back.
 *
 * ADDING A FORK BELOW BERLIN COSTS MORE THAN A LINE HERE. ./intrinsic-gas.ts is
 * protocol-correct over Istanbul..Cancun only: it hardcodes EIP-2028's 16 gas per
 * non-zero calldata byte, which was 68 before Istanbul, so a pre-Istanbul entry in
 * this table would make `eth_estimateGas` UNDER-estimate by 52 gas per non-zero
 * byte — and a client uses an estimate as the transaction's gas limit. Anything
 * in NEITHER table is refused by the unknown-fork guard in `connect` below, which
 * is what keeps that unreachable today. Gate the term the way EIP-3860's is gated
 * first, then move the entry; the clause-(b) assertions in
 * `test/revm-engine.spec.ts` measure that boundary from both sides and will fail
 * the build otherwise. See {@link REVM_REFUSED_HARDFORKS} and
 * `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`.
 * Anything not in either table is refused by name.
 *
 * FROZEN, AND NOT MERELY `Readonly`. The type annotation is erased at runtime, so
 * until this was frozen a consumer could re-admit a refused fork with a single
 * assignment through the export (`REVM_SPEC_BY_HARDFORK.prague = 'PRAGUE'`) and
 * `connect` below would wave it through — an `eth_estimateGas` revm itself then
 * rejects (`GasFloorMoreThanGasLimit`). A guard a stray assignment removes is
 * weaker than it reads, and these tables are PUBLIC precisely so the admitted set
 * can be read without provoking a throw, which is a reading surface, not an
 * editing one. The freeze is shallow and that is total here: every value is a
 * string. Asserted in `test/revm-engine.spec.ts` as a RUNTIME property (both
 * tables frozen, a re-admitting edit leaves them unchanged, and the guard still
 * refuses the fork afterwards), because a type cannot be measured.
 *
 * THE DECISION UNDER THAT, since the alternative was live: freezing is enough,
 * and `connect` deliberately keeps reading these objects rather than a snapshot
 * taken at module load. A snapshot would make the GUARD robust while leaving the
 * EXPORT a lie — a consumer who assigned `prague` would read a table saying
 * `prague` is served while every read of it was refused, i.e. two answers to the
 * one question these exports exist to answer. It would also fork the truth in
 * two: the table a reader inspects and the table the guard consults, kept in step
 * by nothing. Freezing removes the divergence at its source instead of tolerating
 * it, and it fails at the CONSUMER's own line (a `TypeError` under strict mode,
 * a dropped write under sloppy mode) rather than silently somewhere else. If a
 * later table ever has to be built at runtime rather than written literally here,
 * freeze it at the end of construction; do not reach for the snapshot.
 */
export const REVM_SPEC_BY_HARDFORK: Readonly<Record<string, SpecName>> =
	Object.freeze({
		berlin: 'BERLIN',
		london: 'LONDON',
		paris: 'MERGE',
		shanghai: 'SHANGHAI',
		cancun: 'CANCUN',
	});

/**
 * Hardforks revm HAS a spec for and this engine still refuses, each with the
 * reason quoted verbatim in the refusal.
 *
 * These are the silent-wrong-answer cases. From Prague on, revm ENFORCES rules
 * the node's own arithmetic does not implement, so `eth_estimateGas` could return
 * a number the engine that produced it would REJECT — and viem uses that number
 * as the transaction's gas limit. A loud refusal at construction is the honest
 * edge (ADR 0004); a plausible estimate is not.
 *
 * To admit one of these, make the node's arithmetic BOTH agree with revm under
 * that spec AND match the protocol at that fork: implement the missing rule in
 * ./intrinsic-gas.ts and in the read budget here, then prove it against the
 * engine and move the entry to {@link REVM_SPEC_BY_HARDFORK}. Note that the
 * EIP-7623 floor is not a TERM of the intrinsic-gas formula but a floor on the
 * transaction's total, so unlike the EIP-3860 fork gate it cannot be threaded
 * through ./intrinsic-gas.ts alone — both callers have to learn about it. The
 * measurements behind each line are in
 * `docs/spikes/prague-intrinsic-gas-floor-or-refuse/` and
 * `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/` (§6 for
 * the re-measurement on `revm-wasm@0.3.1`, which left both of these standing).
 *
 * FROZEN for the same reason as {@link REVM_SPEC_BY_HARDFORK}, where the freeze
 * decision (and why the guard reads these objects rather than a load-time
 * snapshot) is recorded: deleting an entry here is the other half of the
 * one-assignment re-admission the freeze exists to refuse.
 */
export const REVM_REFUSED_HARDFORKS: Readonly<Record<string, string>> =
	Object.freeze({
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
	});

/**
 * Build a revm-backed engine, serving BOTH halves of the seam: `call` for the
 * node's reads and `transact` for the transactions it mines and commits (see the
 * module header for how the two differ, which is validity and nothing else).
 *
 * The wasm is fetched and compiled HERE, so a consumer can start the download
 * while the UI paints and hand the finished engine to `createNode()` afterwards.
 * The engine binds to the node's state later, through the seam's
 * `connect(context)` hook (ADR 0006: an injected engine exists before the node
 * does, so it cannot capture anything at construction).
 *
 * ONE ENGINE PER NODE. The returned engine binds to the first node it is given
 * to and REFUSES a second, because rebinding would silently re-point the first
 * node's reads and transactions at the second node's state. To pay the wasm
 * compilation only once, compile it yourself and pass the same
 * `WebAssembly.Module` to each `createRevmEngine()` call — that is what the
 * `wasm` option accepting a compiled module is for.
 */
export async function createRevmEngine(
	options: RevmEngineOptions,
): Promise<Engine> {
	// The store is created UNBOUND: `createRevm` needs its store at instantiation
	// time, and the node's state manager does not exist yet. It reads nothing
	// until `connect` binds it, and throws if asked to.
	const store = new SimpleStateManagerStore();
	const revm: Revm = await createRevm({wasm: options.wasm, state: store});

	let spec: SpecName = 'CANCUN';
	let chainId = 1n;
	// THE NODE'S OWN `Common`, captured at connect and passed straight back into
	// the shared `intrinsicGas()` below. Not a hardfork name and not a derived
	// flag: `node.ts` asks the very same instance the very same question when it
	// ADDS the intrinsic gas this engine SUBTRACTS, so the two halves of an
	// `eth_estimateGas` cannot name different forks. See ./intrinsic-gas.ts.
	// (`nodeCommon`, not `common`: inside `call` below, `common` already names the
	// request fields COMMON to `revm.call` and `revm.create`.)
	let nodeCommon: Common | undefined;

	return {
		id: REVM_ENGINE_ID,

		connect(context: EngineContext): void {
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
			nodeCommon = context.common;
			// The one cast: `StateManagerInterface` does not declare the stacks, but
			// `'none'` mode IS the node's `OverlayStorageStateManager`. Cast to the REAL
			// type (never to `any`) so every field access below is still typechecked and
			// a rename in `@ethereumjs/statemanager` — or in our own state manager — is a
			// compile error here. `bind` also asserts the shape at runtime, which is the
			// half the compiler cannot see.
			store.bind(
				context.stateManager as unknown as OverlayStorageStateManager,
				{
					blockHash: context.getBlockHash,
				},
			);
		},

		async call(request: ReadCallRequest): Promise<ReadCallResult> {
			// Same shape as the store's own unbound guard (./revm-state-store.ts): an
			// engine used without a node has no fork to cost against, and guessing one
			// would answer with an estimate computed under rules the caller never chose.
			if (nodeCommon === undefined) {
				throw new Error(
					'embedded-eth-node/revm: the engine was asked for a read before connect() ' +
						'bound it to a node, so it has no hardfork to compute intrinsic gas at. ' +
						'Pass the engine to createNode() before using it.',
				);
			}
			store.beginExecution();
			const isCreate = request.to === undefined;
			const intrinsic = intrinsicGas(request.data, isCreate, nodeCommon);
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
			const gasLimit = request.gasLimit + intrinsic;
			const block = blockEnvOf(request.block);

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
				//  disableBlockGasLimit a read can be handed a gas budget EQUAL to the
				//                       block gas limit, on any node: that is what
				//                       `DEFAULT_READ_BUDGET` does on a default node (the
				//                       two numbers coincide at 30,000,000, and are still
				//                       decided apart, see src/node.ts), and an explicit
				//                       `gas` argument does it whatever `blockGasLimit`
				//                       is. revm then charges intrinsic gas out of the
				//                       transaction limit while `@ethereumjs/evm`'s
				//                       `runCall` charges none, so the equivalent budget
				//                       is `gasLimit + intrinsic`, which is over the
				//                       block limit by exactly `intrinsic`
				//                       (`CallerGasLimitMoreThanBlock`). READ PATH ONLY,
				//                       and NOT made removable by the node now enforcing
				//                       that limit: what it enforces is a rule about a
				//                       transaction being MINED (`transact` below, and
				//                       `refuseIfOverBlockGasLimit` in ./node.ts ahead of
				//                       it), and a read is not mined;
				//  disableEip3607       EIP-3607 rejects a caller that holds code, which
				//                       is a rule about SENDING a transaction. Simulating
				//                       from a contract address is ordinary practice
				//                       (smart accounts, ERC-4337, multicall
				//                       aggregators), and `@ethereumjs/evm`'s `runCall`
				//                       never enforced it, so without this the two
				//                       engines disagree about whether the call runs.
				//
				// THEY BELONG TO THIS METHOD AND TO NOTHING ELSE. `revm-wasm` REFUSES to
				// combine any of them with committing (a committed transaction from a
				// contract address is one the chain would reject), so `transact` below must
				// not reach for them — and a `commit:false` simulation that copied this
				// object would run a transaction with relaxed VALIDITY and no field of the
				// result would show it. `test/revm-engine.spec.ts` asserts their ABSENCE on
				// the transaction path rather than trusting this comment.
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
			// semantics ask for. They are stated EXPLICITLY here because `create`
			// defaults BOTH the other way (it is a transaction entry point), which is
			// the mirror image of `transact` below, where both defaults are what a
			// transaction wants and passing either would be a value a refactor can flip.
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

		async transact(request: TransactionRequest): Promise<TransactionResult> {
			store.beginExecution();
			const tx = request.tx as TransactionFields;

			// THE SENDER IS THE SEAM'S VALUE, and this engine must never derive one of
			// its own — not by `Revm#recoverSigner`, and not by asking the transaction
			// (`tx.getSenderAddress()`), which recovers too. `senderMode:'trusted'`
			// exists so that the CLAIMED sender may differ from the recoverable one (see
			// `parseTx` in ./node.ts and ADR 0002), so either would execute the
			// transaction as the WRONG address, charge that account, advance its nonce
			// and hand back a receipt that looks completely right. revm agrees by
			// construction: `transact` takes `from` directly and recovers nothing.
			const sender = request.sender.bytes;
			const options: ExecuteOptions = {
				from: sender,
				data: tx.data ?? EMPTY_DATA,
				value: tx.value ?? 0n,
				gasLimit: tx.gasLimit,
				// THE NONCE IS SUPPLIED AND THE CHECK IS NOT MENTIONED. `Revm#transact`
				// and `Revm#create` default `checkNonce` ON precisely because a caller who
				// forgets it gets a silently replayable transaction, and the node's
				// callers must not be able to reach that choice at all: it is decided by
				// WHICH METHOD OF THIS ENGINE was called (story 10 of the spec), so there
				// is no `checkNonce` here to flip and no option on
				// `TransactionRequest` to pass one through.
				nonce: tx.nonce,
				...feesOf(tx),
				// EIP-2930/1559 access list, in revm's own shape. Charged and warmed by
				// revm; the node does not price it (`eip-2930-access-lists-are-charged-and
				// -warmed` is where that is proven load-bearing rather than merely
				// passed). DROPPING it would not be caught by a cross-engine gas diff
				// alone, because a list the node also failed to charge would agree.
				...(tx.accessList !== undefined && tx.accessList.length > 0
					? {
							accessList: tx.accessList.map(([address, storageKeys]) => ({
								address,
								storageKeys,
							})),
						}
					: {}),
				// NOT MAPPED, and named so it is a known gap rather than an oversight:
				// EIP-4844's `blobVersionedHashes` / `maxFeePerBlobGas` (a type-3
				// transaction) and EIP-7702's `authorizationList` (post-Cancun, so
				// unreachable while this engine admits Berlin..Cancun). The type-3 receipt
				// is incomplete on BOTH engines — `blobGasUsed` / `blobGasPrice` are
				// absent from the seam's result altogether — and that limitation is
				// documented where it would be met by
				// `document-the-type-3-receipt-gap-where-it-would-be-met`.
				spec,
				chainId,
				block: blockEnvOf(request.block),
				// AND NOTHING ELSE. No `commit` (it defaults to committing, which is what
				// this method IS), no `returnState` (the logs, the bloom and the account
				// changes are all part of a transaction's answer, and `returnState:false`
				// cannot be combined with committing anyway), and above all NONE of the
				// read path's simulation switches: `disableBaseFee`,
				// `disableBlockGasLimit`, `disableEip3607` and `disableBalanceCheck` each
				// relax a transaction's VALIDITY, and a transaction that runs with them
				// relaxed is not a transaction. `revm-wasm` refuses to combine them with
				// committing, so copying the read path's options object here would throw
				// rather than lie — but that is the binding protecting us, not a design,
				// and the absence is asserted in `test/revm-engine.spec.ts`.
				//
				// THE ONE CONSEQUENCE THAT USED TO BE AN ASYMMETRY, now settled: this
				// engine rejects a transaction whose gas limit exceeds the block's
				// (`Transaction(CallerGasLimitMoreThanBlock)`) because it cannot relax that
				// rule while committing, and the default engine used to ACCEPT the same
				// transaction because it passed `skipBlockGasLimitValidation` to `runTx`.
				// That flag is gone (./engine.ts): both engines enforce the block's limit,
				// and a consumer who wants a bigger one raises `blockGasLimit` so the block
				// REALLY is bigger, which this engine honours by construction, since the
				// limit it validates against is the one in `block` just above. The node
				// refuses such a transaction before it reaches either engine, in words that
				// name the knob (`refuseIfOverBlockGasLimit` in ./node.ts); this rejection
				// is the backstop under it, in revm's own vocabulary.
			};

			// A DEPLOYMENT GOES THROUGH `create`, where `data` is INIT CODE: `transact`
			// would treat it as calldata to the zero address, mine a receipt with no
			// contract address and deploy nothing — measured, before this branch existed.
			// Same split as the read half makes for a CREATE-shaped estimate, and for the
			// same reason. BOTH entry points commit and check the nonce by default, which
			// is why neither is mentioned in `options`.
			const outcome =
				tx.to === undefined
					? revm.create(options)
					: revm.transact({...options, to: tx.to.bytes});

			// A TRANSACTION THAT NEVER RAN IS NOT A RECEIPT. revm reports an invalid
			// transaction as an OUTCOME (`status: 'validation-error'`, zero gas, nothing
			// committed) where `runTx` THROWS, and the node's mining path is written
			// against the throwing shape: `eth_sendRawTransaction` must fail rather than
			// mine a block containing a zero-gas receipt for a transaction that was
			// rejected. So this converts. The MESSAGE is revm's own, verbatim, because
			// it is the only thing that knows why (`NonceTooLow { tx: 0, state: 1 }`);
			// turning these into the node's own JSON-RPC errors, matched against what
			// the default engine says, is
			// `replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors`.
			if (outcome.status === 'validation-error') {
				throw new Error(
					`embedded-eth-node/revm: the transaction is invalid and was NOT executed: ` +
						`${outcome.error ?? 'revm reported no reason'}`,
				);
			}

			const created = createdAddressOf(outcome, tx, sender);
			return {
				status: outcome.success ? 1 : 0,
				// `gasUsed`, NOT `totalGasSpent`, and the two are different fields with
				// different meanings on this outcome: `gasUsed` is NET of refunds and
				// `totalGasSpent` is the gross number before them. A receipt reports the
				// net one — it is what the sender paid for, and what `@ethereumjs/vm`'s
				// `totalGasSpent` (confusingly) already is, since `runTx` subtracts the
				// refund from it before returning. THE READ PATH ABOVE TAKES THE OTHER
				// ONE, deliberately: a read has no refund and `eth_estimateGas` wants the
				// gross figure. Copying that mapping down here would put gas BEFORE
				// refunds on every receipt, which a value transfer (zero refund) cannot
				// detect — measured: a storage-clearing transaction reports
				// `totalGasSpent` 26004, `gasRefunded` 4800 and `gasUsed` 21204
				// (docs/spikes/revm-executes-the-first-transaction-with-commit/).
				gasUsed: outcome.gasUsed,
				// revm's OWN `Transaction::effective_gas_price`, not a second
				// implementation of `min(maxFee, baseFee + tip)`: the engine that charged
				// the sender is the engine that reports what it charged.
				effectiveGasPrice: outcome.effectiveGasPrice,
				// Emission order, reverted frames already excluded by revm.
				logs: outcome.logs ?? [],
				// ALWAYS 256 BYTES HERE, and that is the package's decoder doing work:
				// the wire format OMITS the bloom when the log count is zero, and the
				// decoder materialises the all-zero one. A hand-rolled reader of the blob
				// would either mis-parse everything after it or hand the node a 0-byte
				// `logsBloom`, which is why this path uses `revm-wasm`'s own decoder.
				logsBloom: outcome.logsBloom ?? EMPTY_BLOOM,
				...(created !== undefined ? {createdAddress: created} : {}),
			};
		},
	};
}

/** Calldata for a transaction that carries none. */
const EMPTY_DATA = /* @__PURE__ */ new Uint8Array();
/** The bloom of no logs, for the impossible case where the decoder omits it. */
const EMPTY_BLOOM = /* @__PURE__ */ new Uint8Array(256);

/**
 * The transaction fields this engine reads, named once.
 *
 * `TypedTransaction` is a UNION of five classes and the fee fields exist on
 * different members of it (`gasPrice` on legacy and EIP-2930, `maxFeePerGas` on
 * the 1559 family), so reading them off the union directly does not typecheck and
 * reading them off `any` typechecks anything. This is the narrow middle: exactly
 * the fields that are read, all optional, so a missing one is a branch rather
 * than a runtime surprise.
 */
interface TransactionFields {
	readonly to?: {readonly bytes: Uint8Array};
	readonly data?: Uint8Array;
	readonly value?: bigint;
	readonly gasLimit: bigint;
	readonly nonce: bigint;
	readonly gasPrice?: bigint;
	readonly maxFeePerGas?: bigint;
	readonly maxPriorityFeePerGas?: bigint;
	readonly accessList?: readonly [Uint8Array, Uint8Array[]][];
}

/**
 * The node's block, as revm's block environment. ONE mapping, shared by both
 * operations, because a read and a transaction observe the SAME block and an
 * engine that described it two ways could disagree with itself about `BASEFEE`.
 *
 * THE NODE'S REAL VALUES, never convenient ones. `BASEFEE` inside a contract
 * must report the block the node actually has; on the read path the validation
 * the real base fee would otherwise trip is turned off explicitly
 * (`disableBaseFee`) rather than bought with a zeroed base fee, which is a lie
 * the contract sees.
 *
 * PREVRANDAO is read off `mixHash`. Post-Merge it IS `mixHash` (the node writes
 * `NodeOptions.blockEnv.prevRandao` there and pins difficulty to 0), and the
 * `prevRandao` getter THROWS on a pre-Merge fork — which stopped being belt and
 * braces the moment `berlin` and `london` were admitted.
 */
function blockEnvOf(block: Block): BlockEnv {
	const header = block.header;
	return {
		number: header.number,
		timestamp: header.timestamp,
		gasLimit: header.gasLimit,
		coinbase: header.coinbase.bytes,
		baseFeePerGas: header.baseFeePerGas ?? 0n,
		prevRandao: header.mixHash,
		...(header.excessBlobGas !== undefined
			? {excessBlobGas: header.excessBlobGas}
			: {}),
	};
}

/**
 * The transaction's fee fields, in revm's vocabulary.
 *
 * revm keeps `gasPrice` and `maxFeePerGas` in ONE field and derives the EIP-2718
 * transaction type from which fields are present, so the two families are passed
 * as the two families and the type is left to the binding — whose own
 * documentation says the derivation is the part most easily got wrong by hand.
 * The PRESENCE of `maxPriorityFeePerGas` is what makes it derive a 1559-family
 * transaction, so an undefined one is not the same as a zero one.
 */
function feesOf(tx: TransactionFields): {
	gasPrice?: bigint;
	maxFeePerGas?: bigint;
	maxPriorityFeePerGas?: bigint;
} {
	if (tx.maxFeePerGas !== undefined) {
		return {
			maxFeePerGas: tx.maxFeePerGas,
			maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n,
		};
	}
	return {gasPrice: tx.gasPrice ?? 0n};
}

/**
 * The address a TOP-LEVEL creation produced, derived rather than reported — and
 * the ONE place that derivation lives.
 *
 * revm's outcome has no created-address field, so it comes out of the account
 * changes: the entry flagged `created`. THAT IS AMBIGUOUS THE MOMENT A
 * TRANSACTION PERFORMS NESTED CREATIONS, because every one of them is flagged the
 * same way, and the receipt's `contractAddress` names only the top-level one. Two
 * things narrow it here:
 *
 *  1. a transaction with a `to` creates nothing AT THE TOP LEVEL, whatever it
 *     creates inside, so it has no `contractAddress` at all;
 *  2. among several created entries, the top-level one is the address the
 *     PROTOCOL says a creation transaction produces, `keccak(rlp(sender, nonce))`
 *     — which `@ethereumjs/util` already computes, and which is unambiguous
 *     because a transaction's own creation is always a plain CREATE.
 *
 * The nested case is only PARTIALLY discharged: it is asserted against
 * `@ethereumjs/vm` by `revm-write-callbacks-reproduce-the-post-state`, on a
 * transaction that actually performs one. This function is where that assertion
 * lands, rather than an expression inlined in the result mapping.
 */
function createdAddressOf(
	outcome: Outcome,
	tx: TransactionFields,
	sender: Uint8Array,
): Uint8Array | undefined {
	if (tx.to !== undefined) return undefined;
	const created = (outcome.stateChanges ?? []).filter((c) => c.created);
	if (created.length <= 1) return created[0]?.address;
	const topLevel = generateAddress(sender, bigIntToBytes(tx.nonce));
	return created.find((c) => equalsBytes(c.address, topLevel))?.address;
}
