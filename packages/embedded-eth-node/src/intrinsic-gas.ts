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
 * THE FORK RANGE THIS FORMULA IS TRUE FOR IS SHANGHAI..CANCUN, and it has an
 * end at BOTH sides. The node runs Cancun; `embedded-eth-node/revm` admits
 * Shanghai and Cancun and refuses everything else BY NAME
 * (`REVM_REFUSED_HARDFORKS` in ./revm.ts). Move the node's hardfork outside that
 * range and this file is wrong before anything else is, in one of two ways:
 *
 * ABOVE it, EIP-7623's calldata floor (Prague onwards: a transaction pays at
 * least `21000 + 10` gas per calldata token) is missing and is DELIBERATELY not
 * here — it is not a term of this formula but a floor on the transaction's TOTAL
 * gas, so it cannot be added without both callers also learning about it. Rather
 * than cost a fork half-correctly, the engine refuses Prague and Osaka.
 *
 * BELOW it, the EIP-3860 initcode word cost below is charged UNCONDITIONALLY,
 * and EIP-3860 arrived in Shanghai. That is not an oversight and it is not a
 * latent bug to be gated: it was measured
 * (`docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`), and
 * on Berlin, London and Paris `revm-wasm` charges it too, so gating the term
 * here would leave revm's number unchanged (the engine subtracts this intrinsic
 * and the node adds it straight back) while moving the default engine's — an
 * agreed wrong number turned into a cross-engine divergence. The engine refuses
 * those three forks instead, which is what keeps the term below TRUE for every
 * fork any part of this node can run.
 *
 * Either way: anyone moving the node's hardfork has to do this arithmetic first;
 * see `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`.
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
