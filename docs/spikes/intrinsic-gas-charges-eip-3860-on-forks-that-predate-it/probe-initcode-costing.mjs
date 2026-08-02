/**
 * probe-initcode-costing.mjs: on the PRE-SHANGHAI hardforks the revm engine
 * still admits, who charges the EIP-3860 initcode word cost — the node, revm,
 * or the protocol?
 *
 * WHY IT EXISTS. `packages/embedded-eth-node/src/intrinsic-gas.ts` adds
 * `ceil(len/32) * 2` to every CREATE with no hardfork gate, and
 * `REVM_SPEC_BY_HARDFORK` admitted `berlin`, `london` and `paris` — three forks
 * that predate EIP-3860 (Shanghai). Section 3 of
 * `docs/spikes/prague-intrinsic-gas-floor-or-refuse/measurements.md` noticed the
 * node charges it there and set it aside, on the grounds that revm over-charges
 * identically so the two agree. "We agree, therefore we are fine" is exactly the
 * claim worth re-measuring, because agreement between two parties says nothing
 * about either one agreeing with the PROTOCOL — so this probe measures three
 * independent answers to the same question instead of two:
 *
 *   [1] revm's, by DELTA across a word boundary, so execution gas cancels out;
 *   [2] revm's again, by decomposing one CREATE's `totalGasSpent` in full;
 *   [3] the protocol's, via `@ethereumjs/common`'s EIP activation table and
 *       `@ethereumjs/tx`'s own intrinsic-gas arithmetic — the SAME code the
 *       node's transaction path (`@ethereumjs/vm`'s `runTx`) uses, which makes
 *       it a witness the node already trusts elsewhere rather than a formula
 *       re-typed for this script.
 *
 * Run it against the repo's installed packages (no build step, no toolchain):
 *
 *   node docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/probe-initcode-costing.mjs
 *
 * Measurements taken 2026-08-02 against `revm-wasm@0.3.0` are recorded next to
 * this file in `measurements.md`; re-run it if either package moves.
 *
 * NOTE ON THE RUNNING COMMENTARY BELOW, which was written against `0.3.0`:
 * `revm-wasm@0.3.1` FIXED the artifact's half of this (it now gates EIP-3860 by
 * spec), which inverted the conclusion in section [4] — the fork gate in
 * `src/intrinsic-gas.ts` is what makes the two engines AGREE now, and the node
 * ships it. The probe itself is unchanged and still prints the truth; only the
 * prose in [4] describes a world that ended. See sections 6 and 7 of
 * `measurements.md`.
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

const wasm = readFileSync(fileURLToPath(wasmUrl));
const addr = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

const FROM = addr('0x00000000000000000000000000000000000f0000');

const revm = await createRevm({wasm, state: new MemoryStore()});

const block = {
	number: 1n,
	timestamp: 1_700_000_000n,
	gasLimit: 30_000_000n,
	coinbase: addr('0x00000000000000000000000000000000c0173a5e'),
	baseFeePerGas: 7_000_000_000n,
	prevRandao: new Uint8Array(32).fill(0x5e),
};

/**
 * The node's formula, verbatim from `src/intrinsic-gas.ts` — including the
 * UNGATED EIP-3860 term this probe exists to judge.
 */
function nodeIntrinsicGas(data, isCreate) {
	let gas = 21_000n;
	for (const b of data) gas += b === 0 ? 4n : 16n;
	if (isCreate) gas += 32_000n + BigInt(Math.ceil(data.length / 32)) * 2n;
	return gas;
}

/** The same formula WITHOUT the EIP-3860 term: the pre-Shanghai protocol cost. */
function preShanghaiIntrinsicGas(data, isCreate) {
	let gas = 21_000n;
	for (const b of data) gas += b === 0 ? 4n : 16n;
	if (isCreate) gas += 32_000n;
	return gas;
}

/**
 * Initcode that deploys EMPTY code: `PUSH1 0 / PUSH1 0 / RETURN`, zero-padded to
 * `len`. Execution is 3 + 3 + 0 = 6 gas at every spec (no memory is touched, and
 * an empty deposit costs nothing), so it does not move when `len` does — which
 * is what makes the delta in [1] pure intrinsic gas.
 */
function initcode(len) {
	const code = new Uint8Array(len);
	code.set([0x60, 0x00, 0x60, 0x00, 0xf3]);
	return code;
}

const EXECUTION_GAS = 6n;

function create(spec, data, gasLimit = 1_000_000n) {
	return revm.create({
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
		commit: false,
		checkNonce: false,
	});
}

const SPECS = [
	['berlin', 'BERLIN'],
	['london', 'LONDON'],
	['paris', 'MERGE'],
	['shanghai', 'SHANGHAI'],
	['cancun', 'CANCUN'],
];

// ---------------------------------------------------------------------------
// [1] revm's answer, by DELTA across a word boundary.
//
// 32 bytes of initcode is 1 word, 33 bytes is 2. The extra byte is a ZERO
// calldata byte (4 gas), so the delta is 4 if EIP-3860 is NOT charged and 6 if
// it is. Execution gas is identical on both sides and cancels, so this needs no
// assumption about what the code costs to run.
// ---------------------------------------------------------------------------
console.log('\n[1] revm, by DELTA across a word boundary (32 -> 33 bytes)');
console.log(
	'    4 = the extra zero calldata byte only (no EIP-3860); 6 = plus one initcode word',
);
const ONE_WORD = initcode(32);
const TWO_WORDS = initcode(33);
for (const [hardfork, spec] of SPECS) {
	const a = create(spec, ONE_WORD);
	const b = create(spec, TWO_WORDS);
	const delta = b.totalGasSpent - a.totalGasSpent;
	console.log(
		'  ' + `${hardfork} (${spec})`.padEnd(22),
		`total(32) ${a.totalGasSpent}`.padEnd(18),
		`total(33) ${b.totalGasSpent}`.padEnd(18),
		`delta ${delta}`.padEnd(10),
		delta === 6n ? 'EIP-3860 CHARGED' : 'no EIP-3860',
	);
}

// ---------------------------------------------------------------------------
// [2] revm's answer again, by decomposing one CREATE in full.
// ---------------------------------------------------------------------------
console.log('\n[2] revm, by decomposing one 64-byte CREATE (2 initcode words)');
const INIT = initcode(64);
console.log(
	`    node charges ${nodeIntrinsicGas(INIT, true)}, pre-Shanghai protocol charges ${preShanghaiIntrinsicGas(INIT, true)}, execution is ${EXECUTION_GAS}`,
);
for (const [hardfork, spec] of SPECS) {
	const o = create(spec, INIT);
	const revmIntrinsic = o.totalGasSpent - EXECUTION_GAS;
	console.log(
		'  ' + `${hardfork} (${spec})`.padEnd(22),
		`total ${o.totalGasSpent}`.padEnd(14),
		`revm intrinsic ${revmIntrinsic}`.padEnd(24),
		`vs node ${revmIntrinsic - nodeIntrinsicGas(INIT, true)}`.padEnd(14),
		`vs pre-Shanghai protocol +${revmIntrinsic - preShanghaiIntrinsicGas(INIT, true)}`,
	);
}

// ---------------------------------------------------------------------------
// [3] the PROTOCOL's answer, from a witness that is neither the node's formula
//     nor revm: `@ethereumjs/common`'s EIP activation table, and the intrinsic
//     gas `@ethereumjs/tx` computes — which is what `@ethereumjs/vm`'s `runTx`
//     charges a real transaction on this very node.
// ---------------------------------------------------------------------------
console.log(
	'\n[3] the protocol, per @ethereumjs/common + @ethereumjs/tx (what runTx charges)',
);
for (const [hardfork] of SPECS) {
	const common = new Common({chain: Mainnet, hardfork});
	const tx = createLegacyTx({gasLimit: 1_000_000n, data: INIT}, {common});
	const intrinsic = tx.getIntrinsicGas();
	console.log(
		'  ' + hardfork.padEnd(22),
		`EIP-3860 active: ${String(common.isActivatedEIP(3860)).padEnd(5)}`,
		`runTx intrinsic ${intrinsic}`.padEnd(24),
		`vs node ${intrinsic - nodeIntrinsicGas(INIT, true)}`,
	);
}

// ---------------------------------------------------------------------------
// [4] the consequence for `eth_estimateGas`, which is the number that reaches a
//     user: the node ADDS its intrinsic to what an engine reports, and an engine
//     reports EXECUTION gas only. On the default `@ethereumjs/evm` engine
//     `runCall` charges no intrinsic, so the estimate is
//     `execution + nodeIntrinsic`; on revm the engine SUBTRACTS the same
//     intrinsic from `totalGasSpent` and the node adds it back, so the estimate
//     is revm's `totalGasSpent` WHATEVER the node's formula says.
//
//     Which is why the last column matters. Against `0.3.0` it said: gating the
//     EIP-3860 term in `intrinsic-gas.ts` moves the DEFAULT engine's estimate and
//     cannot move revm's, so the gate converts an agreed wrong number into a
//     cross-engine DISAGREEMENT. Against `0.3.1` the same column says the
//     opposite — revm gates the term itself, so the ungated node is the one
//     splitting the engines and the gate is what restores agreement. The node
//     now gates it (on its `Common`, see `src/intrinsic-gas.ts`), so on a current
//     checkout the `default` column below is the UNGATED counterfactual, printed
//     to keep this comparison honest rather than to describe the shipped code.
// ---------------------------------------------------------------------------
console.log('\n[4] what eth_estimateGas would return for that CREATE, per engine');
for (const [hardfork, spec] of SPECS) {
	const o = create(spec, INIT);
	const active = new Common({chain: Mainnet, hardfork}).isActivatedEIP(3860);
	const onDefault = EXECUTION_GAS + nodeIntrinsicGas(INIT, true);
	const onRevm = o.totalGasSpent;
	const protocolTruth =
		EXECUTION_GAS +
		(active ? nodeIntrinsicGas(INIT, true) : preShanghaiIntrinsicGas(INIT, true));
	// The counterfactual: the same estimate if `intrinsicGas()` gated the EIP-3860
	// term on the fork. revm's number does not move, because the engine subtracts
	// the node's intrinsic and the node adds it straight back.
	const gatedDefault =
		EXECUTION_GAS +
		(active ? nodeIntrinsicGas(INIT, true) : preShanghaiIntrinsicGas(INIT, true));
	console.log(
		'  ' + `${hardfork} (${spec})`.padEnd(22),
		`default ${onDefault}`.padEnd(16),
		`revm ${onRevm}`.padEnd(13),
		`protocol ${protocolTruth}`.padEnd(17),
		(onDefault === onRevm
			? onRevm === protocolTruth
				? 'agree, and with the protocol'
				: 'agree, BOTH WRONG vs the protocol'
			: 'ENGINES DISAGREE'
		).padEnd(34),
		`| if gated: default ${gatedDefault} vs revm ${onRevm} -> ` +
			(gatedDefault === onRevm ? 'still agree' : 'ENGINES DISAGREE'),
	);
}

// ---------------------------------------------------------------------------
// [5] how WIDE is it? A mis-costing that turned out to be "this artifact ignores
//     the spec" would be a much bigger finding than one confined to the
//     pre-execution intrinsic-gas computation, and the two call for different
//     resolutions — so measure it rather than assume. Each probe runs ONE
//     fork-gated opcode and then returns empty code; `halt` is revm rejecting the
//     opcode as unknown at that spec, `ok` is it running.
// ---------------------------------------------------------------------------
console.log('\n[5] opcode gating, for scope: does this artifact honour the spec elsewhere?');
const OPCODE_PROBES = [
	['CHAINID (0x46, Istanbul)', [0x46]],
	['BASEFEE (0x48, London)', [0x48]],
	['PUSH0 (0x5f, Shanghai)', [0x5f]],
	['TLOAD (0x5c, Cancun)', [0x60, 0x00, 0x5c]],
];
for (const [label, op] of OPCODE_PROBES) {
	// ...the opcode, POP its result, then PUSH1 0 / PUSH1 0 / RETURN.
	const code = Uint8Array.from([...op, 0x50, 0x60, 0x00, 0x60, 0x00, 0xf3]);
	const verdicts = SPECS.map(([, spec]) => {
		const o = create(spec, code);
		return `${spec}:${o.success ? 'ok' : o.status}`;
	});
	console.log('  ' + label.padEnd(28), verdicts.join('  '));
}

console.log('');
