/**
 * probe-hardfork-costing.mjs: for each hardfork the revm engine could admit,
 * does what the NODE computes about a transaction still match what revm
 * ENFORCES?
 *
 * WHY IT EXISTS. `embedded-eth-node/revm` maps ethereumjs hardfork names onto
 * revm specs, and the node's shared intrinsic-gas arithmetic
 * (`packages/embedded-eth-node/src/intrinsic-gas.ts`) implements the pre-Prague
 * formula only. `eth_estimateGas` returns `executionGas + intrinsic`, and a
 * client uses that number as the transaction's gas LIMIT — so a fork where revm
 * demands MORE than the node computed is not a rounding difference, it is a
 * transaction that runs out of gas in the user's face. This probe measures the
 * two ways that happens (EIP-7623's calldata floor, EIP-7825's gas-limit cap)
 * rather than reasoning about them.
 *
 * Run it against the repo's installed `revm-wasm` (no build step, no toolchain):
 *
 *   node docs/spikes/prague-intrinsic-gas-floor-or-refuse/probe-hardfork-costing.mjs
 *
 * Measurements taken 2026-08-02 against `revm-wasm@0.3.0` are recorded next to
 * this file in `measurements.md`; re-run it if the package moves.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Resolved through the package that depends on it, so this runs from the repo
// root with no install of its own.
const require = createRequire(
	new URL('../../../packages/embedded-eth-node/package.json', import.meta.url),
);
const {createRevm, MemoryStore} = await import(require.resolve('revm-wasm'));
const {wasmUrl} = await import(require.resolve('revm-wasm/wasm-url'));

const wasm = readFileSync(fileURLToPath(wasmUrl));
const addr = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

const FROM = addr('0x00000000000000000000000000000000000f0000');
// Codeless, so execution gas is zero and the transaction's cost is calldata and
// nothing else — the shape EIP-7623's floor was written for.
const TO = addr('0x00000000000000000000000000000000ca11da7a');

const revm = await createRevm({wasm, state: new MemoryStore()});

const block = {
	number: 1n,
	timestamp: 1_700_000_000n,
	gasLimit: 30_000_000n,
	coinbase: addr('0x00000000000000000000000000000000c0173a5e'),
	baseFeePerGas: 7_000_000_000n,
	prevRandao: new Uint8Array(32).fill(0x5e),
};

/** The node's formula, verbatim from `src/intrinsic-gas.ts`. */
function intrinsicGas(data, isCreate) {
	let gas = 21_000n;
	for (const b of data) gas += b === 0 ? 4n : 16n;
	if (isCreate) gas += 32_000n + BigInt(Math.ceil(data.length / 32)) * 2n;
	return gas;
}

/** EIP-7623's floor, for the report only — the node does NOT compute this. */
function calldataFloor(data) {
	let tokens = 0n;
	for (const b of data) tokens += b === 0 ? 1n : 4n;
	return 21_000n + 10n * tokens;
}

/** The engine's own budget arithmetic: revm charges intrinsic out of the limit. */
const READ_BUDGET = 30_000_000n;

function call({spec, data, gasLimit, isCreate = false}) {
	const common = {
		from: FROM,
		data,
		value: 0n,
		gasLimit,
		spec,
		chainId: 1n,
		block,
		// The read path's simulation switches, as `src/revm.ts` sets them.
		disableBaseFee: true,
		disableBlockGasLimit: true,
		disableEip3607: true,
		returnState: false,
	};
	return isCreate
		? revm.create({...common, commit: false, checkNonce: false})
		: revm.call({...common, to: TO});
}

function report(label, outcome) {
	console.log(
		'  ' + label.padEnd(30),
		outcome.status.padEnd(18),
		('total ' + outcome.totalGasSpent).padEnd(14),
		outcome.error ?? '',
	);
}

const SPECS = [
	'BERLIN',
	'LONDON',
	'MERGE',
	'SHANGHAI',
	'CANCUN',
	'PRAGUE',
	'OSAKA',
];
const NON_ZERO_100 = new Uint8Array(100).fill(0xff);

console.log('\n[1] the node\'s estimate, judged as a gas LIMIT by revm');
console.log(
	`  100 non-zero calldata bytes: node intrinsic ${intrinsicGas(NON_ZERO_100, false)}, EIP-7623 floor ${calldataFloor(NON_ZERO_100)}`,
);
for (const spec of SPECS) {
	report(
		spec,
		call({
			spec,
			data: NON_ZERO_100,
			gasLimit: intrinsicGas(NON_ZERO_100, false),
		}),
	);
}

console.log('\n[2] the same call given a LARGE limit: what does revm charge?');
for (const spec of SPECS) {
	const o = call({spec, data: NON_ZERO_100, gasLimit: 1_000_000n});
	console.log(
		'  ' + spec.padEnd(30),
		('totalGasSpent ' + o.totalGasSpent).padEnd(22),
		'gasUsed ' + o.gasUsed,
	);
}

console.log('\n[3] the node\'s DEFAULT read budget (30M + intrinsic), empty calldata');
for (const spec of SPECS) {
	report(
		spec,
		call({
			spec,
			data: new Uint8Array(),
			gasLimit: READ_BUDGET + intrinsicGas(new Uint8Array(), false),
		}),
	);
}

console.log('\n[4] a CREATE-shaped read: does the node\'s EIP-3860 term match?');
// PUSH1 0, PUSH1 0, RETURN, zero-padded to 64 bytes (2 initcode words).
const INIT = new Uint8Array(64);
INIT.set([0x60, 0x00, 0x60, 0x00, 0xf3]);
for (const spec of SPECS) {
	const o = call({spec, data: INIT, gasLimit: 1_000_000n, isCreate: true});
	console.log(
		'  ' + spec.padEnd(30),
		o.status.padEnd(18),
		('total ' + o.totalGasSpent).padEnd(14),
		'total - node intrinsic = ' +
			(o.status === 'validation-error'
				? 'n/a'
				: o.totalGasSpent - intrinsicGas(INIT, true)),
	);
}
