/**
 * sender-recovery.ts — deriving a transaction's SENDER from its signature using a
 * curve implementation the node is handed, rather than the one `@ethereumjs/tx`
 * carries.
 *
 * WHY THIS MODULE EXISTS. `senderMode:'recover'` pays a fixed ecrecover on every
 * transaction, and it is the single dominant cost of a small one. An engine whose
 * module ALREADY contains secp256k1 — `webevm/revm`, whose `0x01`
 * precompile is exactly that code — can do the curve arithmetic for nothing extra,
 * so the seam offers an optional `Engine.ecrecover` and this module is what turns
 * that primitive into a sender. With no such engine the node keeps calling
 * `tx.getSenderAddress()` (see `parseTx` in ./node.ts), which is the
 * implementation these functions must agree with, case for case, INCLUDING the
 * cases that must FAIL.
 *
 * THE DIVISION OF LABOUR, which is the load-bearing part. The engine answers ONE
 * question — "which address produced `(r, s)` over this digest with this recovery
 * id" — and every PROTOCOL rule stays here, above the seam:
 *
 *   1. THE MESSAGE. `tx.getMessageToVerifySignature()` — EIP-155's nine-field
 *      preimage for a protected legacy transaction, the type-prefixed one for a
 *      typed transaction. Asked of the transaction rather than recomputed, because
 *      a second implementation of those rules is a second thing that can be wrong.
 *   2. EIP-2 (low `s`). NOT delegable, and this is the trap the whole module is
 *      arranged around: revm's ecrecover is the `0x01` PRECOMPILE's, and the
 *      precompile NORMALISES a high-`s` signature and returns an address —
 *      correctly, since EIP-2 constrains transactions and not the precompile. A
 *      node that simply forwarded `(hash, v, r, s)` would therefore ADMIT, on the
 *      revm engine, a transaction the default engine REFUSES: silently, with a
 *      plausible receipt, and attributed to the right signer, which is what makes
 *      it easy to miss. So the rule is enforced HERE, on the same terms
 *      `@ethereumjs/tx` enforces it (`s > n/2`, from Homestead on), and the answer
 *      is identical on every engine.
 *   3. THE RECOVERY ID. The wire carries `v`: 27/28 for a pre-EIP-155 legacy
 *      transaction, `chainId * 2 + 35/36` for a protected one, a bare y-parity for
 *      a typed one. The 0/1 recovery id is computed here (with
 *      `@ethereumjs/util`'s own `calculateSigRecovery`, the function the fallback
 *      path uses) and validated before the engine sees it, so an engine needs to
 *      know nothing about EIP-155 and a raw `v` can never reach the curve.
 *
 * WHAT IT REFUSES WITH. A plain `Error`, like the `@ethereumjs/tx` path it stands
 * in for — deliberately NOT a new `RpcError` code. An unrecoverable signature is a
 * malformed transaction, and it has always surfaced out of
 * `eth_sendRawTransaction*` as whatever the parse/recovery step threw; giving the
 * engine-backed path its own code would make the same bad transaction produce two
 * different errors depending on which engine is installed, which is the one thing
 * the seam exists to prevent. The MESSAGE differs (it says which implementation
 * refused, which is what a bug report needs) and the shape does not.
 *
 * The agreement is not argued, it is measured:
 * `test/helpers/sender-recovery.ts` runs the two implementations side by side as a
 * primitive AND through two nodes, over a known signer for legacy, EIP-2930 and
 * EIP-1559 transactions and over a malformed signature, a high-`s` one and a wrong
 * recovery id.
 */
import type {Common} from '@ethereumjs/common';
import {Capability, type TypedTransaction} from '@ethereumjs/tx';
import {
	Address,
	SECP256K1_ORDER_DIV_2,
	calculateSigRecovery,
	setLengthLeft,
	bigIntToBytes,
} from '@ethereumjs/util';
import type {Engine} from './types.js';

/** The seam's curve primitive, as this module consumes it. */
export type EngineEcrecover = NonNullable<Engine['ecrecover']>;

/**
 * WHO SIGNED `tx`, using `ecrecover` for the curve step and enforcing every
 * protocol rule around it here.
 *
 * Throws when the signature authenticates nobody — a missing signature, an `s` in
 * the upper half of the curve order (EIP-2), a `v` that is not a recovery id, or a
 * point that does not recover. NEVER returns a "best effort" address: attributing
 * a transaction to the wrong account is worse than rejecting it, because it
 * charges that account, advances its nonce and produces a receipt that looks
 * entirely right.
 *
 * @param tx the parsed transaction, frozen, exactly as the node holds it.
 * @param common the node's chain parameters (chain id + hardfork).
 * @param ecrecover the engine's curve primitive (see {@link Engine.ecrecover}).
 */
export function recoverSender(
	tx: TypedTransaction,
	common: Common,
	ecrecover: EngineEcrecover,
): Address {
	const {v, r, s} = tx as {v?: bigint; r?: bigint; s?: bigint};
	if (v === undefined || r === undefined || s === undefined) {
		throw new Error(
			'webevm: cannot recover the sender of an UNSIGNED transaction ' +
				'(no v/r/s on the wire). Sign it client-side and resubmit.',
		);
	}

	// EIP-2, on the same terms `@ethereumjs/tx` states them: from Homestead on, an
	// `s` above n/2 is INVALID even though the curve recovers it perfectly well
	// (it is the malleable twin of a valid signature, and it recovers to the same
	// signer). The engine's ecrecover will not say so — the `0x01` precompile
	// normalises it — so this is the check that keeps the two implementations
	// answering the same thing.
	if (common.gteHardfork('homestead') && s > SECP256K1_ORDER_DIV_2) {
		throw new Error(
			'webevm: Invalid Signature: s-values greater than secp256k1n/2 ' +
				'are considered invalid (EIP-2). The transaction is REFUSED rather than ' +
				'attributed to the address its malleable twin would recover to.',
		);
	}

	// The wire's `v` -> a 0/1 recovery id. `Capability.EIP155ReplayProtection` is
	// set only for a legacy transaction whose `v` really encodes this chain id, so
	// this is the same branch `@ethereumjs/tx` takes; a typed transaction's `v` is
	// already the y-parity and `calculateSigRecovery` returns it unchanged.
	const recovery = calculateSigRecovery(
		v,
		tx.supports(Capability.EIP155ReplayProtection)
			? common.chainId()
			: undefined,
	);
	if (recovery !== 0n && recovery !== 1n) {
		throw new Error(
			`webevm: Invalid Signature: v ${v} is not a recovery id on chain ` +
				`${common.chainId()} (expected 27/28, ${common.chainId() * 2n + 35n}/${common.chainId() * 2n + 36n}, or a 0/1 y-parity).`,
		);
	}

	const address = ecrecover(
		tx.getMessageToVerifySignature(),
		Number(recovery),
		setLengthLeft(bigIntToBytes(r), 32),
		setLengthLeft(bigIntToBytes(s), 32),
	);
	if (address === undefined || address.length !== 20) {
		throw new Error(
			"webevm: Invalid Signature: the engine's ecrecover recovered no " +
				'address from this transaction, so there is nobody to attribute it to.',
		);
	}
	return new Address(address);
}
