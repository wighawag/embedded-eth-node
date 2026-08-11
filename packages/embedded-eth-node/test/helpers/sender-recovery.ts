/**
 * sender-recovery.ts — the differential for `senderMode:'recover'` when the
 * installed engine brings its OWN `ecrecover`.
 *
 * WHAT MOVED, AND WHAT DID NOT. `'recover'` still derives the sender from the
 * signature, exactly as a real node does; what changes is WHO runs the elliptic
 * curve. When the installed engine exposes the seam's optional `ecrecover`
 * (`embedded-eth-node/revm` does — the secp256k1 the `0x01` precompile already
 * carries in the wasm module, at zero additional bytes), the node hands it the
 * message hash, the recovery id and `(r, s)` and gets an address back. With no
 * such engine it calls `tx.getSenderAddress()`, which is what it always did. TWO
 * IMPLEMENTATIONS of the same authentication, and this file is the proof that
 * they answer identically.
 *
 * THE BAR IS AGREEMENT ON FAILURES, not speed. A recovery that returns a
 * PLAUSIBLE WRONG ADDRESS authenticates a transaction as somebody else: nothing
 * throws, the receipt looks right, and the wrong account is charged and its nonce
 * advanced. So the interesting half of this file is the transactions that must be
 * REFUSED, and it is written knowing where the two implementations would part
 * company if the node got lazy:
 *
 *   - HIGH-`s` (EIP-2). revm's `ecrecover` is the `0x01` PRECOMPILE's, and the
 *     precompile NORMALISES a high-`s` signature (flipping the recovery id) and
 *     returns an address — as it must, because EIP-2 is a rule about
 *     TRANSACTIONS, not about the precompile. `@ethereumjs/tx` refuses such a
 *     transaction. So handing the engine `(hash, v, r, s)` without checking `s`
 *     first would make a revm-backed node ADMIT a transaction the default engine
 *     REFUSES — silently, and as the right signer, which is what makes it easy to
 *     miss. The check therefore stays ABOVE the seam, in the node, and
 *     `legacy-high-s` below is what says so. It is a LEGACY transaction on
 *     purpose: `@ethereumjs/tx` validates high-`s` in the CONSTRUCTOR of every
 *     TYPED transaction, so a type-1/2 case is refused while parsing and never
 *     reaches recovery at all.
 *   - THE RECOVERY ID. The wire carries `v`, not a recovery id: 27/28 for a
 *     pre-EIP-155 legacy transaction, `chainId * 2 + 35/36` for a protected one,
 *     a bare y-parity for a typed one. The node computes the 0/1 recovery id
 *     itself and hands THAT across the seam, so an engine never has to know
 *     EIP-155 exists. `legacy-bad-v` covers the refusal and
 *     `recoveryIdsHandedToTheEngine` pins the normalisation: a node that
 *     forwarded a raw EIP-155 `v` would have revm answer `undefined` and reject
 *     every protected legacy transaction.
 *   - A MALFORMED SIGNATURE. `r = 0` is recoverable by nobody; both must say so,
 *     rather than one of them returning something the node treats as an address.
 *
 * THREE LAYERS, because each can pass while another fails:
 *   1. THE PRIMITIVE, side by side (`primitiveTable`): `@ethereumjs/util`'s
 *      `ecrecover` + `publicToAddress` — which is what `tx.getSenderAddress()`
 *      runs — against `engine.ecrecover`, called DIRECTLY over a table of
 *      signatures. No node, no transaction: just "do these two agree, case by
 *      case", including the cases where agreeing on a REFUSAL is the answer.
 *   2. THE NODE DIFFERENTIAL: the same raw transaction bytes submitted to a node
 *      WITHOUT the engine and a node WITH it — the same sender for the good ones,
 *      the same refusal for the bad ones, and for a refused one nothing mined and
 *      no state moved on either, because "attributed to some address" is exactly
 *      what a moved balance would be.
 *   3. THE WIRING: a counting wrapper in front of the engine's `ecrecover` proves
 *      the engine-backed node really used it — a run where the node quietly kept
 *      recovering in JS passes every assertion above while comparing the fallback
 *      with itself — and proves `senderMode:'trusted'` calls it ZERO times.
 *
 * `senderMode:'trusted'` IS UNTOUCHED and this file does not re-litigate it; its
 * suite is ./trusted-sender.ts. The one thing asserted here is the property this
 * change could have broken — that `'trusted'` still skips recovery ENTIRELY, now
 * MEASURED ("the engine's ecrecover was never called") rather than argued.
 */
import {
	createNode,
	RpcError,
	type Engine,
	type SlimNode,
} from '../../src/index.js';
import type {EngineFactory} from './conformance.js';
import {Common, Hardfork, Mainnet} from '@ethereumjs/common';
import {createTxFromRLP} from '@ethereumjs/tx';
import {
	bytesToHex,
	ecrecover as utilEcrecover,
	hexToBytes,
	publicToAddress,
} from '@ethereumjs/util';
import {keccak_256} from '@noble/hashes/sha3.js';
import {parseTransaction, serializeTransaction, type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const GENESIS_BALANCE = 10n ** 24n;
const account = privateKeyToAccount(PK);
const RECIPIENT = '0x00000000000000000000000000000000000000cc';

/** The secp256k1 group order. `s > n / 2` is what EIP-2 refuses. */
const SECP256K1_N =
	0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * A FIXED digest for the primitive table, not a random one: a table row that
 * fails should fail the same way on the next run, and a random signature would
 * make a curve-edge disagreement appear and vanish between runs.
 */
const FIXED_DIGEST = ('0x' + '11223344'.repeat(8)) as Hex;

/** The node's own chain parameters, for reading a transaction's message hash. */
const common = new Common({
	chain: {...Mainnet, chainId: CHAIN_ID, name: 'embedded-eth-node'},
	hardfork: Hardfork.Cancun,
	customCrypto: {keccak256: (m: Uint8Array) => keccak_256(m)},
});

type Row = Record<string, unknown>;

const hex32 = (v: bigint): Uint8Array =>
	hexToBytes(`0x${v.toString(16).padStart(64, '0')}`);

/**
 * WHAT `tx.getSenderAddress()` RUNS, reduced to the shape the seam's `ecrecover`
 * has: `@ethereumjs/util`'s `ecrecover` (`@noble/curves`) plus `publicToAddress`.
 * It THROWS where the seam returns `undefined`, so the shapes are normalised here
 * and only the ANSWER is compared — a difference in how "no" is spelled is not a
 * disagreement about who signed.
 */
function jsEcrecover(
	hash: Uint8Array,
	recoveryId: number,
	r: Uint8Array,
	s: Uint8Array,
): Uint8Array | undefined {
	try {
		return publicToAddress(utilEcrecover(hash, BigInt(recoveryId), r, s));
	} catch {
		return undefined;
	}
}

/** A legacy transaction's `(v, r, s)`, read back off the wire. */
function legacySignature(raw: Hex): {v: bigint; r: bigint; s: bigint} {
	const parsed = parseTransaction(raw) as {v: bigint; r: Hex; s: Hex};
	return {v: parsed.v, r: BigInt(parsed.r), s: BigInt(parsed.s)};
}

/**
 * Re-serialise a legacy transaction with a DIFFERENT signature. viem passes a
 * `v >= 35` through VERBATIM, which is what lets a deliberately wrong recovery id
 * onto the wire at all: `@ethereumjs/tx` refuses to CONSTRUCT such a transaction,
 * and that is the point — these bytes have to arrive from outside, the way a real
 * one would.
 */
function reSignLegacy(
	fields: Record<string, unknown>,
	sig: {v: bigint; r: bigint; s: bigint},
): Hex {
	return serializeTransaction(
		{...fields, type: 'legacy'} as never,
		{
			v: sig.v,
			r: `0x${sig.r.toString(16).padStart(64, '0')}`,
			s: `0x${sig.s.toString(16).padStart(64, '0')}`,
		} as never,
	);
}

/**
 * The digest a signed transaction's signature is over, taken from
 * `@ethereumjs/tx` rather than recomputed: EIP-155's message is the six
 * transaction fields plus `chainId, 0, 0`, and a second implementation of that
 * rule inside a test is a second thing that can be wrong.
 */
function messageHash(raw: Hex): Uint8Array {
	return createTxFromRLP(hexToBytes(raw), {
		common,
	}).getMessageToVerifySignature();
}

async function readState(node: SlimNode, addr: string) {
	return {
		balance: String(
			await node.request({method: 'eth_getBalance', params: [addr, 'latest']}),
		),
		nonce: String(
			await node.request({
				method: 'eth_getTransactionCount',
				params: [addr, 'latest'],
			}),
		),
	};
}

const blockNumber = async (node: SlimNode): Promise<string> =>
	String(await node.request({method: 'eth_blockNumber', params: []}));

export async function runSenderRecoveryChecks(opts: {
	makeEngine: EngineFactory;
}) {
	const mismatches: string[] = [];
	const out: Record<string, unknown> = {};

	// The counter is the CALLER's and spans every node built below, exactly like
	// `countingEngines` in ./conformance.ts — so "the engine recovered N senders"
	// is a fact about the whole run rather than about one node.
	const ecrecoverCalls: Record<string, number> = {recover: 0, trusted: 0};

	/** The engine, with a counter (and optionally a recorder) on `ecrecover`. */
	const countingEngine = async (
		bucket: 'recover' | 'trusted',
		seen?: number[],
	): Promise<Engine> => {
		const inner = await opts.makeEngine();
		return {
			id: inner.id,
			...(inner.connect
				? {
						connect: (ctx: Parameters<NonNullable<Engine['connect']>>[0]) =>
							inner.connect!(ctx),
					}
				: {}),
			call: (request) => inner.call(request),
			transact: (request) => inner.transact(request),
			ecrecover: (hash, recoveryId, r, s) => {
				ecrecoverCalls[bucket]++;
				seen?.push(recoveryId);
				return inner.ecrecover!(hash, recoveryId, r, s);
			},
		};
	};

	const mk = async (
		senderMode: 'recover' | 'trusted',
		engine?: Engine,
	): Promise<SlimNode> =>
		createNode({
			chainId: CHAIN_ID,
			senderMode,
			miningConfig: {type: 'auto'},
			// The RECIPIENT is funded too, because the `'trusted'` step below CLAIMS it
			// as the sender: a claimed sender still has to be able to pay, and an
			// unfunded one would be refused by the node's affordability check before
			// recovery was ever the question.
			initialBalances: {
				[account.address]: GENESIS_BALANCE,
				[RECIPIENT]: GENESIS_BALANCE,
			},
			engine,
		});

	// ---- 1) THE PRIMITIVE, side by side --------------------------------------
	//
	// A standalone engine, never given to a node: `ecrecover` needs no state, no
	// block and no fork, which is exactly why the node can ask it BEFORE there is
	// anything to run the transaction against.
	const bareEngine = await opts.makeEngine();
	out.engineExposesEcrecover = typeof bareEngine.ecrecover === 'function';
	if (bareEngine.ecrecover === undefined) {
		mismatches.push(
			`the engine '${bareEngine.id}' exposes no ecrecover, so there is nothing to differentiate`,
		);
		out.mismatches = mismatches;
		out.totalMismatches = mismatches.length;
		return out;
	}

	const primitiveTable: Row[] = [];
	{
		const digest = hexToBytes(FIXED_DIGEST);
		const sig = await account.sign({hash: FIXED_DIGEST});
		const r = BigInt(`0x${sig.slice(2, 66)}`);
		const s = BigInt(`0x${sig.slice(66, 130)}`);
		const vByte = Number.parseInt(sig.slice(130, 132), 16);
		const rec = vByte >= 27 ? vByte - 27 : vByte;

		// A REAL transaction's own signature over its own message, so the table is
		// not purely a synthetic curve exercise: this is the exact input the node
		// hands across the seam for an ordinary send.
		const realRaw = await account.signTransaction({
			chainId: CHAIN_ID,
			type: 'legacy',
			nonce: 0,
			to: RECIPIENT,
			value: 1n,
			gas: 21_000n,
			gasPrice: 2_000_000_000n,
		} as never);
		const real = legacySignature(realRaw);
		const realRec = Number(real.v - (BigInt(CHAIN_ID) * 2n + 35n));

		const cases: [string, Uint8Array, number, bigint, bigint][] = [
			['valid', digest, rec, r, s],
			// The transaction's own signature, over the transaction's own message.
			['real-tx-signature', messageHash(realRaw), realRec, real.r, real.s],
			// The SAME signature with the other recovery id. Both must agree, and what
			// they agree on is a DIFFERENT address: ECDSA cannot tell a flipped
			// recovery bit from a different signer, which is exactly why the node
			// never lets an engine pick the recovery id for itself.
			['valid/flipped-recovery-id', digest, rec ^ 1, r, s],
			// EIP-2's malleable twin: `(r, n - s)` with the recovery id flipped is the
			// same signature mathematically and recovers to the SAME signer. BOTH
			// implementations accept it — that is the finding this row records, and
			// the reason the node refuses it one layer up instead of here.
			['high-s/malleable-twin', digest, rec ^ 1, r, SECP256K1_N - s],
			['r=0', digest, rec, 0n, s],
			['s=0', digest, rec, r, 0n],
			['r=n', digest, rec, SECP256K1_N, s],
			['s=n', digest, rec, r, SECP256K1_N],
			['r=n-1 (no such point)', digest, rec, SECP256K1_N - 1n, s],
			// Recovery ids the seam must never be handed, asserted anyway: the node
			// validates them, and an engine that quietly REINTERPRETED them (revm's
			// raw entry point also accepts 27/28) would hide a node-side bug.
			['recovery-id=2', digest, 2, r, s],
			['recovery-id=3', digest, 3, r, s],
			['recovery-id=4', digest, 4, r, s],
			['recovery-id=27', digest, 27, r, s],
			['recovery-id=28', digest, 28, r, s],
		];
		for (const [label, h, recoveryId, rr, ss] of cases) {
			const rb = hex32(rr);
			const sb = hex32(ss);
			const js = jsEcrecover(h, recoveryId, rb, sb);
			const eng = bareEngine.ecrecover(h, recoveryId, rb, sb);
			const show = (v: Uint8Array | undefined) =>
				v === undefined ? 'REFUSED' : bytesToHex(v);
			if (show(js) !== show(eng)) {
				mismatches.push(
					`primitive ${label}: js ${show(js)} != engine ${show(eng)}`,
				);
			}
			primitiveTable.push({label, js: show(js), engine: show(eng)});
		}
	}
	out.primitiveTable = primitiveTable;

	// ---- 2) THE NODE DIFFERENTIAL -------------------------------------------

	/** No engine: `tx.getSenderAddress()`, the implementation being replaced. */
	const fallbackNode = await mk('recover');
	/** The engine's ecrecover, counted. */
	const engineNode = await mk('recover', await countingEngine('recover'));

	out.fallbackEngineId = fallbackNode.engine.id;
	out.engineNodeEngineId = engineNode.engine.id;

	// 2a) A KNOWN SIGNER, for each transaction type the node admits. The
	// differential alone cannot see two nodes agreeing on the WRONG address, so
	// every recovered sender is ALSO held against the account that signed it.
	const shared = {
		chainId: CHAIN_ID,
		to: RECIPIENT,
		value: 1n,
		gas: 21_000n,
	} as const;
	const goodTxs: [string, Hex][] = [
		[
			'legacy',
			await account.signTransaction({
				...shared,
				type: 'legacy',
				nonce: 0,
				gasPrice: 2_000_000_000n,
			} as never),
		],
		[
			'eip2930',
			await account.signTransaction({
				...shared,
				type: 'eip2930',
				nonce: 1,
				gasPrice: 2_000_000_000n,
				accessList: [],
			} as never),
		],
		[
			'eip1559',
			await account.signTransaction({
				...shared,
				type: 'eip1559',
				nonce: 2,
				maxFeePerGas: 2_000_000_000n,
				maxPriorityFeePerGas: 1_000_000_000n,
			} as never),
		],
	];
	const senders: Row[] = [];
	for (const [label, raw] of goodTxs) {
		const a = (await fallbackNode.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		})) as Row;
		const b = (await engineNode.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		})) as Row;
		const fallback = String(a.from).toLowerCase();
		const engine = String(b.from).toLowerCase();
		if (fallback !== engine) {
			mismatches.push(
				`${label}: fallback recovered ${fallback}, engine recovered ${engine}`,
			);
		}
		if (fallback !== account.address.toLowerCase()) {
			mismatches.push(
				`${label}: recovered ${fallback}, which is not the signer ${account.address.toLowerCase()}`,
			);
		}
		senders.push({label, fallback, engine});
	}
	out.senders = senders;
	out.expectedSigner = account.address.toLowerCase();

	// 2b) THE REFUSALS. Each is a transaction whose signature must authenticate
	// NOBODY. Both nodes must reject it and — the part a thrown error does not
	// prove on its own — leave no block and no moved balance behind.
	const legacyFields = {
		chainId: CHAIN_ID,
		nonce: 3,
		to: RECIPIENT,
		value: 1n,
		gas: 21_000n,
		gasPrice: 2_000_000_000n,
	};
	const good = legacySignature(
		await account.signTransaction({...legacyFields, type: 'legacy'} as never),
	);
	const eip155V = (recoveryId: number) =>
		BigInt(CHAIN_ID) * 2n + 35n + BigInt(recoveryId);
	const goodRecoveryId = Number(good.v - eip155V(0));

	const badTxs: [string, Hex][] = [
		// MALFORMED, structurally: `r = 0` is the empty RLP item, so the transaction
		// is not even SIGNED as far as either implementation is concerned.
		['legacy-malformed-r0', reSignLegacy(legacyFields, {...good, r: 0n})],
		// MALFORMED, at the CURVE: `r = n - 1` is a perfectly well-formed signature
		// field that names no point, so this one gets all the way to secp256k1 and is
		// refused there — which is the case the row above cannot cover, since it never
		// reaches the curve at all.
		[
			'legacy-unrecoverable-r',
			reSignLegacy(legacyFields, {...good, r: SECP256K1_N - 1n}),
		],
		// HIGH-`s` (EIP-2): the malleable twin of a VALID signature, so it recovers
		// perfectly well — to the right signer — on BOTH curve implementations (see
		// `high-s/malleable-twin` above). Only the protocol rule refuses it, which is
		// why this is the case that catches a node that stopped applying the rule
		// once the engine took over the curve.
		[
			'legacy-high-s',
			reSignLegacy(legacyFields, {
				v: eip155V(goodRecoveryId ^ 1),
				r: good.r,
				s: SECP256K1_N - good.s,
			}),
		],
		// A WRONG RECOVERY ID: `chainId * 2 + 37`, one past the two EIP-155 admits.
		[
			'legacy-bad-v',
			reSignLegacy(legacyFields, {...good, v: BigInt(CHAIN_ID) * 2n + 37n}),
		],
	];

	const refusals: Row[] = [];
	for (const [label, raw] of badTxs) {
		const row: Row = {label};
		for (const [who, node] of [
			['fallback', fallbackNode],
			['engine', engineNode],
		] as const) {
			const blockBefore = await blockNumber(node);
			const before = await readState(node, account.address);
			let threw = false;
			let message = '';
			try {
				await node.request({
					method: 'eth_sendRawTransactionSync',
					params: [raw],
				});
			} catch (e) {
				threw = true;
				message = String((e as Error)?.message ?? e);
			}
			const blockAfter = await blockNumber(node);
			const after = await readState(node, account.address);
			const mined = blockBefore !== blockAfter;
			const stateMoved =
				before.balance !== after.balance || before.nonce !== after.nonce;
			row[`${who}Threw`] = threw;
			row[`${who}Message`] = message.slice(0, 140);
			row[`${who}Mined`] = mined;
			row[`${who}StateMoved`] = stateMoved;
			if (!threw) {
				mismatches.push(
					`${label}/${who}: ACCEPTED a transaction that authenticates nobody`,
				);
			}
			if (mined) mismatches.push(`${label}/${who}: mined a block for it`);
			if (stateMoved) {
				mismatches.push(
					`${label}/${who}: state moved (${JSON.stringify(before)} -> ${JSON.stringify(after)})`,
				);
			}
		}
		if (row.fallbackThrew !== row.engineThrew) {
			mismatches.push(
				`${label}: THE TWO IMPLEMENTATIONS DISAGREE — fallback threw ${row.fallbackThrew}, engine threw ${row.engineThrew}`,
			);
		}
		refusals.push(row);
	}
	out.refusals = refusals;

	// ---- 3) THE WIRING ------------------------------------------------------
	//
	// A FLOOR, not a count: what it rules out is the vacuous reading — that the
	// node quietly kept recovering in JS, and the whole differential above
	// compared the fallback implementation with itself.
	out.ecrecoverCalls = {...ecrecoverCalls};
	if (ecrecoverCalls.recover < goodTxs.length) {
		mismatches.push(
			`the engine's ecrecover ran ${ecrecoverCalls.recover} times for ${goodTxs.length} recovered senders — the node did not use it`,
		);
	}

	// `senderMode:'trusted'` STILL SKIPS RECOVERY ENTIRELY. Not argued: the
	// engine's ecrecover is counted, and for a trusted send the count must not
	// move. (What `'trusted'` MEANS, and its refusal outside that mode, are
	// ./trusted-sender.ts's assertions and are untouched by this file.)
	const trustedNode = await mk('trusted', await countingEngine('trusted'));
	const trustedRaw = await account.signTransaction({
		...shared,
		type: 'eip1559',
		nonce: 0,
		maxFeePerGas: 2_000_000_000n,
		maxPriorityFeePerGas: 1_000_000_000n,
	} as never);
	const trustedRcpt = (await trustedNode.request({
		method: 'evm_sendRawTransactionSyncAs',
		params: [trustedRaw, RECIPIENT],
	})) as Row;
	out.trustedEcrecoverCalls = ecrecoverCalls.trusted;
	out.trustedReceiptFrom = String(trustedRcpt.from).toLowerCase();
	if (ecrecoverCalls.trusted !== 0) {
		mismatches.push(
			`senderMode:'trusted' ran the engine's ecrecover ${ecrecoverCalls.trusted} times — it must skip recovery entirely`,
		);
	}
	if (out.trustedReceiptFrom !== RECIPIENT.toLowerCase()) {
		mismatches.push(
			`senderMode:'trusted' receipt.from ${out.trustedReceiptFrom} != the claimed sender ${RECIPIENT}`,
		);
	}
	// The cheat is still refused outside `'trusted'`, whatever engine is installed.
	try {
		await engineNode.request({
			method: 'evm_sendRawTransactionSyncAs',
			params: [trustedRaw, RECIPIENT],
		});
		out.cheatInRecoverMode = 'NO THROW (BUG)';
	} catch (e) {
		const code = e instanceof RpcError ? e.code : (e as {code?: number})?.code;
		out.cheatInRecoverMode = `threw:${code}`;
	}

	// ---- 4) WHAT THE NODE HANDS ACROSS THE SEAM ------------------------------
	//
	// The recovery id, NORMALISED. `v` on the wire is 27/28, `chainId * 2 + 35/36`
	// or a bare y-parity depending on the transaction; the seam carries 0 or 1 and
	// nothing else, so an engine never has to know EIP-155 exists. This is the
	// only assertion that looks at the value itself.
	{
		const seen: number[] = [];
		const node = await mk('recover', await countingEngine('recover', seen));
		// A PROTECTED legacy transaction (`v = chainId * 2 + 35/36`) and a typed one
		// (bare y-parity): the two wire encodings that differ most.
		for (const raw of [
			await account.signTransaction({
				...shared,
				type: 'legacy',
				nonce: 0,
				gasPrice: 2_000_000_000n,
			} as never),
			await account.signTransaction({
				...shared,
				type: 'eip1559',
				nonce: 1,
				maxFeePerGas: 2_000_000_000n,
				maxPriorityFeePerGas: 1_000_000_000n,
			} as never),
		]) {
			await node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
		}
		await node.dispose();
		const allZeroOrOne = seen.every((v) => v === 0 || v === 1);
		if (!allZeroOrOne) {
			mismatches.push(
				`the node handed the engine recovery ids [${seen.join(', ')}] — the seam carries 0 or 1, never the wire's v`,
			);
		}
		if (seen.length !== 2) {
			mismatches.push(
				`the recording engine saw ${seen.length} recoveries, expected 2`,
			);
		}
		out.recoveryIdsHandedToTheEngine = {seen, allZeroOrOne};
	}

	// EVERY check in this file reports into ONE list, counted at the END (so a
	// section added below is covered by the same assertion instead of quietly
	// falling outside the count).
	out.mismatches = mismatches;
	out.totalMismatches = mismatches.length;

	await fallbackNode.dispose();
	await engineNode.dispose();
	await trustedNode.dispose();
	return out;
}
