/**
 * estimate-gas.ts — `eth_estimateGas` ANSWERS WITH A GAS LIMIT, not with what a
 * transaction consumes, and the difference is a transaction that mines versus one
 * that reverts.
 *
 * ## The failure this battery exists to catch
 *
 * The method used to run the request once and report `executionGasUsed` +
 * intrinsic gas: exact, honest, and the wrong question. Under EIP-150's 63/64
 * rule a `CALL` or `CREATE` is forwarded at most 63/64 of the gas remaining at
 * that point, so a transaction whose limit is exactly its own consumption starves
 * its sub-call by the 1/64 the outer frame keeps. Consumption is a LOWER BOUND on
 * a workable limit, never the limit.
 *
 * THE SHAPE IS NOT HYPOTHETICAL, and this battery uses the real one: a deployment
 * through the standard CREATE2 factory (`0x4e59b448...`, deployed here by its own
 * keyless presigned transaction, exactly as it is on every chain). Its body is one
 * `CREATE2`, so a limit equal to consumption leaves the inner frame short:
 *
 *     status 0x0, no contract created, and a caller that goes on to point a proxy
 *     at the address that was never deployed gets `0x` back from every call
 *     instead of a failure — the bug landing nowhere near its cause.
 *
 * ## What each case pins, and why all four are needed
 *
 *   * `throughFactory` — THE BUG. Estimate a deployment through the factory, sign
 *     at exactly that number, mine it: `status 0x1` and code at the CREATE2
 *     address. Before the search this case is `status 0x0` with no code. The same
 *     case at `estimate - 1` must FAIL, which is what says the answer is the
 *     MINIMUM limit rather than a padded one — a "fudge factor" implementation
 *     passes the first half of this and fails the second.
 *   * `transfer` / `deploy` — THE COMMON CASES ARE NOT INFLATED. A bare value
 *     transfer is 21000 to the gas, and a deployment (no inner call, so
 *     consumption IS a workable limit) is still exactly what it consumes when
 *     mined. This is the assertion a padded estimate fails.
 *   * `unestimatable` / `capTooLow` / `overAllowance` — A REQUEST THAT CANNOT
 *     SUCCEED AT ANY LIMIT PRODUCES AN ERROR, never a plausible-looking number,
 *     and the error says WHICH problem it is. A revert is `execution reverted`
 *     (code 3) carrying the callee's bytes and the decoded reason; a request that
 *     burns the whole allowance without succeeding is `gas required exceeds
 *     allowance` (-32000, geth's vocabulary and the node's own), because nothing
 *     reverted and there is no revert data to hunt for. Both allowance cases are
 *     covered: one that cannot pay the intrinsic floor, and one that runs out
 *     inside the frame.
 *   * `probeCounts` / `searchCost` — THE COST. Every probe is a full execution of
 *     the request in a browser tab, so it is pinned at the seam, both ways.
 *     Against a stub engine that always succeeds, an estimate costs exactly TWO
 *     engine calls (the upper bound, and the one that confirms consumption is a
 *     workable limit). Against a stub that reproduces a 63/64 shortfall with
 *     ARITHMETIC — succeeding only above a known threshold — the full search costs
 *     a pinned number of calls and lands on that threshold EXACTLY. That second
 *     one is the number a future change could silently double, and it is the only
 *     way to state it deterministically: the same search against a real EVM costs
 *     whatever that contract's window happens to be wide.
 *
 * The node's own advice stays consistent throughout: every case that produces a
 * number signs a transaction AT that number and submits it, so the estimate goes
 * through `refuseIfBelowIntrinsicGas` and `refuseIfOverBlockGasLimit`. The node
 * must never refuse a limit it has just recommended.
 */
import {createNode} from '../../src/index.js';
import type {Engine, ReadCallRequest, ReadCallResult} from '../../src/index.js';
import {
	concatHex,
	encodeDeployData,
	encodeFunctionData,
	getCreate2Address,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {counterAbi, counterBytecode} from './counter.js';
import {probeAbi, probeBytecode} from './probe.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);

/**
 * THE ARACHNID DETERMINISTIC-DEPLOYMENT PROXY, verbatim: a keyless presigned
 * transaction (pre-EIP-155, signed with `r = s = 0x2222...`) that deploys the
 * factory at the same address on every chain. It is used here rather than a
 * hand-written CREATE2 stub precisely because it is what consumers actually
 * deploy through — the reported failure was a real deployment pipeline, not a
 * contrived contract.
 *
 * Its body: calldata is a 32-byte salt followed by init code, it `CREATE2`s with
 * the call's value, and returns the 20-byte address.
 */
const FACTORY_DEPLOYER = '0x3fab184622dc19b6109349b94811493bf2a45362';
const FACTORY_DEPLOY_TX =
	'0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222';
const FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

/**
 * The stub 63/64 shortfall, in gas made available to EXECUTION: what the request
 * CONSUMES when it succeeds, and the frame budget below which it does not. The
 * gap (3,099) is the one the real CREATE2 factory case measures, so the pinned
 * probe count is the cost of a realistic single-level shortfall rather than of an
 * invented one.
 */
const CONSUMED_BUDGET = 246_727n;
const SHORTFALL_BUDGET = 249_826n;

const GENESIS_BALANCE = 10n ** 20n;
const MAX_FEE = 2_000_000_000n;
const MAX_PRIORITY_FEE = 1_000_000_000n;

export async function runEstimateGasChecks(): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};

	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {
			[account.address]: GENESIS_BALANCE,
			[FACTORY_DEPLOYER]: 10n ** 18n,
		},
	});

	let nonce = 0;
	const estimate = async (request: Record<string, unknown>) =>
		BigInt(
			(await node.request({
				method: 'eth_estimateGas',
				params: [{from: account.address, ...request}],
			})) as string,
		);

	/** Sign a 1559 transaction at an EXACT gas limit and mine it. */
	const mineAt = async (
		gas: bigint,
		tx: {to?: `0x${string}`; data?: `0x${string}`; value?: bigint},
	) => {
		const raw = await account.signTransaction({
			chainId: CHAIN_ID,
			type: 'eip1559',
			nonce: nonce++,
			gas,
			maxFeePerGas: MAX_FEE,
			maxPriorityFeePerGas: MAX_PRIORITY_FEE,
			...tx,
		} as any);
		try {
			const rcpt = (await node.request({
				method: 'eth_sendRawTransactionSync',
				params: [raw],
			})) as any;
			return {
				outcome: `mined ${rcpt.status}`,
				gasUsed: String(BigInt(rcpt.gasUsed)),
				contractAddress: rcpt.contractAddress ?? null,
			};
		} catch (err) {
			// A REFUSAL IS NOT A RECEIPT, and it must never happen to a limit this
			// node has just recommended: `refuseIfBelowIntrinsicGas` sends callers to
			// `eth_estimateGas` for the number a transaction needs.
			nonce--;
			return {
				outcome: `refused: ${String((err as Error)?.message ?? err)}`,
				gasUsed: null,
				contractAddress: null,
			};
		}
	};

	// ---------- 0) the factory, deployed the way every chain deploys it --------
	const factoryReceipt = (await node.request({
		method: 'eth_sendRawTransactionSync',
		params: [FACTORY_DEPLOY_TX],
	})) as any;
	const factoryCode = (await node.request({
		method: 'eth_getCode',
		params: [FACTORY, 'latest'],
	})) as string;
	out.factoryDeploy = {
		status: factoryReceipt.status,
		address: String(factoryReceipt.contractAddress).toLowerCase(),
		codeBytes: (factoryCode.length - 2) / 2,
	};

	// ---------- 1) a bare value transfer is 21000, to the gas ------------------
	const transferEstimate = await estimate({
		to: FACTORY_DEPLOYER,
		value: '0x1',
	});
	out.transfer = {
		estimate: String(transferEstimate),
		...(await mineAt(transferEstimate, {
			to: FACTORY_DEPLOYER as `0x${string}`,
			value: 1n,
		})),
	};

	// ---------- 2) a plain deployment: no inner create, so the estimate is still
	// exactly what it consumes. This is the case a padded estimate breaks.
	const counterInitcode = encodeDeployData({
		abi: counterAbi,
		bytecode: counterBytecode,
	});
	const deployEstimate = await estimate({data: counterInitcode});
	out.deploy = {
		estimate: String(deployEstimate),
		...(await mineAt(deployEstimate, {data: counterInitcode})),
	};

	// ---------- 3) THE BUG: a deployment THROUGH the CREATE2 factory -----------
	const create2 = async (salt: `0x${string}`) => {
		const data = concatHex([salt, counterInitcode]);
		const est = await estimate({to: FACTORY, data});
		return {salt, data, est};
	};

	// 3a) at the estimate: it must MINE, and the contract must exist.
	{
		const {salt, data, est} = await create2(
			('0x' + '11'.repeat(32)) as `0x${string}`,
		);
		const mined = await mineAt(est, {to: FACTORY as `0x${string}`, data});
		const address = getCreate2Address({
			from: FACTORY as `0x${string}`,
			salt,
			bytecode: counterInitcode,
		});
		const code = (await node.request({
			method: 'eth_getCode',
			params: [address, 'latest'],
		})) as string;
		out.throughFactory = {
			estimate: String(est),
			...mined,
			createdCodeBytes: (code.length - 2) / 2,
			// What the transaction actually CONSUMED, and therefore what the old
			// run-and-measure implementation returned. The estimate is above it by
			// the 1/64 the outer frame keeps, which is the whole fix in one number.
			gapOverConsumption:
				mined.gasUsed === null ? null : String(est - BigInt(mined.gasUsed)),
		};
	}

	// 3b) one gas LESS must fail: the answer is the MINIMUM workable limit, not a
	// padded one. A fresh salt, so this is the same work on an untouched address.
	{
		const {data, est} = await create2(
			('0x' + '22'.repeat(32)) as `0x${string}`,
		);
		out.throughFactoryOneGasLess = {
			estimate: String(est),
			...(await mineAt(est - 1n, {to: FACTORY as `0x${string}`, data})),
		};
	}

	// ---------- 4) what cannot succeed at ANY limit produces an ERROR ----------
	const probeDeploy = await mineAt(1_000_000n, {
		data: encodeDeployData({abi: probeAbi, bytecode: probeBytecode}),
	});
	const probeAddr = probeDeploy.contractAddress as `0x${string}`;
	out.unestimatable = await failureOf(() =>
		estimate({
			to: probeAddr,
			data: encodeFunctionData({abi: probeAbi, functionName: 'boom'}),
		}),
	);

	// ...and the other edge: an allowance too small to pay for the transaction's
	// own bytes. Nothing executes, so this is NOT an `execution reverted` and
	// carries no return data to decode.
	out.capTooLow = await failureOf(() =>
		estimate({data: counterInitcode, gas: '0x7530'}),
	);

	// ---------- 5) ...and a request that runs out of gas INSIDE the frame ------
	// A node whose block gas limit cannot fund the deployment: the allowance is
	// enough to start the transaction (it clears the intrinsic floor) and not
	// enough to finish it. Nothing reverts, so this must NOT come back as
	// `execution reverted` with empty data — the caller's problem is the allowance,
	// and the message has to name the knob that raises it.
	{
		const small = await createNode({
			chainId: CHAIN_ID,
			miningConfig: {type: 'auto'},
			blockGasLimit: 100_000n,
			initialBalances: {[account.address]: GENESIS_BALANCE},
		});
		out.overAllowance = await failureOf(async () =>
			BigInt(
				(await small.request({
					method: 'eth_estimateGas',
					params: [{from: account.address, data: counterInitcode}],
				})) as string,
			),
		);
	}

	// ---------- 6) the cost of the common case, counted at the seam ------------
	// A stub engine that always succeeds with a fixed EXECUTION gas: the estimate
	// must cost TWO calls (the upper bound, then the confirmation that consumption
	// is workable) and must equal intrinsic + that gas exactly.
	let calls = 0;
	const stub: Engine = {
		id: 'estimate-probe-counter',
		async call(_request: ReadCallRequest): Promise<ReadCallResult> {
			calls++;
			return {returnValue: new Uint8Array(), executionGasUsed: 12_345n};
		},
		async transact() {
			throw new Error('not used');
		},
	};
	const stubNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		engine: stub,
	});
	const stubEstimate = (await stubNode.request({
		method: 'eth_estimateGas',
		params: [{from: account.address, to: FACTORY}],
	})) as string;
	out.probeCounts = {
		estimate: String(BigInt(stubEstimate)),
		estimateExpected: String(21_000n + 12_345n),
		callsForOneEstimate: calls,
	};

	// ---------- 7) ...and the cost of the case that does search ----------------
	// THE 63/64 SHORTFALL, REPRODUCED WITH ARITHMETIC. This engine succeeds only
	// when the frame is given at least {@link SHORTFALL_BUDGET}, and reports the
	// same EXECUTION gas a real one would: what it consumed. So the node measures
	// consumption 21000 + CONSUMED_BUDGET, finds that limit does NOT work, and has
	// to search — with a known right answer (21000 + SHORTFALL_BUDGET) and a
	// deterministic number of probes. A real EVM cannot pin either: its window is
	// whatever the contract's arithmetic makes it.
	let searchCalls = 0;
	const shortfall: Engine = {
		id: 'estimate-63-64-shortfall',
		async call(request: ReadCallRequest): Promise<ReadCallResult> {
			searchCalls++;
			const enough = request.gasLimit >= SHORTFALL_BUDGET;
			return {
				returnValue: new Uint8Array(),
				// A frame that halts for want of gas spends everything it was given,
				// which is what both real engines report and what the node reads to
				// tell an out-of-gas apart from a revert.
				executionGasUsed: enough ? CONSUMED_BUDGET : request.gasLimit,
				error: enough ? undefined : 'out of gas',
			};
		},
		async transact() {
			throw new Error('not used');
		},
	};
	const shortfallNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		engine: shortfall,
	});
	const searched = (await shortfallNode.request({
		method: 'eth_estimateGas',
		params: [{from: account.address, to: FACTORY}],
	})) as string;
	out.searchCost = {
		answer: String(BigInt(searched)),
		answerExpected: String(21_000n + SHORTFALL_BUDGET),
		consumption: String(21_000n + CONSUMED_BUDGET),
		callsForOneEstimate: searchCalls,
	};

	return out;
}

/**
 * WHAT A FAILED ESTIMATE SAID, or the sentence that says it did not fail at all.
 *
 * A returned NUMBER is reported as its own outcome rather than as an absent
 * error, because the whole point of these two cases is that a plausible-looking
 * number is the wrong answer: `succeeded: 0x...` can never equal an expected
 * failure shape.
 */
async function failureOf(
	call: () => Promise<bigint>,
): Promise<Record<string, unknown>> {
	try {
		const value = await call();
		return {outcome: `succeeded: ${value}`};
	} catch (err) {
		const e = err as {code?: unknown; data?: unknown; message?: string};
		return {
			outcome: 'threw',
			code: e.code ?? null,
			data: e.data ?? null,
			message: String(e.message ?? err),
		};
	}
}
