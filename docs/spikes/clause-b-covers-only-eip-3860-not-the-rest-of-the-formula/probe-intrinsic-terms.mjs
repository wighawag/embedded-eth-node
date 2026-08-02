/**
 * probe-intrinsic-terms.mjs: for EVERY term `src/intrinsic-gas.ts` bakes in, who
 * charges what — the node, revm, or the protocol — at each hardfork either side
 * of the admitted range?
 *
 * WHY IT EXISTS. ADR 0008's clause (b) says everything the node computes about a
 * transaction must be what the PROTOCOL charges at that fork, judged by a
 * witness that is neither the node nor revm. The enforcement behind it measured
 * ONE term, EIP-3860's initcode word cost, while the shared formula also
 * hardcodes the 21000 base, the 32000 creation base and EIP-2028's 16/4 calldata
 * bytes. This probe measures them all, on the specs the engine admits AND on the
 * two below it, so the claim and the check can be made to say the same thing.
 *
 * HOW A TERM IS MEASURED. Each term is a DELTA between two probe transactions,
 * evaluated identically against three parties, so no constant from the formula
 * is restated here:
 *
 *   [1] the PROTOCOL — `@ethereumjs/tx`'s own intrinsic-gas arithmetic at that
 *       `Common`, which is the code `@ethereumjs/vm`'s `runTx` charges a mined
 *       transaction on this node, and which reads `@ethereumjs/common`'s tables
 *       (`txDataNonZeroGas` and friends, `isActivatedEIP(3860)`) underneath;
 *   [2] REVM — `totalGasSpent` for the same shapes, measured;
 *   [3] the NODE — the real exported `intrinsicGas()`, never a mirror of it.
 *
 * The shapes keep EXECUTION gas out of every answer: a CALL goes to a codeless
 * address and a CREATE deploys empty code, so either both sides of a delta run
 * the same three opcodes or neither runs anything.
 *
 * Run it against the repo's installed packages (no build step, no toolchain):
 *
 *   node docs/spikes/clause-b-covers-only-eip-3860-not-the-rest-of-the-formula/probe-intrinsic-terms.mjs
 *
 * Measurements taken 2026-08-02 against `revm-wasm@0.3.1`, `@ethereumjs/tx@10.x`
 * and `@ethereumjs/common@10.x` are recorded next to this file in
 * `measurements.md`; re-run it if any of the three moves.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Resolved through the package that depends on them, so this runs from the repo
// root with no install of its own.
const require = createRequire(
	new URL('../../../packages/embedded-eth-node/package.json', import.meta.url),
);
const {createRevm, MemoryStore} = await import(require.resolve('revm-wasm'));
const {wasmUrl} = await import(require.resolve('revm-wasm/wasm-url'));
const {Common, Mainnet} = await import(require.resolve('@ethereumjs/common'));
const {createLegacyTx} = await import(require.resolve('@ethereumjs/tx'));
// The NODE's own formula, imported FROM SOURCE rather than re-typed here: a copy
// of the arithmetic would measure the copy. Needs no build step — Node strips the
// types (its only import is a type-only one), which is why this probe wants Node
// 22.18+ / 24 like the rest of the repo's tooling.
const {intrinsicGas} = await import(
	new URL(
		'../../../packages/embedded-eth-node/src/intrinsic-gas.ts',
		import.meta.url,
	).href
);

const CHAIN_ID = 31337;
const FROM = new Uint8Array(20).fill(0x11);
/** A codeless address: a CALL to it executes nothing, so gas is intrinsic only. */
const SINK = '0x00000000000000000000000000000000ca11da7a';
const SINK_BYTES = Uint8Array.from(
	SINK.slice(2).match(/../g).map((b) => parseInt(b, 16)),
);

/** Initcode deploying EMPTY code: `PUSH1 0 / PUSH1 0 / RETURN`, padded to `len`. */
function initcodeOfLength(len) {
	const code = new Uint8Array(len);
	code.set([0x60, 0x00, 0x60, 0x00, 0xf3]);
	return code;
}
const NO_DATA = new Uint8Array();
const ONE_NON_ZERO_BYTE = Uint8Array.of(0xff);
const ONE_ZERO_BYTE = Uint8Array.of(0x00);
const ONE_INITCODE_WORD = initcodeOfLength(32);
const TWO_INITCODE_WORDS = initcodeOfLength(33);

/**
 * The terms, defined as arithmetic over a party's charge for a shape. The same
 * definitions the suite asserts, in
 * `packages/embedded-eth-node/test/helpers/revm-engine.ts`.
 */
const TERMS = [
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
		// The extra byte crossing the word boundary is a ZERO calldata byte, whose
		// cost is the term two rows up — subtracted as MEASURED, not as the number 4.
		name: 'initcode word (EIP-3860)',
		of: (g) =>
			g(TWO_INITCODE_WORDS, true) -
			g(ONE_INITCODE_WORD, true) -
			(g(ONE_ZERO_BYTE, false) - g(NO_DATA, false)),
	},
];

/** hardfork (ethereumjs) -> spec (revm), from `petersburg` up to `cancun`. */
const FORKS = {
	petersburg: 'PETERSBURG',
	istanbul: 'ISTANBUL',
	berlin: 'BERLIN',
	london: 'LONDON',
	paris: 'MERGE',
	shanghai: 'SHANGHAI',
	cancun: 'CANCUN',
};
/** The forks `REVM_SPEC_BY_HARDFORK` admits today, for the report's last column. */
const ADMITTED = ['berlin', 'london', 'paris', 'shanghai', 'cancun'];

const revm = await createRevm({
	wasm: readFileSync(fileURLToPath(wasmUrl)),
	state: new MemoryStore(),
});
const block = {
	number: 1n,
	timestamp: 1_700_000_000n,
	gasLimit: 30_000_000n,
	coinbase: new Uint8Array(20),
	baseFeePerGas: 7_000_000_000n,
	prevRandao: new Uint8Array(32),
};
const switches = {
	value: 0n,
	gasLimit: 1_000_000n,
	chainId: BigInt(CHAIN_ID),
	block,
	disableBaseFee: true,
	disableBlockGasLimit: true,
	disableEip3607: true,
	returnState: false,
	commit: false,
	checkNonce: false,
};

/** [2] revm's charge, measured. A rejected probe is an error, never a number. */
const revmCharge = (spec) => (data, isCreate) => {
	const o = isCreate
		? revm.create({...switches, from: FROM, data, spec})
		: revm.call({...switches, from: FROM, to: SINK_BYTES, data, spec});
	if (!o.success) {
		throw new Error(`revm rejected a probe on ${spec}: ${o.error ?? o.status}`);
	}
	return o.totalGasSpent;
};
/** [1] the protocol's charge: what `runTx` would charge the same transaction. */
const protocolCharge = (common) => (data, isCreate) =>
	createLegacyTx(
		{gasLimit: 1_000_000n, data, to: isCreate ? undefined : SINK},
		{common},
	).getIntrinsicGas();
/** [3] the node's charge, from the shipped formula. */
const nodeCharge = (common) => (data, isCreate) =>
	intrinsicGas(data, isCreate, common);

const rows = [];
for (const [hardfork, spec] of Object.entries(FORKS)) {
	const common = new Common({
		chain: {...Mainnet, chainId: CHAIN_ID, name: 'embedded-eth-node'},
		hardfork,
	});
	for (const term of TERMS) {
		const protocol = term.of(protocolCharge(common));
		const revmValue = term.of(revmCharge(spec));
		const node = term.of(nodeCharge(common));
		rows.push({
			hardfork,
			spec,
			term: term.name,
			protocol,
			revm: revmValue,
			node,
			agree: protocol === revmValue && protocol === node,
			admitted: ADMITTED.includes(hardfork),
		});
	}
}

const w = (s, n) => String(s).padEnd(n);
console.log(
	`\n${w('hardfork', 12)}${w('term', 36)}${w('protocol', 10)}${w('revm', 10)}${w('node', 10)}verdict`,
);
for (const r of rows) {
	console.log(
		w(r.hardfork, 12) +
			w(r.term, 36) +
			w(r.protocol, 10) +
			w(r.revm, 10) +
			w(r.node, 10) +
			(r.agree ? 'agree' : 'DISAGREE') +
			(r.admitted ? '' : '   (not admitted)'),
	);
}

const disagreements = rows.filter((r) => !r.agree);
console.log(
	`\n${disagreements.length} disagreement(s), ` +
		`${disagreements.filter((r) => r.admitted).length} of them at an ADMITTED fork:`,
);
for (const r of disagreements) {
	console.log(
		`  ${r.hardfork}/${r.term}: protocol ${r.protocol}, revm ${r.revm}, ` +
			`node ${r.node} (node is ${r.node > r.protocol ? 'over' : 'under'}-charging ` +
			`by ${r.node > r.protocol ? r.node - r.protocol : r.protocol - r.node})`,
	);
}
console.log(
	'\nEIP-3860 activation, as `intrinsic-gas.ts` asks it (common.isActivatedEIP):',
);
for (const hardfork of Object.keys(FORKS)) {
	const common = new Common({
		chain: {...Mainnet, chainId: CHAIN_ID, name: 'embedded-eth-node'},
		hardfork,
	});
	console.log(`  ${w(hardfork, 12)}${common.isActivatedEIP(3860)}`);
}
