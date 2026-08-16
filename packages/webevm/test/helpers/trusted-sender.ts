/**
 * trusted-sender.ts — the gate for `senderMode:'trusted'`.
 *
 * `'trusted'` skips ecrecover and pins the sender to a caller-supplied address.
 * That is a ~6.2x speedup on a small tx on the default engine — ~2.8x with a revm
 * engine installed, which recovers with its own secp256k1 (measured 2026-08-11,
 * `docs/spikes/sender-recovery-uses-the-engines-ecrecover/measurements.md`; the
 * ~13x this file used to quote was measured on `runTx` before ADR 0009's storage
 * re-layer and had drifted by half) — and it removes the ONLY thing binding a tx
 * to its signer. So it is worth exactly as much as the proof that it changes
 * NOTHING ELSE. This file is that proof:
 *
 *   1. DIFFERENTIAL: the same signed raw txs, run through a `'recover'` node
 *      (`eth_sendRawTransactionSync`) and a `'trusted'` node
 *      (`evm_sendRawTransactionSyncAs`), must produce receipts that are equal
 *      FIELD BY FIELD — gas, status, logs, effectiveGasPrice, contractAddress,
 *      tx hash — and identical post-state (balance/nonce/code/storage).
 *      Gas equality is the one that matters most: if the two paths disagreed on
 *      gas, an op near the limit would OOG on one and not the other, which for a
 *      replaying client is a state fork.
 *   2. SAFETY: in the DEFAULT `'recover'` mode the `evm_*As` methods must NOT
 *      exist. They throw -32601 rather than silently trusting caller input.
 *   3. HONESTY, AND THE ONE ASSERTION AN ENGINE CANNOT FAKE: `'trusted'` really
 *      does execute as the CLAIMED sender. We send a tx signed by A while claiming
 *      to be B and assert, to the wei, that B was charged, B's nonce advanced, A
 *      was untouched, the receipt names B, and the call's state change happened.
 *      This is the documented footgun — but it is also the ONLY case that catches
 *      an engine which recovers its own sender instead of using the seam's
 *      `TransactionRequest.sender`. Such an engine does not throw: it charges A,
 *      advances A's nonce, and returns a receipt that looks entirely plausible.
 *      Every other assertion in this file passes for it, because for a
 *      genuinely-signed tx the claimed and recoverable senders agree.
 *
 * ENGINE-PARAMETERISED, exactly like the conformance battery (see
 * `runConformanceOnEngine` in ./conformance.ts): {@link runTrustedSenderChecks}
 * takes an optional engine factory and builds BOTH its nodes with it, so the whole
 * file above runs unchanged on `webevm/revm`
 * (./revm-trusted-sender.ts) instead of being duplicated for it. One engine
 * INSTANCE per node, from a factory, because an engine binds to exactly one node.
 *
 * It is deliberately NOT a perf test — the speedup is measured in the benchmarks
 * package. This only asserts equivalence.
 */
import {createNode, RpcError, type SlimNode} from '../../src/index.js';
import type {EngineFactory} from './conformance.js';
import {encodeFunctionData, encodeDeployData} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {counterAbi, counterBytecode} from './counter.js';
import {probeAbi, probeBytecode} from './probe.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const GENESIS_BALANCE = 10n ** 24n;
const account = privateKeyToAccount(PK);

/** A second funded account: the value transfer's recipient, and the address the
 *  claimed-sender check CLAIMS to be. Key-less on purpose — nothing can sign for it,
 *  which is the point of claiming it. */
const OTHER = '0x00000000000000000000000000000000000000cc';

/**
 * THE ACCOUNT THAT REALLY SIGNS the claimed-sender transaction, while `OTHER` is
 * claimed. Funded, and it sends NOTHING else in this file, so at that point in the
 * suite it holds the genesis balance and nonce 0 — exactly like `OTHER`.
 *
 * THAT SYMMETRY IS THE WHOLE DESIGN. An engine that recovered its own sender would
 * then execute the transaction perfectly happily as THIS account: the nonce is
 * valid for it, the balance covers it, nothing throws, and the node's receipt still
 * names the claimed sender. The divergence is visible ONLY in the post-state (whose
 * balance moved, whose nonce advanced), which is what the checks below read. Had the
 * signer been `account` — seven transactions in, nonce 7 — a re-recovering engine
 * would have been caught by a nonce error instead, i.e. by luck, and the silent case
 * would have stayed uncovered.
 */
const FABRICATING_SIGNER = privateKeyToAccount(
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

type Rcpt = Record<string, any>;

/** Receipt fields that MUST be identical across the two sender modes. */
const RECEIPT_FIELDS = [
	'transactionHash',
	'transactionIndex',
	'blockNumber',
	'from',
	'to',
	'contractAddress',
	'cumulativeGasUsed',
	'gasUsed',
	'effectiveGasPrice',
	'status',
	'type',
	'logsBloom',
] as const;

function cmpReceipts(label: string, a: Rcpt, b: Rcpt, out: string[]) {
	for (const f of RECEIPT_FIELDS) {
		if (String(a?.[f]) !== String(b?.[f])) {
			out.push(`${label}: receipt.${f} ${String(a?.[f])} != ${String(b?.[f])}`);
		}
	}
	const la = (a?.logs ?? []) as Rcpt[];
	const lb = (b?.logs ?? []) as Rcpt[];
	if (la.length !== lb.length) {
		out.push(`${label}: log count ${la.length} != ${lb.length}`);
		return;
	}
	for (let i = 0; i < la.length; i++) {
		for (const f of ['address', 'data', 'logIndex', 'transactionHash']) {
			if (String(la[i][f]) !== String(lb[i][f])) {
				out.push(
					`${label}: logs[${i}].${f} ${String(la[i][f])} != ${String(lb[i][f])}`,
				);
			}
		}
		if (JSON.stringify(la[i].topics) !== JSON.stringify(lb[i].topics)) {
			out.push(`${label}: logs[${i}].topics differ`);
		}
	}
}

async function readState(node: SlimNode, addr: string) {
	return {
		balance: await node.request({method: 'eth_getBalance', params: [addr]}),
		nonce: await node.request({
			method: 'eth_getTransactionCount',
			params: [addr],
		}),
		code: await node.request({method: 'eth_getCode', params: [addr]}),
	};
}

async function balanceOf(node: SlimNode, addr: string): Promise<bigint> {
	return BigInt(
		String(await node.request({method: 'eth_getBalance', params: [addr]})),
	);
}
async function nonceOf(node: SlimNode, addr: string): Promise<bigint> {
	return BigInt(
		String(
			await node.request({method: 'eth_getTransactionCount', params: [addr]}),
		),
	);
}

export async function runTrustedSenderChecks(
	opts: {makeEngine?: EngineFactory} = {},
) {
	const mismatches: string[] = [];
	const out: Record<string, unknown> = {};

	// ONE ENGINE INSTANCE PER NODE: an engine binds to a single node (the revm
	// engine refuses a second `createNode()`), so the factory is called per node
	// rather than an engine being shared — same rule as ./conformance.ts.
	const mk = async (senderMode: 'recover' | 'trusted') =>
		createNode({
			chainId: CHAIN_ID,
			senderMode,
			miningConfig: {type: 'auto'},
			initialBalances: {
				[account.address]: GENESIS_BALANCE,
				[OTHER]: GENESIS_BALANCE,
				[FABRICATING_SIGNER.address]: GENESIS_BALANCE,
			},
			engine: await opts.makeEngine?.(),
		});

	const recoverNode = await mk('recover');
	const trustedNode = await mk('trusted');

	out.recoverNodeSenderMode = recoverNode.senderMode;
	out.trustedNodeSenderMode = trustedNode.senderMode;
	// WHICH EVM ANSWERED, as the nodes themselves report it — so a run that was
	// meant to exercise an injected engine cannot silently have used the default one.
	out.recoverNodeEngineId = recoverNode.engine.id;
	out.trustedNodeEngineId = trustedNode.engine.id;

	let nonce = 0;
	const sign1559 = (o: Record<string, unknown>) =>
		account.signTransaction({
			chainId: CHAIN_ID,
			nonce: nonce,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			type: 'eip1559',
			...o,
		} as any);
	const signLegacy = (o: Record<string, unknown>) =>
		account.signTransaction({
			chainId: CHAIN_ID,
			nonce: nonce,
			gasPrice: 2_000_000_000n,
			type: 'legacy',
			...o,
		} as any);

	/**
	 * Send the SAME raw tx to both nodes and diff the receipts. The trusted node
	 * gets the sender handed to it; the recover node derives it. Both nodes are
	 * driven in lockstep so their nonces/blocks stay aligned.
	 */
	async function bothWays(label: string, raw: string): Promise<Rcpt> {
		const rRecover = (await recoverNode.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		})) as Rcpt;
		const rTrusted = (await trustedNode.request({
			method: 'evm_sendRawTransactionSyncAs',
			params: [raw, account.address],
		})) as Rcpt;
		cmpReceipts(label, rRecover, rTrusted, mismatches);
		// THE 'recover' HALF, stated absolutely rather than only differentially: an
		// ordinary tx executes as the RECOVERED sender, whatever engine ran it. The
		// field-by-field diff above cannot see this on its own — two nodes agreeing on
		// the wrong `from` would still agree.
		if (
			String(rRecover?.from).toLowerCase() !== account.address.toLowerCase()
		) {
			mismatches.push(
				`${label}: recover-mode receipt.from ${String(rRecover?.from)} is not the signer ${account.address}`,
			);
		}
		nonce++;
		return rRecover;
	}

	// --- 1) DIFFERENTIAL BATTERY ---------------------------------------------

	// deploy (contract create + code deposit)
	const deployRcpt = await bothWays(
		'1559-deploy(Counter)',
		await sign1559({
			data: encodeDeployData({abi: counterAbi, bytecode: counterBytecode}),
			gas: 1_000_000n,
		}),
	);
	const counter = String(deployRcpt.contractAddress);
	out.counter = counter;

	// contract call: storage write + one log
	await bothWays(
		'1559-call(increment)',
		await sign1559({
			to: counter,
			data: encodeFunctionData({abi: counterAbi, functionName: 'increment'}),
			gas: 200_000n,
		}),
	);

	// value transfer (the smallest tx — where ecrecover share is highest)
	await bothWays(
		'1559-value-transfer',
		await sign1559({to: OTHER, value: 12_345n, gas: 21_000n}),
	);

	// LEGACY (type-0): the effectiveGasPrice path must survive trusted mode too
	await bothWays(
		'legacy-call(add)',
		await signLegacy({
			to: counter,
			data: encodeFunctionData({
				abi: counterAbi,
				functionName: 'add',
				args: [7n],
			}),
			gas: 200_000n,
		}),
	);

	// probe deploy, then multi-log and revert paths
	const probeRcpt = await bothWays(
		'1559-deploy(Probe)',
		await sign1559({
			data: encodeDeployData({abi: probeAbi, bytecode: probeBytecode}),
			gas: 1_000_000n,
		}),
	);
	const probe = String(probeRcpt.contractAddress);

	await bothWays(
		'multi-log(emitTwo)',
		await sign1559({
			to: probe,
			data: encodeFunctionData({
				abi: probeAbi,
				functionName: 'emitTwo',
				args: [3n, 4n],
			}),
			gas: 200_000n,
		}),
	);

	// a REVERTING tx: status 0, gas still charged. If the two modes disagreed on
	// gas anywhere, a revert is where it shows up first.
	await bothWays(
		'reverting(boom)',
		await sign1559({
			to: probe,
			data: encodeFunctionData({abi: probeAbi, functionName: 'boom'}),
			gas: 200_000n,
		}),
	);

	// --- post-state must match across both nodes -----------------------------
	for (const [what, addr] of [
		['sender', account.address],
		['recipient', OTHER],
		['counter', counter],
		['probe', probe],
	] as const) {
		const a = await readState(recoverNode, addr);
		const b = await readState(trustedNode, addr);
		for (const k of ['balance', 'nonce', 'code'] as const) {
			if (String(a[k]) !== String(b[k])) {
				mismatches.push(`post-state ${what}.${k}: ${a[k]} != ${b[k]}`);
			}
		}
	}
	const sA = await recoverNode.request({
		method: 'eth_getStorageAt',
		params: [counter, '0x0', 'latest'],
	});
	const sB = await trustedNode.request({
		method: 'eth_getStorageAt',
		params: [counter, '0x0', 'latest'],
	});
	if (String(sA) !== String(sB)) {
		mismatches.push(`post-state counter.storage[0]: ${sA} != ${sB}`);
	}

	// --- 2) SAFETY: the cheat must NOT exist in the default mode --------------
	for (const method of [
		'evm_sendRawTransactionAs',
		'evm_sendRawTransactionSyncAs',
	]) {
		try {
			await recoverNode.request({
				method,
				params: [await sign1559({to: OTHER, value: 1n, gas: 21_000n}), OTHER],
			});
			out[`gap_${method}`] = 'NO THROW (BUG: cheat available in recover mode)';
		} catch (e) {
			const code = e instanceof RpcError ? e.code : (e as any)?.code;
			out[`gap_${method}`] = `threw:${code}`;
		}
	}

	// --- 3) THE CLAIMED SENDER IS THE SENDER, even against the signature -------
	//
	// Signed by FABRICATING_SIGNER, submitted CLAIMING `OTHER`. This is the ONE case
	// that separates "the engine executed on behalf of the sender the node STATED"
	// from "the engine recovered a sender of its own": everywhere else in this file
	// the two answers coincide, so every other assertion passes either way.
	//
	// AND IT IS BUILT SO THAT THE WRONG ANSWER IS SILENT. Both accounts hold the
	// genesis balance at nonce 0 (see FABRICATING_SIGNER), so a re-recovering engine
	// does not trip a nonce or funds check — it executes happily as the signer, and
	// the node's receipt still names the claimed sender. Nothing throws; only the
	// post-state tells the two apart.
	//
	// So this is asserted ABSOLUTELY, on both sides of the divergence: the CLAIMED
	// sender pays the whole cost to the wei and its nonce moves, while the SIGNER pays
	// NOTHING and its nonce does not move. It also asserts the call really executed
	// (the counter incremented), because "nothing happened at all" would otherwise
	// satisfy the signer-side half of that.
	{
		const claimed = OTHER;
		const signer = FABRICATING_SIGNER.address;
		// ZERO, because `increment()` is nonpayable and would revert on a value-bearing
		// call. The fee is the charge that matters here anyway: it is taken from the
		// sender's balance, and WHOSE balance is the whole question. (The value-bearing
		// case is covered for both modes by the `1559-value-transfer` step above and,
		// against the reference EVM, by the conformance battery.) Kept in the arithmetic
		// rather than dropped, so the expected charge stays the full formula.
		const value = 0n;
		const readNumber = async () =>
			BigInt(
				String(
					await trustedNode.request({
						method: 'eth_call',
						params: [
							{
								to: counter,
								data: encodeFunctionData({
									abi: counterAbi,
									functionName: 'number',
								}),
							},
						],
					}),
				),
			);

		const claimedBalanceBefore = await balanceOf(trustedNode, claimed);
		const claimedNonceBefore = await nonceOf(trustedNode, claimed);
		const signerBalanceBefore = await balanceOf(trustedNode, signer);
		const signerNonceBefore = await nonceOf(trustedNode, signer);
		const numberBefore = await readNumber();

		// Signed by the OTHER key entirely, at a nonce that is valid for the claimed
		// sender AND for the signer (both are 0 here) — see FABRICATING_SIGNER.
		const raw = await FABRICATING_SIGNER.signTransaction({
			chainId: CHAIN_ID,
			nonce: Number(claimedNonceBefore),
			to: counter,
			data: encodeFunctionData({abi: counterAbi, functionName: 'increment'}),
			value,
			gas: 200_000n,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			type: 'eip1559',
		} as any);
		const rcpt = (await trustedNode.request({
			method: 'evm_sendRawTransactionSyncAs',
			params: [raw, claimed],
		})) as Rcpt;

		const claimedBalanceAfter = await balanceOf(trustedNode, claimed);
		const claimedNonceAfter = await nonceOf(trustedNode, claimed);
		const signerBalanceAfter = await balanceOf(trustedNode, signer);
		const signerNonceAfter = await nonceOf(trustedNode, signer);
		const numberAfter = await readNumber();

		// What the CLAIMED sender must have paid: the value it sent plus the gas the
		// engine says it charged, at the price the engine says it charged. Both numbers
		// come off the receipt, so this is the engine's own arithmetic held against the
		// node's own state — and the account it must have come out of is the CLAIMED one.
		const gasUsed = BigInt(String(rcpt.gasUsed));
		const effectiveGasPrice = BigInt(String(rcpt.effectiveGasPrice));
		const expectedCharge = value + gasUsed * effectiveGasPrice;
		const claimedDelta = claimedBalanceAfter - claimedBalanceBefore;
		const signerDelta = signerBalanceAfter - signerBalanceBefore;

		const m: string[] = [];
		// THE CHECK'S OWN PRECONDITIONS, asserted rather than assumed — if a later edit
		// breaks them the check silently stops being able to catch anything, which is a
		// worse failure than a red test.
		if (claimed.toLowerCase() === signer.toLowerCase()) {
			m.push('the claimed sender and the signer are the SAME address');
		}
		if (signerNonceBefore !== claimedNonceBefore) {
			m.push(
				`lost its power: signer nonce ${signerNonceBefore} != claimed sender nonce ${claimedNonceBefore}, so a re-recovering engine would be caught by a NONCE error rather than by the post-state — i.e. the SILENT case would go uncovered`,
			);
		}
		if (signerBalanceBefore < expectedCharge) {
			m.push(
				`lost its power: the signer holds ${signerBalanceBefore} but the tx costs ${expectedCharge}, so a re-recovering engine would be caught by a FUNDS error rather than by the post-state`,
			);
		}
		if (String(rcpt.status) !== '0x1') {
			m.push(`status ${String(rcpt.status)} != 0x1`);
		}
		if (String(rcpt.from).toLowerCase() !== claimed.toLowerCase()) {
			m.push(`receipt.from ${String(rcpt.from)} != claimed ${claimed}`);
		}
		if (claimedDelta !== -expectedCharge) {
			m.push(
				`claimed sender balance delta ${claimedDelta} != -(value+gasUsed*effectiveGasPrice) ${-expectedCharge}`,
			);
		}
		if (claimedNonceAfter !== claimedNonceBefore + 1n) {
			m.push(
				`claimed sender nonce ${claimedNonceBefore} -> ${claimedNonceAfter} (expected +1)`,
			);
		}
		if (signerDelta !== 0n) {
			m.push(`the SIGNER was charged: balance delta ${signerDelta} != 0`);
		}
		if (signerNonceAfter !== signerNonceBefore) {
			m.push(
				`the SIGNER's nonce advanced: ${signerNonceBefore} -> ${signerNonceAfter}`,
			);
		}
		if (numberAfter !== numberBefore + 1n) {
			m.push(`counter.number ${numberBefore} -> ${numberAfter} (expected +1)`);
		}
		for (const one of m) mismatches.push(`claimed-sender: ${one}`);

		out.impersonation = {
			claimed: claimed.toLowerCase(),
			actualSigner: signer.toLowerCase(),
			receiptFrom: String(rcpt.from).toLowerCase(),
			chargedTheClaimedSender:
				String(rcpt.from).toLowerCase() === claimed.toLowerCase(),
			mismatches: m,
			// The numbers, so a failure is diagnosable from the log and so the two
			// engines' runs can be compared by eye as well as by assertion.
			gasUsed: gasUsed.toString(),
			effectiveGasPrice: effectiveGasPrice.toString(),
			value: value.toString(),
			claimedBalanceDelta: claimedDelta.toString(),
			signerBalanceDelta: signerDelta.toString(),
			claimedNonceBefore: claimedNonceBefore.toString(),
			claimedNonceAfter: claimedNonceAfter.toString(),
			signerNonceBefore: signerNonceBefore.toString(),
			signerNonceAfter: signerNonceAfter.toString(),
			counterNumberBefore: numberBefore.toString(),
			counterNumberAfter: numberAfter.toString(),
		};

		// THE CROSS-ENGINE BAR: the post-state after the trusted-sender transaction,
		// absolutely. Every tx in this file ran on the installed engine, so these are the
		// whole chain's balances and nonces plus the contract's storage, and BOTH specs
		// assert the SAME literals (`test/trusted-sender.spec.ts` and
		// `test/revm-trusted-sender.spec.ts`). Two engines that disagreed about who sent
		// what, or charged a different amount for it, cannot both match them.
		out.postState = {
			claimedBalance: claimedBalanceAfter.toString(),
			claimedNonce: claimedNonceAfter.toString(),
			signerBalance: signerBalanceAfter.toString(),
			signerNonce: signerNonceAfter.toString(),
			// The suite's MAIN sender, which sent every other transaction here: its
			// balance is the accumulated gas of the whole battery.
			mainSenderBalance: (
				await balanceOf(trustedNode, account.address)
			).toString(),
			mainSenderNonce: (await nonceOf(trustedNode, account.address)).toString(),
			counterNumber: numberAfter.toString(),
			counterStorage0: String(
				await trustedNode.request({
					method: 'eth_getStorageAt',
					params: [counter, '0x0', 'latest'],
				}),
			),
		};
	}

	// --- async (non-sync) variant returns a hash, and it mines ----------------
	{
		const n = (await trustedNode.request({
			method: 'eth_getTransactionCount',
			params: [account.address],
		})) as string;
		const raw = await account.signTransaction({
			chainId: CHAIN_ID,
			nonce: Number(BigInt(n)),
			to: OTHER,
			value: 1n,
			gas: 21_000n,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			type: 'eip1559',
		} as any);
		const hash = (await trustedNode.request({
			method: 'evm_sendRawTransactionAs',
			params: [raw, account.address],
		})) as string;
		const rcpt = (await trustedNode.request({
			method: 'eth_getTransactionReceipt',
			params: [hash],
		})) as Rcpt;
		out.asyncVariant = {
			hashIsReal: /^0x[0-9a-f]{64}$/.test(hash),
			receiptFound: rcpt != null,
			status: rcpt?.status,
		};
	}

	// EVERY check in this file reports into ONE list, counted at the END (so a
	// section added below is covered by the same assertion instead of quietly
	// falling outside the count).
	out.mismatches = mismatches;
	out.totalMismatches = mismatches.length;

	await recoverNode.dispose();
	await trustedNode.dispose();
	return out;
}
