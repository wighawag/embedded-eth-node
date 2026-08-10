/**
 * probe-host-callbacks.mjs: how often crossing the wasm boundary actually
 * happens, measured HERE rather than quoted from the engine's own repo.
 *
 * WHY IT EXISTS. `docs/adr/0010-revm-reads-and-writes-through-host-callbacks.md`
 * claims that keeping state on the JS side is AFFORDABLE because the boundary is
 * crossed once per COLD state access — revm's journal answers everything warm
 * from inside wasm. That claim arrived as three numbers measured on the engine
 * side, with nothing in this repo able to reproduce them, and this repo has just
 * spent two changes repairing citations that did not resolve. So the claim is
 * re-measured here, from the two directions that can each be wrong on their own:
 *
 *   1. COUNT the host callbacks a contract's SLOADs cause, by wrapping the store;
 *   2. read the GAS, which is the protocol's own count of cold versus warm
 *      accesses and cannot be fudged by an instrumented store.
 *
 * If the two agree — one callback per cold access, and the gas difference is
 * exactly the EIP-2929 cold/warm delta over the same number of slots — then the
 * cache the affordability argument rests on is real.
 *
 * Section 3 additionally measures the WRITE side, which the ADR's cost claim also
 * depends on: a committing transaction must write back only what it touched.
 *
 * Section 4 pins the two-gas-field trap the receipt mapping turns on: revm's
 * outcome carries BOTH `gasUsed` (net of refunds) and `totalGasSpent` (gross), the
 * read path takes the gross one, and a receipt needs the net one.
 *
 * Run it against the repo's installed `revm-wasm` (no build step, no toolchain):
 *
 *   node docs/spikes/revm-executes-the-first-transaction-with-commit/probe-host-callbacks.mjs
 *
 * Measurements taken 2026-08-10 against `revm-wasm@0.3.1` are recorded next to
 * this file in `measurements.md`; re-run it if the package moves. It exits
 * non-zero if any of its own checks fail. Spike code: nothing under `packages/`
 * imports it.
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
const hex = (b) => Buffer.from(b).toString('hex');

const SENDER = addr('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const CONTRACT = addr('0x00000000000000000000000000000000000000cc');
const SINK = addr('0x00000000000000000000000000000000000000aa');
const COINBASE = addr('0x00000000000000000000000000000000c0173a5e');
const BLOCK = {
	number: 1n,
	timestamp: 1_700_000_000n,
	gasLimit: 30_000_000n,
	coinbase: COINBASE,
	baseFeePerGas: 1_000_000_000n,
};
const FEES = {maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n};

const failures = [];
function check(label, got, want) {
	const ok = String(got) === String(want);
	console.log(`  ${ok ? 'OK ' : 'XX '}${label}: ${got}${ok ? '' : ` (want ${want})`}`);
	if (!ok) failures.push(`${label}: got ${got}, want ${want}`);
}

/**
 * A store that COUNTS every callback and forwards to a real one.
 *
 * Deliberately a wrapper rather than a reimplementation: counting is the whole
 * measurement, so the thing being counted has to be the same store the execution
 * would have used anyway.
 */
function countingStore(inner) {
	const counts = {
		getAccount: 0,
		getStorage: 0,
		getCode: 0,
		getBlockHash: 0,
		setAccount: 0,
		setCode: 0,
		setStorage: 0,
		clearStorage: 0,
		removeAccount: 0,
	};
	const wrote = {accounts: [], slots: []};
	return {
		counts,
		wrote,
		store: {
			getAccount: (a) => (counts.getAccount++, inner.getAccount(a)),
			getStorage: (a, s) => (counts.getStorage++, inner.getStorage(a, s)),
			getCode: (h) => (counts.getCode++, inner.getCode(h)),
			getBlockHash: (n) => (counts.getBlockHash++, inner.getBlockHash(n)),
			setAccount: (a, acc) => {
				counts.setAccount++;
				wrote.accounts.push(hex(a));
				inner.setAccount(a, acc);
			},
			setCode: (h, c) => (counts.setCode++, inner.setCode(h, c)),
			setStorage: (a, s, v) => {
				counts.setStorage++;
				wrote.slots.push(`${hex(a).slice(-4)}/${hex(s).slice(-4)}`);
				inner.setStorage(a, s, v);
			},
			clearStorage: (a) => (counts.clearStorage++, inner.clearStorage(a)),
			removeAccount: (a) => (counts.removeAccount++, inner.removeAccount(a)),
		},
	};
}

/**
 * Runtime code that SLOADs N times, either the SAME slot every time or a
 * DIFFERENT one, and does nothing else.
 *
 * Hand-assembled because the point is to isolate ONE opcode: a Solidity loop
 * would add its own arithmetic and memory to every iteration, and the gas delta
 * this probe reads has to be attributable to the accesses alone.
 *
 *   PUSH2 n            ; i = n
 *   JUMPDEST           ; loop (pc 3)
 *   <slot> SLOAD POP   ; PUSH0 for the same slot, DUP1 for slot = i
 *   PUSH1 01 SWAP1 SUB ; i = i - 1
 *   DUP1 PUSH1 03 JUMPI
 *   STOP
 */
function sloadLoop(n, mode) {
	const slot = mode === 'same' ? [0x5f] : [0x80]; // PUSH0 | DUP1
	return Uint8Array.from([
		0x61, (n >> 8) & 0xff, n & 0xff, // PUSH2 n
		0x5b, // JUMPDEST (pc 3)
		...slot,
		0x54, // SLOAD
		0x50, // POP
		0x60, 0x01, // PUSH1 1
		0x90, // SWAP1
		0x03, // SUB
		0x80, // DUP1
		0x60, 0x03, // PUSH1 3
		0x57, // JUMPI
		0x00, // STOP
	]);
}

async function evmWith(store) {
	return createRevm({
		wasm,
		state: store,
		spec: 'CANCUN',
		chainId: 31337n,
		block: BLOCK,
	});
}

function seed(store, code) {
	const codeHash = code === undefined ? KECCAK_EMPTY : keccak_256(code);
	store.setAccount(SENDER, {
		balance: 10n ** 24n,
		nonce: 0n,
		codeHash: KECCAK_EMPTY,
	});
	if (code !== undefined) {
		store.setAccount(CONTRACT, {balance: 0n, nonce: 0n, codeHash});
		store.setCode(codeHash, code);
	}
	return codeHash;
}

const N = 2000;
const COLD_SLOAD = 2100n;
const WARM_SLOAD = 100n;

// ---------------------------------------------------------------------------
console.log(
	`\n1) ${N} SLOADs of the SAME slot vs ${N} DIFFERENT slots — callbacks and gas`,
);
// ---------------------------------------------------------------------------
const runs = {};
for (const mode of ['same', 'different']) {
	const inner = new MemoryStore();
	const {counts, store} = countingStore(inner);
	seed(inner, sloadLoop(N, mode));
	const evm = await evmWith(store);
	// Every slot the loop reads is UNSET, so the answers are all zero; what is
	// being measured is how many times the question crossed the boundary, not what
	// came back.
	const before = {...counts};
	const out = evm.transact({
		from: SENDER,
		to: CONTRACT,
		gasLimit: 20_000_000n,
		nonce: 0n,
		...FEES,
	});
	runs[mode] = {
		status: out.status,
		error: out.error,
		gasUsed: out.gasUsed,
		storageCallbacks: counts.getStorage - before.getStorage,
		accountCallbacks: counts.getAccount - before.getAccount,
		codeCallbacks: counts.getCode - before.getCode,
	};
	console.log(
		`  ${mode.padEnd(9)} status=${out.status} gasUsed=${out.gasUsed} ` +
			`getStorage=${runs[mode].storageCallbacks} ` +
			`getAccount=${runs[mode].accountCallbacks} ` +
			`getCode=${runs[mode].codeCallbacks}`,
	);
}

console.log('\n  the two claims, checked against each other:');
// ONE CALLBACK PER COLD ACCESS, IN BOTH DIRECTIONS: the same-slot loop makes ONE
// cold access and one callback, the distinct-slot loop makes N of each. This is
// the affordability claim, counted.
check('same-slot storage callbacks', runs.same.storageCallbacks, 1);
check('different-slot storage callbacks', runs.different.storageCallbacks, N);
// THE GAS IS THE INDEPENDENT WITNESS, and the arithmetic is spelled out rather
// than rounded. EIP-2929 charges 2100 cold and 100 warm, so the SLOAD half of the
// difference is (N-1)*(2100-100) — not N*(2100-100), because the same-slot loop
// pays cold once too. The remaining N gas is the LOOP, not the access: reading a
// varying slot needs `DUP1` (3 gas) where a fixed slot needs `PUSH0` (2). The two
// happen to sum to a round 4,000,000 at N=2000, which is a coincidence of this
// loop shape and is why the terms are written out here.
check(
	'gas difference = (N-1) cold/warm deltas + N loop gas',
	runs.different.gasUsed - runs.same.gasUsed,
	BigInt(N - 1) * (COLD_SLOAD - WARM_SLOAD) + BigInt(N),
);

// ---------------------------------------------------------------------------
console.log('\n2) EIP-2929 resets per TRANSACTION — the caveat that cuts back');
// ---------------------------------------------------------------------------
// The same contract read twice, in two transactions: warmth does NOT carry over,
// so a game loop re-reading the same entities every tick re-pays the crossings
// every tick. Gas is identical either way; only wall clock differs. Recorded in
// the ADR as the honest cost of leaving state on the JS side.
{
	const inner = new MemoryStore();
	const {counts, store} = countingStore(inner);
	seed(inner, sloadLoop(N, 'different'));
	const evm = await evmWith(store);
	const perTx = [];
	for (let nonce = 0; nonce < 2; nonce++) {
		const before = counts.getStorage;
		const out = evm.transact({
			from: SENDER,
			to: CONTRACT,
			gasLimit: 20_000_000n,
			nonce: BigInt(nonce),
			...FEES,
		});
		perTx.push({
			gasUsed: out.gasUsed,
			storageCallbacks: counts.getStorage - before,
		});
	}
	console.log(
		`  tx1 gasUsed=${perTx[0].gasUsed} getStorage=${perTx[0].storageCallbacks}` +
			`   tx2 gasUsed=${perTx[1].gasUsed} getStorage=${perTx[1].storageCallbacks}`,
	);
	check('second transaction re-pays every crossing', perTx[1].storageCallbacks, N);
	check(
		'...and is charged the same cold gas for them',
		perTx[1].gasUsed,
		perTx[0].gasUsed,
	);
}

// ---------------------------------------------------------------------------
console.log('\n3) the WRITE side: a commit writes back only what it touched');
// ---------------------------------------------------------------------------
{
	const inner = new MemoryStore();
	const {counts, wrote, store} = countingStore(inner);
	// A contract holding 1000 slots, of which the transaction writes exactly one:
	// PUSH1 2a, PUSH1 07, SSTORE, STOP.
	const code = Uint8Array.from([0x60, 0x2a, 0x60, 0x07, 0x55, 0x00]);
	seed(inner, code);
	const slot = (i) => {
		const s = new Uint8Array(32);
		s[31] = i & 0xff;
		s[30] = (i >> 8) & 0xff;
		return s;
	};
	const one = new Uint8Array(32);
	one[31] = 1;
	for (let i = 0; i < 1000; i++) inner.setStorage(CONTRACT, slot(i), one);
	const evm = await evmWith(store);
	const before = {...counts};
	const out = evm.transact({
		from: SENDER,
		to: CONTRACT,
		gasLimit: 200_000n,
		nonce: 0n,
		...FEES,
	});
	console.log(
		`  status=${out.status} setStorage=${counts.setStorage - before.setStorage} ` +
			`setAccount=${counts.setAccount - before.setAccount} ` +
			`clearStorage=${counts.clearStorage - before.clearStorage} ` +
			`removeAccount=${counts.removeAccount - before.removeAccount} ` +
			`slots=${JSON.stringify(wrote.slots)}`,
	);
	check('slots written back', counts.setStorage - before.setStorage, 1);
	// Sender (nonce + fee), coinbase (tip) and the contract itself (touched).
	check('accounts written back', counts.setAccount - before.setAccount, 3);
	check('nothing walked all of storage', counts.clearStorage - before.clearStorage, 0);
}

// ---------------------------------------------------------------------------
console.log('\n4) the two gas fields, and why a receipt needs the NET one');
// ---------------------------------------------------------------------------
{
	const inner = new MemoryStore();
	const {store} = countingStore(inner);
	// PUSH0 PUSH0 SSTORE STOP — clears slot 0, which is where the refund is.
	const code = Uint8Array.from([0x5f, 0x5f, 0x55, 0x00]);
	seed(inner, code);
	const zeroSlot = new Uint8Array(32);
	const one = new Uint8Array(32);
	one[31] = 1;
	inner.setStorage(CONTRACT, zeroSlot, one);
	const evm = await evmWith(store);
	const out = evm.transact({
		from: SENDER,
		to: CONTRACT,
		gasLimit: 200_000n,
		nonce: 0n,
		...FEES,
	});
	console.log(
		`  status=${out.status} totalGasSpent=${out.totalGasSpent} ` +
			`gasRefunded=${out.gasRefunded} gasUsed=${out.gasUsed} ` +
			`effectiveGasPrice=${out.effectiveGasPrice}`,
	);
	check('gasUsed is net of refunds', out.gasUsed, out.totalGasSpent - out.gasRefunded);
	check('...and the refund is not zero, so the two fields differ', out.gasRefunded > 0n, true);
}

// ---------------------------------------------------------------------------
console.log('\n5) a plain transfer, for the ADR to quote as the floor');
// ---------------------------------------------------------------------------
{
	const inner = new MemoryStore();
	const {counts, store} = countingStore(inner);
	seed(inner, undefined);
	const evm = await evmWith(store);
	const before = {...counts};
	const out = evm.transact({
		from: SENDER,
		to: SINK,
		value: 12_345n,
		gasLimit: 21_000n,
		nonce: 0n,
		...FEES,
	});
	console.log(
		`  status=${out.status} gasUsed=${out.gasUsed} ` +
			`getAccount=${counts.getAccount - before.getAccount} ` +
			`getStorage=${counts.getStorage - before.getStorage} ` +
			`setAccount=${counts.setAccount - before.setAccount}`,
	);
	check('accounts read', counts.getAccount - before.getAccount, 3);
	check('storage read', counts.getStorage - before.getStorage, 0);
	check('accounts written', counts.setAccount - before.setAccount, 3);
}

console.log(
	failures.length === 0
		? '\nALL CHECKS PASSED\n'
		: `\n${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
