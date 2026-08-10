/**
 * probe-validation-vs-revert.mjs: how a revm VALIDATION rejection differs, in the
 * outcome it hands back, from an execution REVERT or HALT — measured, because the
 * fix that stops `embedded-eth-node/revm` forwarding revm's error text as
 * `eth_call` return data has to key off that difference and not off a substring
 * of the message.
 *
 * WHY IT EXISTS. `revm-wasm` reuses the return-data slot of the outcome blob to
 * carry the `InvalidTransaction` variant's text when a transaction is rejected
 * BEFORE execution, and `src/revm.ts` used to pass `outcome.returnData` through
 * verbatim, so `node.ts` threw `RpcError(3, 'execution reverted', <ascii bytes>)`
 * where the default `@ethereumjs/evm` engine returns `0x`. The question this
 * probe answers is whether the two cases are structurally distinguishable (they
 * are: `status`, plus `error` being defined only for a validation error), so the
 * engine can drop the bytes for a rejection while a real revert keeps its own.
 *
 * Run it against the repo's installed `revm-wasm` (no build step, no toolchain):
 *
 *   node docs/spikes/stop-forwarding-revms-validation-error-text-as-eth-call-return-data/probe-validation-vs-revert.mjs
 *
 * Measurements taken 2026-08-10 against `revm-wasm@0.3.1` are recorded next to
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
const hex = (bytes) => '0x' + Buffer.from(bytes).toString('hex');
const ascii = (bytes) =>
	Buffer.from(bytes).toString('utf8').replace(/[^\x20-\x7e]/g, '.');

/** Runtime codes, one per outcome class this probe wants to produce. */
const CODES = {
	// PUSH1 2a, PUSH0, MSTORE, PUSH1 20, PUSH0, RETURN — returns 42.
	returns42: '602a5f5260205ff3',
	// PUSH1 ff, PUSH0, MSTORE8, PUSH1 01, PUSH0, REVERT — reverts with one byte.
	revertsWithData: '60ff5f5360015ffd',
	// PUSH0, PUSH0, REVERT — reverts with nothing.
	revertsBare: '5f5ffd',
	// INVALID — halts, consuming all gas.
	halts: 'fe',
};

const store = new MemoryStore();
/** Address per code, deployed into the store. */
const CALLEE = {};
let n = 0;
for (const [name, code] of Object.entries(CODES)) {
	const bytes = Uint8Array.from(Buffer.from(code, 'hex'));
	const codeHash = keccak_256(bytes);
	const address = addr(
		'0x00000000000000000000000000000000000000' + (0xa0 + n++).toString(16),
	);
	store.setCode(codeHash, bytes);
	store.setAccount(address, {balance: 0n, nonce: 0n, codeHash});
	CALLEE[name] = address;
}

const FUNDED = addr('0x00000000000000000000000000000000000f0000');
const FUNDED_BALANCE = 10n ** 18n;
store.setAccount(FUNDED, {
	balance: FUNDED_BALANCE,
	nonce: 0n,
	codeHash: KECCAK_EMPTY,
});

const revm = await createRevm({wasm, state: store});

// The node's own read shape (src/revm.ts `call`): a REAL base fee, no gas price,
// the three simulation switches on, `returnState: false`.
const block = {
	number: 1n,
	timestamp: 1_700_000_000n,
	gasLimit: 30_000_000n,
	coinbase: addr('0x00000000000000000000000000000000c0173a5e'),
	baseFeePerGas: 7_000_000_000n,
	prevRandao: new Uint8Array(32).fill(0x5e),
};

function read({to, value = 0n, gasLimit = 30_021_000n}) {
	return revm.call({
		from: FUNDED,
		to,
		data: new Uint8Array(),
		value,
		gasLimit,
		spec: 'CANCUN',
		chainId: 1n,
		block,
		disableBaseFee: true,
		disableBlockGasLimit: true,
		disableEip3607: true,
		returnState: false,
	});
}

const cases = [
	['success', {to: CALLEE.returns42}],
	['revert WITH data', {to: CALLEE.revertsWithData}],
	['revert with NO data', {to: CALLEE.revertsBare}],
	['halt (invalid opcode)', {to: CALLEE.halts}],
	['halt (out of gas)', {to: CALLEE.returns42, gasLimit: 21_002n}],
	[
		'validation: value > balance',
		{to: CALLEE.returns42, value: FUNDED_BALANCE + 1n},
	],
	[
		'validation: value > balance, callee reverts with data',
		{to: CALLEE.revertsWithData, value: FUNDED_BALANCE + 1n},
	],
	// The gas limit is BELOW the intrinsic cost, which revm rejects before it
	// runs anything: a second validation variant, to show the shape is the
	// status and not one message.
	['validation: gas below intrinsic', {to: CALLEE.returns42, gasLimit: 20_999n}],
];

console.log(
	'\ncase'.padEnd(52) +
		'status'.padEnd(18) +
		'totalGasSpent'.padEnd(15) +
		'error defined  returnData',
);
for (const [label, request] of cases) {
	const o = read(request);
	console.log(
		('  ' + label).padEnd(52) +
			o.status.padEnd(18) +
			String(o.totalGasSpent).padEnd(15) +
			String(o.error !== undefined).padEnd(15) +
			`${hex(o.returnData)} (${ascii(o.returnData)})`,
	);
}

// The discriminator itself, stated as the assertion the engine now makes.
const rejected = read({to: CALLEE.returns42, value: FUNDED_BALANCE + 1n});
const reverted = read({to: CALLEE.revertsWithData});
console.log('\ndiscriminator');
console.log(
	`  rejection: status === 'validation-error' -> ${rejected.status === 'validation-error'}, ` +
		`error === utf8(returnData) -> ${rejected.error === Buffer.from(rejected.returnData).toString('utf8')}`,
);
console.log(
	`  revert:    status === 'revert' -> ${reverted.status === 'revert'}, ` +
		`error defined -> ${reverted.error !== undefined}`,
);
