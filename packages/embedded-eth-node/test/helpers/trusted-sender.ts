/**
 * trusted-sender.ts — the gate for `senderMode:'trusted'`.
 *
 * `'trusted'` skips ecrecover and pins the sender to a caller-supplied address.
 * That is a ~13x speedup on a small tx, and it removes the ONLY thing binding a
 * tx to its signer. So it is worth exactly as much as the proof that it changes
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
 *   3. HONESTY: `'trusted'` really does impersonate. We send a tx signed by A
 *      while claiming to be B, and assert the node charged B. This is the
 *      documented footgun, asserted so it can never become an accident.
 *
 * It is deliberately NOT a perf test — the speedup is measured in the benchmarks
 * package. This only asserts equivalence.
 */
import {createNode, RpcError, type SlimNode} from '../../src/index.js';
import {encodeFunctionData, encodeDeployData} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {counterAbi, counterBytecode} from './counter.js';
import {probeAbi, probeBytecode} from './probe.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const GENESIS_BALANCE = 10n ** 24n;
const account = privateKeyToAccount(PK);

/** A second funded account, used for the impersonation check. */
const OTHER = '0x00000000000000000000000000000000000000cc';

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

export async function runTrustedSenderChecks() {
	const mismatches: string[] = [];
	const out: Record<string, unknown> = {};

	const mk = (senderMode: 'recover' | 'trusted') =>
		createNode({
			chainId: CHAIN_ID,
			senderMode,
			miningConfig: {type: 'auto'},
			initialBalances: {
				[account.address]: GENESIS_BALANCE,
				[OTHER]: GENESIS_BALANCE,
			},
		});

	const recoverNode = await mk('recover');
	const trustedNode = await mk('trusted');

	out.recoverNodeSenderMode = recoverNode.senderMode;
	out.trustedNodeSenderMode = trustedNode.senderMode;

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

	out.mismatches = mismatches;
	out.totalMismatches = mismatches.length;

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

	// --- 3) HONESTY: trusted mode really does impersonate ---------------------
	// Sign with `account` but CLAIM to be OTHER. A real node would reject this (or
	// rather, would charge `account`). The trusted node must charge OTHER — that is
	// the documented footgun, asserted so it cannot regress into a surprise.
	{
		const otherNonceBefore = (await trustedNode.request({
			method: 'eth_getTransactionCount',
			params: [OTHER],
		})) as string;
		const raw = await account.signTransaction({
			chainId: CHAIN_ID,
			nonce: Number(BigInt(otherNonceBefore)),
			to: counter,
			data: encodeFunctionData({abi: counterAbi, functionName: 'increment'}),
			gas: 200_000n,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			type: 'eip1559',
		} as any);
		const rcpt = (await trustedNode.request({
			method: 'evm_sendRawTransactionSyncAs',
			params: [raw, OTHER],
		})) as Rcpt;
		out.impersonation = {
			claimed: OTHER,
			actualSigner: account.address.toLowerCase(),
			receiptFrom: String(rcpt.from).toLowerCase(),
			chargedTheClaimedSender:
				String(rcpt.from).toLowerCase() === OTHER.toLowerCase(),
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

	await recoverNode.dispose();
	await trustedNode.dispose();
	return out;
}
