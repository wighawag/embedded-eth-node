/**
 * intrinsic-gas.ts — the transaction's INTRINSIC gas, in one place.
 *
 * 21000 base, plus 16 per non-zero and 4 per zero calldata byte (EIP-2028, from
 * Istanbul on), plus (for a creation) 32000 and, from Shanghai on, the EIP-3860
 * initcode word cost.
 *
 * It lives on its own because TWO callers need the same answer and a silent
 * disagreement between them is expensive: `node.ts` ADDS it to whatever the read
 * engine reports (an engine reports EXECUTION gas only), and
 * `embedded-eth-node/revm` SUBTRACTS it, because revm charges intrinsic gas
 * itself out of the transaction gas limit while `@ethereumjs/evm`'s `runCall`
 * charges none. Two copies of this formula would drift and the drift would show
 * up as an `eth_estimateGas` that differs by engine.
 *
 * WHY THE FORK IS A `Common` AND NOT A HARDFORK NAME. The formula has a
 * fork-dependent term, so both callers have to name the same fork — and the
 * cheapest way to guarantee that is not to compare two names but to pass ONE
 * OBJECT. `node.ts` builds the node's `Common` and hands that very instance to
 * the engine through the seam (`ReadEngineContext.common`), so the two callers
 * are asking the SAME `Common` the same question and cannot disagree even in
 * principle. It is also the right authority rather than merely a convenient one:
 * `common.isActivatedEIP()` is the table `@ethereumjs/vm`'s `runTx` consults, so
 * the read path charges a deployment exactly what this node's own transaction
 * path spends on it. A hardfork NAME would have meant a second activation table
 * in this repo — a fresh copy of the knowledge that EIP-3860 arrived in
 * Shanghai, which is precisely the drift this file exists to prevent. See
 * `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`.
 *
 * THE FORK RANGE THIS FORMULA IS TRUE FOR IS ISTANBUL..CANCUN, AND IT HAS AN END
 * AT BOTH SIDES. The node runs Cancun; `embedded-eth-node/revm` admits
 * Berlin..Cancun, which sits strictly inside that range. Every term above is
 * measured against the protocol at every admitted fork by the clause-(b)
 * assertions in `test/revm-engine.spec.ts`; the two ends are where the formula
 * stops being true, so they are what anyone moving the node's hardfork owes.
 *
 * ABOVE, AT PRAGUE: EIP-7623's calldata floor (a transaction pays at least
 * `21000 + 10` gas per calldata token) is missing here and is DELIBERATELY not
 * added: it is not a term of this formula but a floor on the transaction's TOTAL
 * gas, so it cannot be added without both callers also learning about it. Rather
 * than cost a fork half-correctly, the engine refuses Prague and Osaka BY NAME
 * (`REVM_REFUSED_HARDFORKS` in ./revm.ts).
 *
 * BELOW, AT ISTANBUL: the 16 above is EIP-2028's, which shipped in Istanbul, and
 * it is hardcoded here rather than gated. Before Istanbul a non-zero calldata
 * byte costs 68, so on a pre-Istanbul fork this formula would UNDER-charge by 52
 * gas per non-zero byte — and an under-estimate is the direction that reaches a
 * user, since a client uses `eth_estimateGas` as the transaction's gas limit.
 * The term is NOT fork-gated on purpose: no admitted fork predates Istanbul and
 * none can, because a fork in neither of ./revm.ts's two tables is refused by the
 * "no revm spec is known" guard, so a gate would be arithmetic nothing can reach
 * (the same argument that keeps the EIP-7623 floor out). What stands in its place
 * is a measurement rather than a comment: the suite measures this term either
 * side of the Istanbul boundary (`petersburg` and `istanbul`), so re-admitting a
 * pre-Istanbul fork turns that measured disagreement into a failing build. If one
 * is ever re-admitted, gate this term the way the EIP-3860 one is gated, on the
 * `Common` — do not simply widen the tables.
 *
 * The fork gate on the EIP-3860 term is, by contrast, reachable and load-bearing:
 * it is what makes Berlin, London and Paris admissible, because `revm-wasm@0.3.1`
 * gates the term correctly and an unconditional term here would make
 * `eth_estimateGas` for a deployment differ BY ENGINE on those three forks (the
 * default engine's estimate moves with this formula; the revm engine's is revm's
 * own number, since it subtracts this intrinsic and the node adds it back).
 * Measured both ways, before and after the upstream fix, in
 * `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`; every
 * term of this formula measured fork by fork in
 * `docs/spikes/clause-b-covers-only-eip-3860-not-the-rest-of-the-formula/`.
 *
 * Either way: anyone moving the node's hardfork has to do this arithmetic first;
 * see `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`.
 */
import type {Common} from '@ethereumjs/common';

export function intrinsicGas(
	data: Uint8Array,
	isCreate: boolean,
	common: Common,
): bigint {
	let gas = 21_000n;
	// EIP-2028 (Istanbul): 16 per non-zero calldata byte, 4 per zero one. Hardcoded
	// rather than asked of `common`, unlike the EIP-3860 term below — see the
	// header: no fork this engine admits predates Istanbul, and none can.
	for (const b of data) gas += b === 0 ? 4n : 16n;
	if (isCreate) {
		gas += 32_000n;
		// EIP-3860 (Shanghai): 2 gas per 32-byte initcode word. Asked of the node's
		// own `Common` rather than gated on a fork name, so this charge lands
		// exactly where `@ethereumjs/vm`'s `runTx` charges it on the write path.
		if (common.isActivatedEIP(3860)) {
			gas += BigInt(Math.ceil(data.length / 32)) * 2n;
		}
	}
	return gas;
}
