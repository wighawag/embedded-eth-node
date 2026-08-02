/**
 * probe-simulation-switches.mjs: what each `revm-wasm` simulation switch ACTUALLY
 * buys on the read path, measured rather than reasoned about.
 *
 * WHY IT EXISTS. `embedded-eth-node/revm` serves `eth_call` by turning off the
 * TRANSACTION validity rules a read is not subject to. The question this probe
 * answers is which of them are load-bearing, because one of them
 * (`disableBalanceCheck`) also fabricates the caller's balance, and a read that
 * answers a transfer the chain could never make is exactly the class of lie the
 * zeroed base fee was deleted for.
 *
 * Run it against the repo's installed `revm-wasm` (no build step, no toolchain):
 *
 *   node docs/spikes/revm-wasm-upgrade-honest-block-environment/probe-simulation-switches.mjs
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
const {createRevm, MemoryStore, KECCAK_EMPTY} = await import(
	require.resolve('revm-wasm')
);
const {wasmUrl} = await import(require.resolve('revm-wasm/wasm-url'));
const {keccak_256} = await import(require.resolve('@noble/hashes/sha3.js'));

const wasm = readFileSync(fileURLToPath(wasmUrl));
const addr = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

// Runtime code returning 42: PUSH1 2a, PUSH0, MSTORE, PUSH1 20, PUSH0, RETURN.
const CODE = Uint8Array.from(Buffer.from('602a5f5260205ff3', 'hex'));
const CODE_HASH = keccak_256(CODE);
const TO = addr('0x00000000000000000000000000000000000000aa');
const FUNDED = addr('0x00000000000000000000000000000000000f0000');
const UNFUNDED = addr('0x00000000000000000000000000000000dead0001');
const FUNDED_BALANCE = 10n ** 24n;

const store = new MemoryStore();
store.setCode(CODE_HASH, CODE);
store.setAccount(TO, {balance: 0n, nonce: 0n, codeHash: CODE_HASH});
store.setAccount(FUNDED, {
	balance: FUNDED_BALANCE,
	nonce: 0n,
	codeHash: KECCAK_EMPTY,
});
store.setAccount(UNFUNDED, {balance: 0n, nonce: 0n, codeHash: KECCAK_EMPTY});

const revm = await createRevm({wasm, state: store});

// The node's own read shape: a REAL base fee, and NO gas price (the engine's
// `ReadCallRequest` carries none, so revm sees 0).
const block = {
	number: 1n,
	timestamp: 1_700_000_000n,
	gasLimit: 30_000_000n,
	coinbase: addr('0x00000000000000000000000000000000c0173a5e'),
	baseFeePerGas: 7_000_000_000n,
	prevRandao: new Uint8Array(32).fill(0x5e),
};

function call({from, value, disableBaseFee = true, disableBalanceCheck}) {
	return revm.call({
		from,
		to: TO,
		data: new Uint8Array(),
		value,
		gasLimit: 30_021_000n,
		spec: 'CANCUN',
		chainId: 1n,
		block,
		disableBaseFee,
		disableBalanceCheck,
		disableBlockGasLimit: true,
		disableEip3607: true,
		returnState: false,
	});
}

function report(label, outcome) {
	console.log(
		'  ' + label.padEnd(34),
		outcome.status.padEnd(18),
		outcome.error ?? '',
	);
}

console.log('\n[1] is `disableBaseFee` load-bearing? (unfunded, value 0)');
for (const disableBaseFee of [false, true]) {
	report(
		`disableBaseFee: ${disableBaseFee}`,
		call({
			from: UNFUNDED,
			value: 0n,
			disableBaseFee,
			disableBalanceCheck: false,
		}),
	);
}

console.log('\n[2] what does `disableBalanceCheck` change?');
for (const disableBalanceCheck of [false, true]) {
	console.log(`  --- disableBalanceCheck: ${disableBalanceCheck} ---`);
	const cases = [
		['unfunded, value 0', UNFUNDED, 0n],
		['unfunded, value 1 wei', UNFUNDED, 1n],
		['funded, value 0', FUNDED, 0n],
		['funded, value 1 wei', FUNDED, 1n],
		['funded, value above balance', FUNDED, FUNDED_BALANCE + 1n],
		['caller holding code, value 0', TO, 0n],
	];
	for (const [label, from, value] of cases) {
		report(label, call({from, value, disableBalanceCheck}));
	}
}
