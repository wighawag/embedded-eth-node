/**
 * intrinsic-gas.ts — the transaction's INTRINSIC gas, in one place.
 *
 * 21000 base, plus 16 per non-zero and 4 per zero calldata byte, plus (for a
 * creation) 32000 and the EIP-3860 initcode word cost.
 *
 * It lives on its own because TWO callers need the same answer and a silent
 * disagreement between them is expensive: `node.ts` ADDS it to whatever the read
 * engine reports (an engine reports EXECUTION gas only), and
 * `embedded-eth-node/revm` SUBTRACTS it, because revm charges intrinsic gas
 * itself out of the transaction gas limit while `@ethereumjs/evm`'s `runCall`
 * charges none. Two copies of this formula would drift and the drift would show
 * up as an `eth_estimateGas` that differs by engine.
 *
 * WHAT IS DELIBERATELY NOT HERE: EIP-7623's calldata floor (post-Prague, a
 * transaction pays at least `21000 + 10` gas per calldata token). It is not a
 * term of this formula — it is a floor on the transaction's TOTAL gas, so it
 * cannot be added here without both callers also learning about it. Rather than
 * cost a fork half-correctly, `embedded-eth-node/revm` REFUSES Prague and Osaka
 * (`REVM_REFUSED_HARDFORKS` in ./revm.ts), and the node runs Cancun. Anyone
 * moving the node's hardfork forward has to do this arithmetic first; see
 * `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`.
 */
export function intrinsicGas(data: Uint8Array, isCreate: boolean): bigint {
	let gas = 21_000n;
	for (const b of data) gas += b === 0 ? 4n : 16n;
	if (isCreate) {
		gas += 32_000n;
		gas += BigInt(Math.ceil(data.length / 32)) * 2n; // EIP-3860 initcode cost
	}
	return gas;
}
