/**
 * revm-engine.ts — the `embedded-eth-node/revm` engine, driven in a real browser
 * against the DEFAULT `@ethereumjs/evm` engine on the same state.
 *
 * What this pins:
 *   1. A node built with `createRevmEngine({wasm})` runs its reads on revm and
 *      says so (`node.readEngine.id`).
 *   2. `eth_call` and `eth_estimateGas` return the SAME return data and the SAME
 *      gas as the default engine, for the same calls on the same state — and the
 *      execution gas matches the reference numbers (`number()` 2446,
 *      `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 + its result hash), so a
 *      wrong answer is obviously wrong rather than plausibly wrong.
 *   3. The engine reads the node's AUTHORITATIVE state: a transaction mined by
 *      the node is visible to the next revm `eth_call` with no sync step.
 *   4. `eth_call` on revm cannot mutate state: a call that WOULD write leaves the
 *      node's storage untouched, and the store's write methods throw.
 *   5. `BLOCKHASH` answers with the node's real block hashes (the read engine
 *      context carries block access; an unwired `getBlockHash` would silently
 *      answer zero).
 *   5b. The BLOCK ENVIRONMENT is the node's own and is IDENTICAL on both
 *      engines: a contract reading `BASEFEE` / `PREVRANDAO` / `COINBASE` /
 *      `NUMBER` / `TIMESTAMP` / `GASLIMIT` inside an `eth_call` gets the same
 *      answer either way. Gas cannot see this: those opcodes are
 *      fee-independent, so an engine lying about the block still charges
 *      byte-identical gas.
 *   5c. An `eth_call` from an address that holds NO ETHER still works (the
 *      property the zeroed base fee used to buy), and one from an address that
 *      HOLDS CODE works too (EIP-3607 is a transaction rule, not an execution
 *      rule, and the default engine's `runCall` never enforced it).
 *   5d. A VALUE-BEARING read still obeys the transfer: relaxing a transaction's
 *      validity rules must not relax the value itself, so a read carrying more
 *      ether than the sender holds FAILS on both engines and an affordable one
 *      SUCCEEDS on both. The rejection is checked for its SHAPE, not merely for
 *      having happened: it starts at exactly `balance + 1`, carries no CALLEE
 *      answer, and NAMES a shortfall of funds in each engine's own words
 *      (`insufficient balance` / `LackOfFundForMaxFee`), read at the engine
 *      seam because the node flattens both into `execution reverted`.
 *   6. Both wasm delivery shapes work: a bundler-resolved asset and a
 *      runtime-fetched URL, through the same code path.
 *   7. `stateMode:'trie'` is REFUSED at construction, naming the reason, rather
 *      than constructing and failing at the first opcode.
 *   8. One engine instance serves ONE node: handing the same engine to a second
 *      `createNode()` is refused, rather than silently re-pointing the first
 *      node's reads at the second node's state.
 *   9. Every hardfork the engine ADMITS accepts what the node hands it: the
 *      `eth_estimateGas` for a calldata-heavy call is a gas limit revm will run
 *      (never `GasFloorMoreThanGasLimit`), and so is the node's default read
 *      budget (never `TxGasLimitGreaterThanCap`). The hardforks where that is
 *      NOT true are refused BY NAME at construction — and the same numbers are
 *      shown being rejected on them, so the refusal is visibly protecting
 *      something real rather than being decoration.
 *  10. Every hardfork the engine admits is one the PROTOCOL agrees with, not
 *      merely one revm agrees with. The node and revm share `intrinsicGas()`'s
 *      answer by construction (the engine subtracts what the node adds), so
 *      their agreement cannot see a term that is wrong at that fork. EVERY term
 *      the shared formula bakes in — the 21000 base, EIP-2028's 16/4 calldata
 *      bytes, the 32000 creation base and EIP-3860's initcode word — is
 *      therefore isolated by a delta and read three ways per admitted fork: the
 *      protocol (`@ethereumjs/tx`'s arithmetic at that `Common`, i.e. what the
 *      node's own `runTx` charges), revm MEASURED, and `intrinsicGas()` measured
 *      the same way. The one boundary the admitted set cannot span, EIP-2028's,
 *      is measured on the specs either side of it instead. Evidence:
 *      `docs/spikes/clause-b-covers-only-eip-3860-not-the-rest-of-the-formula/`
 *      and `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`.
 *  11. A CREATE-shaped `eth_estimateGas` returns the SAME number on BOTH
 *      engines at EVERY admitted fork, INCLUDING the pre-Shanghai ones — and
 *      that number is what the protocol charges. This is the one place the fork
 *      gate in `intrinsic-gas.ts` is visible: the node ADDS its intrinsic gas to
 *      what an engine reports and the revm engine SUBTRACTS the same number from
 *      revm's `totalGasSpent`, so an ungated EIP-3860 term moves the default
 *      engine's estimate and cannot move revm's.
 */
import {createNode} from '../../src/index.js';
import {
	createRevmEngine,
	REVM_ENGINE_ID,
	REVM_REFUSED_HARDFORKS,
	REVM_SPEC_BY_HARDFORK,
} from '../../src/revm.js';
import {SimpleStateManagerStore} from '../../src/revm-state-store.js';
// The REAL shared formula, not a restatement of it: what this file measures is
// whether the node's own arithmetic gates EIP-3860 by fork, so a mirror would
// only measure the mirror. See ../../src/intrinsic-gas.ts.
import {intrinsicGas} from '../../src/intrinsic-gas.js';
import {createEthereumjsReadEngine} from '../../src/engine.js';
import type {ReadEngine} from '../../src/index.js';
import {Common, Mainnet} from '@ethereumjs/common';
import {SimpleStateManager} from '@ethereumjs/statemanager';
import {createEVM} from '@ethereumjs/evm';
import {createBlock} from '@ethereumjs/block';
import {createLegacyTx} from '@ethereumjs/tx';
import {Account, createAddressFromString} from '@ethereumjs/util';
import {createRevm, MemoryStore, type SpecName} from 'revm-wasm';
// The BUNDLER-RESOLVED delivery shape: the build resolves the `.wasm` out of the
// `revm-wasm` package and puts it IN the build (esbuild's `binary` loader here;
// Vite's `?arraybuffer`, webpack's `asset/inline`), so the page fetches nothing
// and the consumer hard-codes no path.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';
import {
	createWalletClient,
	createPublicClient,
	custom,
	encodeFunctionData,
	decodeFunctionResult,
	hexToBytes,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {counterAbi, counterBytecode} from './counter.js';
import {
	blockEnvProbeAbi,
	blockEnvProbeRuntimeBytecode,
} from './block-env-probe.js';
import {
	classifyValueRead,
	isCalleeAnswer,
	namesLackOfFunds,
	OK,
	REJECTED,
} from './affordability.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
const chain = {
	id: CHAIN_ID,
	name: 'slim',
	nativeCurrency: {name: 'E', symbol: 'E', decimals: 18},
	rpcUrls: {default: {http: []}},
} as const;

/**
 * Restates the node's intrinsic-gas formula for a CALL, so decomposing an
 * estimate into execution gas is a real comparison rather than a tautology.
 *
 * A CALL ONLY, and deliberately: every fork-dependent term in the shared formula
 * (today just EIP-3860's initcode word cost) applies to a CREATE, so a call's
 * intrinsic gas is the same number at every fork this engine admits and needs no
 * hardfork to compute. The CREATE case is NOT mirrored — it is measured against
 * the real `intrinsicGas()` further down, because a mirror of a fork-gated
 * formula tests the mirror.
 */
function intrinsicGasForCall(dataHex: string): bigint {
	const hex = dataHex.startsWith('0x') ? dataHex.slice(2) : dataHex;
	let gas = 21_000n;
	for (let i = 0; i < hex.length; i += 2) {
		gas += hex.slice(i, i + 2) === '00' ? 4n : 16n;
	}
	return gas;
}

/**
 * Runtime bytecode returning `blockhash(number - 1)`.
 * PUSH1 01, NUMBER, SUB, BLOCKHASH, PUSH0, MSTORE, PUSH1 20, PUSH0, RETURN.
 */
const BLOCKHASH_PROBE_CODE = '0x60014303405f5260205ff3';
const BLOCKHASH_PROBE_ADDR = '0x00000000000000000000000000000000000b1a5e';

/** Where the block-environment probe's runtime code is placed on both nodes. */
const BLOCK_ENV_PROBE_ADDR = '0x00000000000000000000000000000000b10ce7ee';
/**
 * A block environment BOTH nodes are given verbatim, so the two chains cannot
 * drift on their own (the timestamp is pinned for the same reason: it is
 * otherwise `Date.now()` per node). Every value is distinctive: zero would be
 * indistinguishable from an engine that reads nothing.
 */
const SHARED_BLOCK_ENV = {
	timestamp: 1_700_000_000n,
	coinbase: '0x00000000000000000000000000000000c0173a5e',
	prevRandao:
		'0x5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed',
} as const;
const SHARED_BASE_FEE = 7_000_000_000n;
/** An address holding no ether at all — the EIP-3607-free unfunded caller. */
const UNFUNDED_CALLER = '0x00000000000000000000000000000000dead0001';
/**
 * A codeless address for the calldata-heavy read: no code means no execution
 * gas, so the transaction's cost is calldata and nothing else — which is exactly
 * the shape EIP-7623's floor was written for.
 */
const CALLDATA_SINK_ADDR = '0x00000000000000000000000000000000ca11da7a';
/** A codeless address to send ether to, for the value-bearing reads. */
const VALUE_SINK_ADDR = '0x0000000000000000000000000000000000005151';
/** What the funded caller starts with on both nodes (see {@link nodeWith}). */
const FUNDED_BALANCE = 10n ** 24n;

async function nodeWith(
	engine?: ReadEngine,
	extra: Record<string, unknown> = {},
) {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: FUNDED_BALANCE},
		engine,
		...extra,
	});
	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	return {
		node,
		pub: createPublicClient({chain, transport}),
		wallet: createWalletClient({account, chain, transport}),
	};
}

export async function runRevmEngineChecks(params: {runtimeWasmUrl: string}) {
	const out: Record<string, unknown> = {};

	// ---------- delivery shape 1: a BUNDLER-RESOLVED asset ----------
	const fromAsset = await createRevmEngine({wasm: bundlerResolvedWasm});
	// ---------- delivery shape 2: a RUNTIME-FETCHED URL ----------
	const fromUrl = await createRevmEngine({
		wasm: new URL(params.runtimeWasmUrl),
	});

	const def = await nodeWith();
	const revm = await nodeWith(fromAsset);
	out.defaultEngineId = def.node.readEngine.id;
	out.revmEngineId = revm.node.readEngine.id;
	out.revmEngineIdExpected = REVM_ENGINE_ID;

	// Deploy the SAME contract on both nodes, through viem — which estimates gas
	// first, so the CREATE-shaped read path runs on revm too.
	const deployed: Record<string, `0x${string}`> = {};
	for (const [label, ctx] of [
		['default', def],
		['revm', revm],
	] as const) {
		const hash = await ctx.wallet.deployContract({
			abi: counterAbi,
			bytecode: counterBytecode,
			args: [],
		});
		const rcpt = await ctx.pub.getTransactionReceipt({hash});
		deployed[label] = rcpt.contractAddress!;
	}
	out.sameDeployAddress = deployed.default === deployed.revm;

	// ---------- results + gas, engine against engine ----------
	const calls: {name: string; data: `0x${string}`}[] = [
		{
			name: 'number',
			data: encodeFunctionData({abi: counterAbi, functionName: 'number'}),
		},
		{
			name: 'sumTo2000',
			data: encodeFunctionData({
				abi: counterAbi,
				functionName: 'sumTo',
				args: [2000n],
			}),
		},
		{
			name: 'keccakLoop2000',
			data: encodeFunctionData({
				abi: counterAbi,
				functionName: 'keccakLoop',
				args: [2000n],
			}),
		},
		{
			name: 'increment',
			data: encodeFunctionData({abi: counterAbi, functionName: 'increment'}),
		},
	];
	const callResults: Record<string, string> = {};
	const estimates: Record<string, string> = {};
	const executionGas: Record<string, string> = {};
	for (const {name, data} of calls) {
		for (const [label, ctx] of [
			['default', def],
			['revm', revm],
		] as const) {
			const p = {from: account.address, to: deployed[label], data};
			callResults[`${name}.${label}`] = String(
				await ctx.node.request({method: 'eth_call', params: [p]}),
			);
			const est = String(
				await ctx.node.request({method: 'eth_estimateGas', params: [p]}),
			);
			estimates[`${name}.${label}`] = est;
			executionGas[`${name}.${label}`] = (
				BigInt(est) - intrinsicGasForCall(data)
			).toString();
		}
	}
	out.callResults = callResults;
	out.estimates = estimates;
	out.executionGas = executionGas;
	out.resultsMatch = calls.every(
		({name}) => callResults[`${name}.default`] === callResults[`${name}.revm`],
	);
	out.gasMatches = calls.every(
		({name}) => estimates[`${name}.default`] === estimates[`${name}.revm`],
	);

	// ---------- the engine reads the node's AUTHORITATIVE state ----------
	const incrementData = encodeFunctionData({
		abi: counterAbi,
		functionName: 'increment',
	});
	const txHash = await revm.wallet.sendTransaction({
		to: deployed.revm,
		data: incrementData,
	});
	out.txStatus = (await revm.pub.getTransactionReceipt({hash: txHash})).status;
	// No sync step of any kind between the transaction and this read.
	out.numberAfterTx = String(
		await revm.pub.readContract({
			address: deployed.revm,
			abi: counterAbi,
			functionName: 'number',
		}),
	);

	// ---------- a read cannot mutate ----------
	const storageBefore = await revm.node.request({
		method: 'eth_getStorageAt',
		params: [deployed.revm, '0x0', 'latest'],
	});
	await revm.node.request({
		method: 'eth_call',
		params: [{from: account.address, to: deployed.revm, data: incrementData}],
	});
	const storageAfter = await revm.node.request({
		method: 'eth_getStorageAt',
		params: [deployed.revm, '0x0', 'latest'],
	});
	out.callDidNotMutateState = storageBefore === storageAfter;
	out.storageAfterCall = String(storageAfter);
	// ...and the store revm reads through cannot write AT ALL: all five write
	// methods throw, so a commit could never be silent.
	const readOnlyStore = new SimpleStateManagerStore();
	out.writeMethodsThrow = (
		[
			'setAccount',
			'setCode',
			'setStorage',
			'clearStorage',
			'removeAccount',
		] as const
	).every((m) => {
		try {
			(readOnlyStore[m] as () => void)();
			return false;
		} catch {
			return true;
		}
	});

	// ---------- CALLERS A SIMULATION MUST SERVE: unfunded, and holding code ----
	// The zeroed base fee existed to keep an `eth_call` from an address holding no
	// ether working (the node defaults `from` to the zero address). Replacing it
	// with `disableBaseFee` (and NOT `disableBalanceCheck`, which would fabricate
	// the caller's balance) has to keep exactly that, so
	// the same read is made from a FUNDED address, from an UNFUNDED one, and from
	// an address that HOLDS CODE — the last being EIP-3607, which revm enforces on
	// a transaction and `@ethereumjs/evm`'s `runCall` never enforced at all.
	for (const ctx of [def, revm]) {
		await ctx.node.request({
			method: 'evm_setCode',
			params: [BLOCK_ENV_PROBE_ADDR, blockEnvProbeRuntimeBytecode],
		});
	}
	// A PURE function (`sumTo(4)` == 0+1+2+3 == 6), so the answer cannot depend on
	// which node's state the call ran against: by this point the revm node carries
	// an extra mined `increment()` from the section above, and a storage read would
	// compare the two chains rather than the two engines.
	const pureCallData = encodeFunctionData({
		abi: counterAbi,
		functionName: 'sumTo',
		args: [4n],
	});
	const callers: Record<string, string> = {
		funded: account.address,
		unfunded: UNFUNDED_CALLER,
		// An address that holds code, i.e. the EIP-3607 case: smart-account /
		// ERC-4337 flows, multicall aggregators, any UI previewing what one contract
		// sees when called by another.
		contract: BLOCK_ENV_PROBE_ADDR,
	};
	const callerResults: Record<string, string> = {};
	const callerGas: Record<string, string> = {};
	const callerErrors: Record<string, string> = {};
	for (const [who, from] of Object.entries(callers)) {
		for (const [label, ctx] of [
			['default', def],
			['revm', revm],
		] as const) {
			const p = {from, to: deployed[label], data: pureCallData};
			try {
				callerResults[`${who}.${label}`] = String(
					await ctx.node.request({method: 'eth_call', params: [p]}),
				);
				callerGas[`${who}.${label}`] = String(
					await ctx.node.request({method: 'eth_estimateGas', params: [p]}),
				);
			} catch (e) {
				// Recorded rather than thrown: a refusal here is the DIVERGENCE this
				// test is looking for, and the spec should report which caller failed
				// on which engine rather than one opaque stack.
				callerErrors[`${who}.${label}`] = String((e as Error)?.message ?? e);
			}
		}
	}
	out.callerResults = callerResults;
	out.callerGas = callerGas;
	out.callerErrors = callerErrors;
	out.callerResultsMatch = Object.keys(callers).every(
		(who) => callerResults[`${who}.default`] === callerResults[`${who}.revm`],
	);
	out.callerGasMatches = Object.keys(callers).every(
		(who) => callerGas[`${who}.default`] === callerGas[`${who}.revm`],
	);
	// ...and every caller sees the SAME contract answer: who asks cannot change
	// what a view function returns.
	out.callerResultsAgree = Object.keys(callers).every(
		(who) => callerResults[`${who}.revm`] === callerResults['funded.revm'],
	);

	// ---------- VALUE-BEARING READS: relaxed VALIDITY, honest TRANSFER ---------
	// The simulation switches turn off a TRANSACTION's validity rules, which is
	// what lets a read run from an address holding no ether. They must NOT turn
	// off the value TRANSFER: geth's `eth_call` skips the fee checks and still
	// fails an unaffordable value with `ErrInsufficientBalance`, and
	// `@ethereumjs/evm` agrees (`_reduceSenderBalance` throws
	// `insufficient balance`). An engine that fabricated the caller's balance
	// would answer a transfer the chain could never make: the same class of lie
	// as the zeroed base fee, and just as invisible to the gas bars, because a
	// rejected read charges no gas on either engine.
	//
	// The sender is named EXPLICITLY in every case. The node's default `from` is
	// the zero address, which is ALSO its default coinbase, so on these two nodes
	// (which have mined priority-fee-paying transactions by now) it holds ether
	// and would prove nothing about an unfunded sender. The conformance battery's
	// own step covers the default sender, on a node that has mined nothing and
	// with the balance asserted first.
	//
	// A FAILURE IS NOT ACCEPTED ON THE STRENGTH OF HAVING FAILED. Each outcome is
	// classified (./affordability.ts): a negative case must fail as an ENGINE
	// rejection carrying no CALLEE answer, and the rejection must begin at exactly
	// `balance + 1` on each node's own balance. The engines' own words for it are
	// asserted one layer down, at the seam, in the section after this one.
	const fundedBalance: Record<string, bigint> = {};
	for (const [label, ctx] of [
		['default', def],
		['revm', revm],
	] as const) {
		// READ, not assumed: both nodes have mined priority-fee-paying transactions
		// by now (the revm node one more than the default node), so neither holds
		// `FUNDED_BALANCE` any more — and a boundary stated against a stale number
		// would be a boundary about nothing.
		fundedBalance[label] = BigInt(
			(await ctx.node.request({
				method: 'eth_getBalance',
				params: [account.address, 'latest'],
			})) as string,
		);
	}
	out.fundedBalances = {
		default: fundedBalance.default.toString(),
		revm: fundedBalance.revm.toString(),
	};
	const valueCases: {
		name: string;
		from: string;
		/** The value to send, given the SENDER's balance on the node under test. */
		value: (balance: bigint) => bigint;
		ok: boolean;
	}[] = [
		// The property the zeroed base fee bought, restated with a value of 0.
		{
			name: 'unfundedZeroValue',
			from: UNFUNDED_CALLER,
			value: () => 0n,
			ok: true,
		},
		{
			name: 'fundedAffordable',
			from: account.address,
			value: () => 1n,
			ok: true,
		},
		// The WHOLE balance, to the wei: the last value the sender can afford.
		{
			name: 'fundedWholeBalance',
			from: account.address,
			value: (balance) => balance,
			ok: true,
		},
		// The three a fabricated balance would wrongly answer.
		{
			name: 'unfundedOneWei',
			from: UNFUNDED_CALLER,
			value: () => 1n,
			ok: false,
		},
		{
			name: 'fundedAboveBalance',
			from: account.address,
			value: () => FUNDED_BALANCE + 1n,
			ok: false,
		},
		// ...and the other side of the wei-exact boundary: one wei more than the
		// sender holds, same sender, same call site as `fundedWholeBalance`. Only a
		// balance check draws a line THERE.
		{
			name: 'fundedBalancePlusOne',
			from: account.address,
			value: (balance) => balance + 1n,
			ok: false,
		},
	];
	const valueOutcomes: Record<string, string> = {};
	const valueExpected: Record<string, string> = {};
	for (const c of valueCases) {
		valueExpected[c.name] = c.ok ? OK : REJECTED;
		for (const [label, ctx] of [
			['default', def],
			['revm', revm],
		] as const) {
			valueOutcomes[`${c.name}.${label}`] = await classifyValueRead(() =>
				ctx.node.request({
					method: 'eth_call',
					params: [
						{
							from: c.from,
							to: VALUE_SINK_ADDR,
							value: '0x' + c.value(fundedBalance[label]).toString(16),
						},
					],
				}),
			);
		}
	}
	out.valueOutcomes = valueOutcomes;
	out.valueExpected = valueExpected;
	out.valueOutcomesMatch = valueCases.every(
		({name}) =>
			valueOutcomes[`${name}.default`] === valueOutcomes[`${name}.revm`],
	);
	// ...and both engines match the ABSOLUTE statement, not merely each other:
	// two engines can agree on an answer neither should have given.
	out.valueOutcomesCorrect = valueCases.every(
		({name}) =>
			valueOutcomes[`${name}.default`] === valueExpected[name] &&
			valueOutcomes[`${name}.revm`] === valueExpected[name],
	);

	// ---------- WHAT THE REJECTION SAYS, at the seam where it still says it ----
	// Above the seam the two engines are indistinguishable BY DESIGN: the node
	// flattens every engine failure into one `RpcError(3, 'execution reverted')`,
	// so the section above can check the SHAPE of a rejection but never its
	// words. The words exist one layer down, on `ReadEngine.call`'s result, and
	// the two engines are meant to differ there:
	//
	//   `@ethereumjs/evm` : `insufficient balance` (EVMError, thrown by
	//                       `_reduceSenderBalance`)
	//   revm             : `Transaction(LackOfFundForMaxFee { fee, balance })`
	//
	// So the engines are driven DIRECTLY here, each on its own state carrying one
	// funded account, and both are held to the same predicate: the failure must
	// NAME a shortfall of funds ({@link namesLackOfFunds} — a vocabulary, never
	// one engine's string asserted on the other), must carry no CALLEE answer in
	// its return data (revm puts its own message there, which ./affordability.ts
	// tells apart from a contract's), and must start at exactly `balance + 1`.
	// That is the difference between "this call did not succeed" and "the sender
	// could not afford this transfer".
	const seamCommon = new Common({
		chain: {...Mainnet, chainId: CHAIN_ID, name: 'embedded-eth-node'},
		// The fork the node pins, so the seam probe fails the way the node would.
		hardfork: 'cancun',
	});
	const SEAM_BALANCE = 10n ** 18n;
	/**
	 * One value-bearing read made STRAIGHT to an engine, on a state where the
	 * sender holds exactly {@link SEAM_BALANCE} — the same request shape
	 * `node.ts`'s `evmCall` builds, minus the node's error flattening.
	 */
	async function valueReadAtSeam(
		engineKind: 'default' | 'revm',
		value: bigint,
	): Promise<{failed: boolean; error: string; calleeAnswer: boolean}> {
		const stateManager = new SimpleStateManager();
		await stateManager.putAccount(
			createAddressFromString(account.address),
			new Account(0n, SEAM_BALANCE),
		);
		let engine: ReadEngine;
		if (engineKind === 'default') {
			engine = createEthereumjsReadEngine({
				evm: await createEVM({common: seamCommon, stateManager}),
				stateManager,
			});
		} else {
			engine = await createRevmEngine({wasm: bundlerResolvedWasm});
			await engine.connect!({
				stateManager,
				common: seamCommon,
				getBlockHash: () => undefined,
				stateMode: 'none',
			});
		}
		const r = await engine.call({
			from: createAddressFromString(account.address),
			to: createAddressFromString(VALUE_SINK_ADDR),
			data: new Uint8Array(),
			value,
			gasLimit: 30_000_000n,
			block: createBlock(
				{
					header: {
						number: 1n,
						gasLimit: 30_000_000n,
						timestamp: SHARED_BLOCK_ENV.timestamp,
						baseFeePerGas: SHARED_BASE_FEE,
					},
				},
				{common: seamCommon},
			),
		});
		return {
			failed: r.error !== undefined,
			error: String(r.error ?? ''),
			calleeAnswer: isCalleeAnswer(r.returnValue),
		};
	}
	const valueFailureShapes: Record<string, string> = {};
	const valueSeamOutcomes: Record<string, string> = {};
	for (const kind of ['default', 'revm'] as const) {
		const overBalance = await valueReadAtSeam(kind, SEAM_BALANCE + 1n);
		const wholeBalance = await valueReadAtSeam(kind, SEAM_BALANCE);
		// Recorded verbatim, so the report shows what each engine actually said
		// rather than only whether a predicate liked it.
		valueFailureShapes[kind] = overBalance.error;
		valueSeamOutcomes[kind] = [
			`balance+1: ${overBalance.failed ? 'failed' : 'SUCCEEDED'}`,
			namesLackOfFunds(overBalance.error)
				? 'names a lack of funds'
				: 'does NOT name a lack of funds',
			overBalance.calleeAnswer
				? 'CARRIES a callee answer'
				: 'no callee return data',
			`balance: ${wholeBalance.failed ? 'FAILED' : 'succeeded'}`,
		].join(', ');
	}
	out.valueFailureShapes = valueFailureShapes;
	out.valueSeamOutcomes = valueSeamOutcomes;
	out.valueSeamExpected =
		'balance+1: failed, names a lack of funds, no callee return data, balance: succeeded';
	// ...and the predicate is only worth anything if it REFUSES the failures this
	// read path can produce for other reasons. These are the real strings (revm's
	// from `docs/spikes/revm-wasm-upgrade-honest-block-environment/measurements.md`,
	// the rest from the node and `@ethereumjs/evm`), and none of them may pass as
	// an affordability rejection.
	out.lackOfFundsVocabularyRejects = [
		'execution reverted',
		'revert',
		'out of gas',
		'Transaction(GasPriceLessThanBasefee)',
		'Transaction(CallerGasLimitMoreThanBlock)',
		'Transaction(RejectCallerWithCode)',
		'Invalid address input=0xnotanaddress',
		'invalid opcode',
		// ...and the two near-misses, which is where a vocabulary would rot: a
		// CONTRACT's revert reason naming a balance (a token's, not the sender's
		// ether) and one naming a shortfall of something else. Each keeps one half
		// of the predicate load-bearing.
		'ERC20: transfer amount exceeds balance',
		'ERC20: insufficient allowance',
	].every((message) => !namesLackOfFunds(message));

	// ---------- the BLOCK ENVIRONMENT, engine against engine ----------
	// Two nodes given the SAME block environment verbatim, so any difference in
	// what a contract reads is the ENGINE. This is the bar the gas gate cannot be:
	// BASEFEE and friends are fee-independent, so an engine running a read against
	// a block the node never had charges byte-identical gas for it.
	const blockEnvNodes = {
		default: await nodeWith(undefined, {
			blockEnv: SHARED_BLOCK_ENV,
			baseFeePerGas: SHARED_BASE_FEE,
		}),
		revm: await nodeWith(await createRevmEngine({wasm: bundlerResolvedWasm}), {
			blockEnv: SHARED_BLOCK_ENV,
			baseFeePerGas: SHARED_BASE_FEE,
		}),
	};
	const blockEnvData = encodeFunctionData({
		abi: blockEnvProbeAbi,
		functionName: 'env',
	});
	const blockEnvReads: Record<string, string> = {};
	for (const [label, ctx] of Object.entries(blockEnvNodes)) {
		await ctx.node.request({
			method: 'evm_setCode',
			params: [BLOCK_ENV_PROBE_ADDR, blockEnvProbeRuntimeBytecode],
		});
		// One mined block, so the read runs against a block carrying the configured
		// environment (genesis carries neither coinbase nor prevRandao).
		await ctx.node.mine();
		blockEnvReads[label] = String(
			await ctx.node.request({
				method: 'eth_call',
				// No `from`: the zero address, i.e. the unfunded default, reading a
				// block whose base fee is 7 gwei.
				params: [{to: BLOCK_ENV_PROBE_ADDR, data: blockEnvData}],
			}),
		);
	}
	out.blockEnvReads = blockEnvReads;
	out.blockEnvMatches = blockEnvReads.default === blockEnvReads.revm;
	const decoded = decodeFunctionResult({
		abi: blockEnvProbeAbi,
		functionName: 'env',
		data: blockEnvReads.revm as `0x${string}`,
	});
	out.blockEnvOnRevm = {
		basefee: decoded[0].toString(),
		prevrandao: '0x' + decoded[1].toString(16).padStart(64, '0'),
		coinbase: decoded[2].toLowerCase(),
		number: decoded[3].toString(),
		timestamp: decoded[4].toString(),
		gaslimit: decoded[5].toString(),
	};
	out.blockEnvExpected = {
		basefee: SHARED_BASE_FEE.toString(),
		prevrandao: SHARED_BLOCK_ENV.prevRandao,
		coinbase: SHARED_BLOCK_ENV.coinbase,
		number: '1',
		timestamp: SHARED_BLOCK_ENV.timestamp.toString(),
		gaslimit: '30000000',
	};
	await blockEnvNodes.default.node.dispose();
	await blockEnvNodes.revm.node.dispose();

	// ---------- BLOCKHASH is wired to the node's blocks ----------
	for (const ctx of [def, revm]) {
		await ctx.node.request({
			method: 'evm_setCode',
			params: [BLOCKHASH_PROBE_ADDR, BLOCKHASH_PROBE_CODE],
		});
	}
	// The two nodes are separate chains, so their block hashes differ: each is
	// checked against ITS OWN chain rather than against each other.
	for (const [label, ctx] of [
		['default', def],
		['revm', revm],
	] as const) {
		// A block MINED AFTER the engine connected — the context must expose the
		// node's live blocks, not a snapshot taken at construction.
		await ctx.node.mine();
		const latest = Number(
			await ctx.node.request({method: 'eth_blockNumber', params: []}),
		);
		const previous: any = await ctx.node.request({
			method: 'eth_getBlockByNumber',
			params: ['0x' + (latest - 1).toString(16), false],
		});
		out[`blockHashExpected.${label}`] = previous.hash;
		out[`blockHash.${label}`] = String(
			await ctx.node.request({
				method: 'eth_call',
				params: [{to: BLOCKHASH_PROBE_ADDR, data: '0x'}],
			}),
		);
	}

	// ---------- the OTHER delivery shape works too ----------
	const urlNode = await nodeWith(fromUrl);
	await urlNode.node.request({
		method: 'evm_setCode',
		params: [BLOCKHASH_PROBE_ADDR, BLOCKHASH_PROBE_CODE],
	});
	out.runtimeUrlEngineId = urlNode.node.readEngine.id;
	// One block, so `blockhash(number - 1)` names the genesis block rather than
	// underflowing past the start of the chain.
	await urlNode.node.mine();
	const genesis: any = await urlNode.node.request({
		method: 'eth_getBlockByNumber',
		params: ['0x0', false],
	});
	out.runtimeUrlCallExpected = genesis.hash;
	out.runtimeUrlCall = String(
		await urlNode.node.request({
			method: 'eth_call',
			params: [{to: BLOCKHASH_PROBE_ADDR, data: '0x'}],
		}),
	);
	await urlNode.node.dispose();

	// ---------- a mode the engine cannot serve is refused LOUDLY ----------
	try {
		const trieNode = await createNode({
			chainId: CHAIN_ID,
			stateMode: 'trie',
			engine: await createRevmEngine({wasm: bundlerResolvedWasm}),
		});
		out.trieRefusal = 'DID_NOT_THROW';
		await trieNode.dispose();
	} catch (e) {
		out.trieRefusal = String((e as Error)?.message ?? e);
	}

	// ---------- the hardforks this engine ADMITS, and the ones it REFUSES ----------
	// The node runs Cancun and nothing a consumer can pass changes that, so this is
	// the one place the guard is reachable: `connect` is handed a `Common` on each
	// fork directly, exactly as a node whose hardfork had moved would hand it.
	const sharedModule = await WebAssembly.compile(bundlerResolvedWasm);
	const commonOn = (hardfork: string) =>
		new Common({
			chain: {...Mainnet, chainId: CHAIN_ID, name: 'embedded-eth-node'},
			hardfork,
		});
	async function connectOn(hardfork: string): Promise<string> {
		const engine = await createRevmEngine({wasm: sharedModule});
		try {
			await engine.connect!({
				stateManager: new SimpleStateManager(),
				common: commonOn(hardfork),
				getBlockHash: () => undefined,
				stateMode: 'none',
			});
			return 'DID_NOT_THROW';
		} catch (e) {
			return String((e as Error)?.message ?? e);
		}
	}
	const hardforkRefusals: Record<string, string> = {};
	for (const hardfork of Object.keys(REVM_REFUSED_HARDFORKS)) {
		hardforkRefusals[hardfork] = await connectOn(hardfork);
	}
	out.hardforkRefusals = hardforkRefusals;
	out.refusedHardforks = Object.keys(REVM_REFUSED_HARDFORKS);
	// ...and the fork the node actually runs is still admitted, silently and
	// without ceremony: the default path must be demonstrably untouched.
	out.cancunAdmitted = (await connectOn('cancun')) === 'DID_NOT_THROW';

	// ---------- what the node hands the engine, judged BY the engine ----------
	// `eth_estimateGas` is not decoration: viem uses the number as the gas LIMIT of
	// the real transaction. So the estimate for a calldata-heavy, computation-light
	// call is fed back to revm AS a gas limit, on every spec the table admits, and
	// revm's own transaction validation gets to judge it. A rejection here is the
	// user-visible failure ("out of gas" in their face) caught one layer earlier.
	const heavyDataHex = ('0x' + 'ff'.repeat(1000)) as `0x${string}`;
	const heavyData = hexToBytes(heavyDataHex);
	const heavyCall = {
		from: account.address,
		to: CALLDATA_SINK_ADDR,
		data: heavyDataHex,
	};
	const heavyEstimates: Record<string, string> = {};
	for (const [label, ctx] of [
		['default', def],
		['revm', revm],
	] as const) {
		heavyEstimates[label] = String(
			await ctx.node.request({method: 'eth_estimateGas', params: [heavyCall]}),
		);
	}
	out.heavyEstimates = heavyEstimates;
	out.heavyEstimatesMatch = heavyEstimates.default === heavyEstimates.revm;

	// A SECOND revm instance, on its own empty state, because what is under test is
	// revm's TRANSACTION VALIDATION (the EIP-7623 floor, the EIP-7825 cap), which
	// runs before the first opcode and reads only the calldata and the gas limit.
	// The simulation switches and the budget arithmetic are the engine's own (see
	// src/revm.ts): the node's read budget reaches revm as `gasLimit + intrinsic`.
	const judge = await createRevm({
		wasm: sharedModule,
		state: new MemoryStore(),
	});
	function verdict(spec: SpecName, gasLimit: bigint): string {
		const o = judge.call({
			from: hexToBytes(account.address),
			to: hexToBytes(CALLDATA_SINK_ADDR),
			data: heavyData,
			value: 0n,
			gasLimit,
			spec,
			chainId: BigInt(CHAIN_ID),
			block: {
				number: 1n,
				timestamp: SHARED_BLOCK_ENV.timestamp,
				gasLimit: 30_000_000n,
				coinbase: hexToBytes(SHARED_BLOCK_ENV.coinbase),
				baseFeePerGas: SHARED_BASE_FEE,
				prevRandao: hexToBytes(SHARED_BLOCK_ENV.prevRandao),
			},
			disableBaseFee: true,
			disableBlockGasLimit: true,
			disableEip3607: true,
			returnState: false,
		});
		// 'accepted' means the transaction RAN to completion within that limit — not
		// merely that validation let it start, since an out-of-gas halt is exactly
		// the failure an under-estimate produces.
		return o.success ? 'accepted' : (o.error ?? o.status);
	}
	// The node's DEFAULT read budget, as the engine receives it: `eth_call` with no
	// `gas` uses 30M, and the engine adds intrinsic gas on top (revm charges
	// intrinsic out of the transaction limit, `runCall` charges none).
	const defaultReadBudget = 30_000_000n + intrinsicGasForCall(heavyDataHex);
	const estimateVerdicts: Record<string, string> = {};
	const budgetVerdicts: Record<string, string> = {};
	for (const [hardfork, spec] of Object.entries(REVM_SPEC_BY_HARDFORK)) {
		estimateVerdicts[hardfork] = verdict(spec, BigInt(heavyEstimates.revm));
		budgetVerdicts[hardfork] = verdict(spec, defaultReadBudget);
	}
	out.admittedHardforks = Object.keys(REVM_SPEC_BY_HARDFORK);
	out.estimateVerdicts = estimateVerdicts;
	out.budgetVerdicts = budgetVerdicts;

	// And the counter-examples, on the two specs the table refuses, so the refusal
	// is evidence-backed rather than asserted: the SAME estimate and the SAME
	// budget are rejected outright there.
	out.estimateOnPrague = verdict('PRAGUE', BigInt(heavyEstimates.revm));
	out.budgetOnOsaka = verdict('OSAKA', defaultReadBudget);

	// ---------- ...and judged by the PROTOCOL, not just by revm ----------
	// The node and revm agree about intrinsic gas BY CONSTRUCTION: the engine
	// subtracts `intrinsicGas()` from what revm spent and the node adds the same
	// number back, so a term that is wrong at a fork is wrong on both sides and
	// their agreement cannot see it. That is ADR 0008's clause (b), and it is a
	// claim about the WHOLE shared formula rather than about its one fork-gated
	// term: `intrinsicGas()` also hardcodes 21000, 32000 and EIP-2028's 16/4
	// calldata bytes. So every TERM is read three independent ways per admitted
	// fork, only one of which is the node:
	//   - the PROTOCOL, via `@ethereumjs/tx`'s own intrinsic-gas arithmetic at that
	//     `Common` — the very code `@ethereumjs/vm`'s `runTx` charges a mined
	//     transaction ON THIS NODE, and which reads `@ethereumjs/common`'s tables
	//     (`txDataNonZeroGas` and friends, `isActivatedEIP(3860)`) underneath;
	//   - revm itself, MEASURED by delta between two probe transactions;
	//   - the node's shared `intrinsicGas()`, by the SAME deltas, so the formula is
	//     measured rather than read off the source.
	// Evidence and the full numbers, per spec including the ones below the admitted
	// range: docs/spikes/clause-b-covers-only-eip-3860-not-the-rest-of-the-formula/
	// and docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/.

	/** Initcode deploying EMPTY code: `PUSH1 0 / PUSH1 0 / RETURN`, padded to `len`. */
	function initcodeOfLength(len: number): Uint8Array {
		const code = new Uint8Array(len);
		code.set([0x60, 0x00, 0x60, 0x00, 0xf3]);
		return code;
	}

	/** The probe shapes every term below is a delta between. */
	const NO_DATA = new Uint8Array();
	const ONE_NON_ZERO_BYTE = Uint8Array.of(0xff);
	const ONE_ZERO_BYTE = Uint8Array.of(0x00);
	const ONE_INITCODE_WORD = initcodeOfLength(32);
	const TWO_INITCODE_WORDS = initcodeOfLength(33);

	/**
	 * What ONE party charges as intrinsic gas for a transaction of this shape.
	 * Every party below answers the same question, so their answers subtract.
	 */
	type IntrinsicCharge = (data: Uint8Array, isCreate: boolean) => bigint;

	/**
	 * Every term `intrinsicGas()` bakes in, each defined as ARITHMETIC OVER A
	 * PARTY'S CHARGES rather than as a number — which is what lets the same
	 * definition be evaluated against the protocol, against revm and against the
	 * node, and keeps this file from restating the constants it is meant to guard.
	 *
	 * The probe shapes are chosen so that EXECUTION gas is never in the answer: a
	 * CALL goes to a codeless address and a CREATE deploys empty code, so either
	 * both sides of a delta execute the same three opcodes (the initcode row) or
	 * neither executes anything at all.
	 */
	const INTRINSIC_TERMS: {
		name: string;
		of: (charge: IntrinsicCharge) => bigint;
	}[] = [
		{name: 'transaction base', of: (g) => g(NO_DATA, false)},
		{
			name: 'non-zero calldata byte (EIP-2028)',
			of: (g) => g(ONE_NON_ZERO_BYTE, false) - g(NO_DATA, false),
		},
		{
			name: 'zero calldata byte',
			of: (g) => g(ONE_ZERO_BYTE, false) - g(NO_DATA, false),
		},
		{
			name: 'creation base (EIP-2)',
			of: (g) => g(NO_DATA, true) - g(NO_DATA, false),
		},
		{
			// 32 bytes is one initcode word and 33 is two, so the delta is one word
			// PLUS the extra byte's calldata cost — and that byte is a zero one, whose
			// cost is the term measured two rows up. Subtracting the MEASURED zero-byte
			// cost rather than the number 4 keeps this row free of constants too.
			name: 'initcode word (EIP-3860)',
			of: (g) =>
				g(TWO_INITCODE_WORDS, true) -
				g(ONE_INITCODE_WORD, true) -
				(g(ONE_ZERO_BYTE, false) - g(NO_DATA, false)),
		},
	];
	/**
	 * One CREATE on the JUDGE instance, under `spec`, with the engine's own
	 * simulation switches (see src/revm.ts) — the raw measurement both the term
	 * deltas above and the estimate-as-a-gas-limit verdict below are built from.
	 */
	function createOn(spec: SpecName, data: Uint8Array, gasLimit = 1_000_000n) {
		return judge.create({
			from: hexToBytes(account.address),
			data,
			value: 0n,
			gasLimit,
			spec,
			chainId: BigInt(CHAIN_ID),
			block: {
				number: 1n,
				timestamp: SHARED_BLOCK_ENV.timestamp,
				gasLimit: 30_000_000n,
				coinbase: hexToBytes(SHARED_BLOCK_ENV.coinbase),
				baseFeePerGas: SHARED_BASE_FEE,
				prevRandao: hexToBytes(SHARED_BLOCK_ENV.prevRandao),
			},
			disableBaseFee: true,
			disableBlockGasLimit: true,
			disableEip3607: true,
			returnState: false,
			commit: false,
			checkNonce: false,
		});
	}

	/**
	 * One CALL on the JUDGE instance, under `spec`, to a CODELESS address — so
	 * nothing executes and `totalGasSpent` is the intrinsic cost and nothing else.
	 * Same switches as {@link createOn}, for the same reason.
	 */
	function callOn(spec: SpecName, data: Uint8Array, gasLimit = 1_000_000n) {
		return judge.call({
			from: hexToBytes(account.address),
			to: hexToBytes(CALLDATA_SINK_ADDR),
			data,
			value: 0n,
			gasLimit,
			spec,
			chainId: BigInt(CHAIN_ID),
			block: {
				number: 1n,
				timestamp: SHARED_BLOCK_ENV.timestamp,
				gasLimit: 30_000_000n,
				coinbase: hexToBytes(SHARED_BLOCK_ENV.coinbase),
				baseFeePerGas: SHARED_BASE_FEE,
				prevRandao: hexToBytes(SHARED_BLOCK_ENV.prevRandao),
			},
			disableBaseFee: true,
			disableBlockGasLimit: true,
			disableEip3607: true,
			returnState: false,
			commit: false,
			checkNonce: false,
		});
	}

	/**
	 * REVM's charge, measured: `totalGasSpent` for the probe shape under `spec`. A
	 * FAILED outcome is thrown rather than reported, because a rejected transaction
	 * spends a number that is not a charge, and a term built from one would be
	 * arithmetic on noise.
	 */
	function revmCharge(spec: SpecName): IntrinsicCharge {
		return (data, isCreate) => {
			const o = isCreate ? createOn(spec, data) : callOn(spec, data);
			if (!o.success) {
				throw new Error(
					`revm rejected the ${isCreate ? 'CREATE' : 'CALL'} probe of ` +
						`${data.length} byte(s) on ${spec}: ${o.error ?? o.status}`,
				);
			}
			return o.totalGasSpent;
		};
	}
	/**
	 * The PROTOCOL's charge: `@ethereumjs/tx`'s own intrinsic-gas arithmetic at
	 * `common`, which is what `@ethereumjs/vm`'s `runTx` charges the same
	 * transaction ON THIS NODE — a witness the node already trusts on its write
	 * path, and one that reads `@ethereumjs/common`'s tables rather than any
	 * constant re-typed here.
	 */
	function protocolCharge(common: Common): IntrinsicCharge {
		return (data, isCreate) =>
			createLegacyTx(
				{
					gasLimit: 1_000_000n,
					data,
					to: isCreate ? undefined : CALLDATA_SINK_ADDR,
				},
				{common},
			).getIntrinsicGas();
	}
	/**
	 * The NODE's charge: the real shared `intrinsicGas()`, never a mirror of it, so
	 * a term that is missing, mis-gated or gated at the wrong fork shows up here as
	 * a number that disagrees with the other two parties.
	 */
	function nodeCharge(common: Common): IntrinsicCharge {
		return (data, isCreate) => intrinsicGas(data, isCreate, common);
	}

	type TermReading = {revm: string; protocol: string; node: string};
	/** Every term of the formula, read three ways, at one fork. */
	function readTermsAt(
		hardfork: string,
		spec: SpecName,
	): Record<string, TermReading> {
		const common = commonOn(hardfork);
		const parties = {
			revm: revmCharge(spec),
			protocol: protocolCharge(common),
			node: nodeCharge(common),
		};
		const readings: Record<string, TermReading> = {};
		for (const term of INTRINSIC_TERMS) {
			readings[term.name] = {
				revm: term.of(parties.revm).toString(),
				protocol: term.of(parties.protocol).toString(),
				node: term.of(parties.node).toString(),
			};
		}
		return readings;
	}
	/** The terms where the three parties do NOT agree, said in full. */
	function disagreementsIn(
		hardfork: string,
		readings: Record<string, TermReading>,
	): string[] {
		return Object.entries(readings)
			.filter(([, r]) => r.revm !== r.protocol || r.revm !== r.node)
			.map(
				([name, r]) =>
					`${hardfork}/${name}: revm ${r.revm}, protocol ${r.protocol}, ` +
					`node ${r.node}`,
			);
	}

	const intrinsicTermReadings: Record<string, Record<string, TermReading>> = {};
	const intrinsicTermDisagreements: string[] = [];
	const eip3860Active: Record<string, boolean> = {};
	for (const [hardfork, spec] of Object.entries(REVM_SPEC_BY_HARDFORK)) {
		const readings = readTermsAt(hardfork, spec);
		intrinsicTermReadings[hardfork] = readings;
		intrinsicTermDisagreements.push(...disagreementsIn(hardfork, readings));
		eip3860Active[hardfork] = commonOn(hardfork).isActivatedEIP(3860);
	}
	out.intrinsicTermNames = INTRINSIC_TERMS.map((t) => t.name);
	out.intrinsicTermReadings = intrinsicTermReadings;
	out.intrinsicTermDisagreements = intrinsicTermDisagreements;
	out.eip3860Active = eip3860Active;
	// The admitted set must SPAN the EIP-3860 boundary for that term's readings to
	// be load-bearing: if every admitted fork charged the word cost, an ungated
	// formula would satisfy all three of them. These are the admitted forks that
	// PREDATE EIP-3860, i.e. the ones only the fork gate makes correct.
	out.admittedPreEip3860 = Object.keys(REVM_SPEC_BY_HARDFORK).filter(
		(hardfork) => !eip3860Active[hardfork],
	);

	// ---------- THE BOUNDARY NO ADMITTED FORK SPANS: EIP-2028 (Istanbul) --------
	// The other terms get the span for free (`transaction base` and `creation base`
	// have not moved since Homestead), but EIP-2028's 16-gas non-zero calldata byte
	// has a boundary the admitted set sits entirely ABOVE: berlin..cancun are all at
	// or above Istanbul, so the per-fork readings would pass just as happily with a
	// formula that hardcodes 16 — which is exactly what `intrinsicGas()` does. So
	// the boundary itself is measured, from BOTH sides, on two specs the engine does
	// not admit: at `istanbul` the three parties agree, and one fork below it they
	// do not, with the node UNDER-charging by 52 gas per non-zero byte. That is the
	// direction that reaches a user: a client uses an estimate as the transaction's
	// gas limit, so an under-estimate is an out-of-gas revert in their face.
	//
	// This is what a future re-admitter owes, made concrete rather than promised:
	// moving a pre-Istanbul fork into `REVM_SPEC_BY_HARDFORK` puts it into the loop
	// above and turns the disagreement measured here into a failing build.
	const LOWER_BOUND_PROBES: Readonly<Record<string, SpecName>> = {
		petersburg: 'PETERSBURG',
		istanbul: 'ISTANBUL',
	};
	const lowerBoundReadings: Record<string, Record<string, TermReading>> = {};
	const lowerBoundDisagreements: Record<string, string[]> = {};
	const belowAdmittedRefusals: Record<string, string> = {};
	for (const [hardfork, spec] of Object.entries(LOWER_BOUND_PROBES)) {
		const readings = readTermsAt(hardfork, spec);
		lowerBoundReadings[hardfork] = readings;
		lowerBoundDisagreements[hardfork] = disagreementsIn(hardfork, readings);
		// ...and neither fork is in EITHER table, so the engine refuses both by the
		// unknown-fork guard. A re-admitter has to pass this refusal on purpose.
		belowAdmittedRefusals[hardfork] = await connectOn(hardfork);
	}
	out.lowerBoundReadings = lowerBoundReadings;
	out.lowerBoundDisagreements = lowerBoundDisagreements;
	out.belowAdmittedRefusals = belowAdmittedRefusals;
	// ---------- THE CREATE ESTIMATE, ENGINE AGAINST ENGINE, AT EVERY FORK -------
	// The one shape the EIP-3860 term reaches, at the one place the fork gate is
	// user-visible. `eth_estimateGas` is `executionGasUsed + intrinsicGas(...)`, and
	// the two engines arrive at it from OPPOSITE directions: `runCall` charges no
	// intrinsic gas so the default engine's estimate MOVES with the node's formula,
	// while the revm engine SUBTRACTS the same formula from revm's `totalGasSpent`
	// and the node adds it straight back, so its estimate is revm's number whatever
	// the node computes. An EIP-3860 term charged at a fork revm does not charge it
	// at therefore splits the two engines by exactly `2 * ceil(len/32)` gas — which
	// is the divergence this section exists to catch, and nothing else looks at it.
	//
	// It runs BELOW `createNode()` on purpose: the node pins Cancun and exposes no
	// hardfork, so the only way to reach another fork is to build the two read
	// engines directly and hand each the SAME `Common`, exactly as a node whose
	// hardfork had moved would. Both estimates are then assembled with the node's
	// own line of arithmetic (`r.executionGasUsed + intrinsicGas(data, isCreate,
	// common)`, from `node.ts`'s `eth_estimateGas` case).
	const CREATE_INITCODE = initcodeOfLength(64); // 2 initcode words

	/** `eth_estimateGas` for a CREATE of {@link CREATE_INITCODE}, per engine. */
	async function createEstimatesOn(
		hardfork: string,
	): Promise<{default: string; revm: string}> {
		const common = commonOn(hardfork);
		// A block this fork can actually carry: `createBlock` fills the fork-dependent
		// header fields (base fee from London, blob gas from Cancun) from `common`,
		// so no field has to be guessed per fork here.
		const block = createBlock(
			{
				header: {
					number: 1n,
					gasLimit: 30_000_000n,
					timestamp: SHARED_BLOCK_ENV.timestamp,
				},
			},
			{common},
		);
		const request = {
			from: createAddressFromString(account.address),
			to: undefined,
			data: CREATE_INITCODE,
			value: 0n,
			gasLimit: 30_000_000n,
			block,
		};
		// Each engine on its OWN empty state, because a CREATE derives its address
		// from the sender's nonce and neither engine may see the other's deploy.
		const defaultState = new SimpleStateManager();
		const defaultEngine = createEthereumjsReadEngine({
			evm: await createEVM({common, stateManager: defaultState}),
			stateManager: defaultState,
		});
		const revmEngine = await createRevmEngine({wasm: sharedModule});
		await revmEngine.connect!({
			stateManager: new SimpleStateManager(),
			common,
			getBlockHash: () => undefined,
			stateMode: 'none',
		});
		const estimates: Record<string, string> = {};
		for (const [label, engine] of [
			['default', defaultEngine],
			['revm', revmEngine],
		] as const) {
			const r = await engine.call(request);
			if (r.error !== undefined)
				throw new Error(`${hardfork}/${label}: ${r.error}`);
			// Verbatim `node.ts`'s `eth_estimateGas` case.
			estimates[label] = (
				r.executionGasUsed + intrinsicGas(CREATE_INITCODE, true, common)
			).toString();
		}
		return {default: estimates.default, revm: estimates.revm};
	}

	const createEstimates: Record<string, {default: string; revm: string}> = {};
	// ...and what the PROTOCOL charges for the same CREATE, from the witness that is
	// neither engine: `@ethereumjs/tx`'s own intrinsic gas, which is the code
	// `@ethereumjs/vm`'s `runTx` charges a real transaction ON THIS NODE. If the
	// node's shared formula and this disagree at a fork, the node disagrees with
	// ITSELF: a deployment estimated on the read path and then mined would pay a
	// different intrinsic cost.
	const createIntrinsic: Record<string, {node: string; protocol: string}> = {};
	// ...and the estimate is fed BACK to revm as the gas limit of the same CREATE,
	// per admitted spec, exactly as the calldata-heavy CALL above is. viem uses an
	// estimate as the transaction's gas limit, and a deployment is the shape with
	// the least slack — an estimate one gas short of what the deployment costs is
	// an out-of-gas revert in the user's face.
	const createVerdicts: Record<string, string> = {};
	for (const [hardfork, spec] of Object.entries(REVM_SPEC_BY_HARDFORK)) {
		createEstimates[hardfork] = await createEstimatesOn(hardfork);
		const common = commonOn(hardfork);
		createIntrinsic[hardfork] = {
			node: intrinsicGas(CREATE_INITCODE, true, common).toString(),
			protocol: createLegacyTx(
				{gasLimit: 1_000_000n, data: CREATE_INITCODE},
				{common},
			)
				.getIntrinsicGas()
				.toString(),
		};
		const o = createOn(
			spec,
			CREATE_INITCODE,
			BigInt(createEstimates[hardfork].revm),
		);
		createVerdicts[hardfork] = o.success ? 'accepted' : (o.error ?? o.status);
	}
	out.createVerdicts = createVerdicts;
	out.createEstimates = createEstimates;
	out.createIntrinsic = createIntrinsic;
	out.createEstimatesMatch = Object.values(createEstimates).every(
		(e) => e.default === e.revm,
	);
	out.createIntrinsicMatchesProtocol = Object.values(createIntrinsic).every(
		(i) => i.node === i.protocol,
	);

	// ---------- one engine, one node ----------
	// `fromAsset` is already bound to the `revm` node. Re-using it would rebind
	// its store to the second node's state, and the FIRST node would then answer
	// every read from the second node's state — plausible values, no error.
	try {
		const secondNode = await createNode({chainId: CHAIN_ID, engine: fromAsset});
		out.reuseRefusal = 'DID_NOT_THROW';
		await secondNode.dispose();
	} catch (e) {
		out.reuseRefusal = String((e as Error)?.message ?? e);
	}
	// ...and the first node still reads ITS OWN state afterwards.
	out.numberAfterReuseAttempt = String(
		await revm.pub.readContract({
			address: deployed.revm,
			abi: counterAbi,
			functionName: 'number',
		}),
	);

	await def.node.dispose();
	await revm.node.dispose();
	return out;
}
