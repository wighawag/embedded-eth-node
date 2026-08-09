/**
 * measure-overlay-storage.mjs — what the re-layer actually bought, measured
 * AFTER it shipped, against the layout it replaced.
 *
 * This is `spike-storage-layout-cost-for-the-revm-write-half`'s Q1/Q2/Q3
 * measurement re-pointed at the SHIPPED class. That spike could only measure a
 * prototype; this one measures `packages/embedded-eth-node/src/state-manager.ts`
 * as published, against {@link FlatBaselineStateManager} — the layout the node
 * shipped before, frozen here so the baseline column cannot drift into being the
 * new code compared with itself.
 *
 *   node --max-old-space-size=4096 docs/spikes/re-layer-storage-as-per-account-maps-with-per-frame-diffs/measure-overlay-storage.mjs
 *
 * KEEP THE HEAP CAP AND RUN IT ALONE. Section 2 holds 100,000-slot maps and
 * copies them repeatedly on the baseline layout, so it is the memory-heavy part;
 * the cap makes an overrun fail as a JS heap error here rather than as memory
 * pressure on whatever else is running. About 90 seconds in total.
 *
 * CORRECTNESS IS SECTION 1 AND IT GATES THE REST: the same four transactions must
 * produce identical receipts and identical post-state on both layouts before a
 * single timing is printed. The exhaustive correctness bar is not here — it is
 * `packages/embedded-eth-node/test/storage-overlay.spec.ts`, which runs six
 * checkpoint/commit/revert semantics and a 20,000-operation randomised
 * differential against the same frozen baseline, plus a naive control that must
 * fail them.
 *
 * It exits non-zero if any check fails. Spike code: nothing under `packages/`
 * imports it.
 */
// The harness comes from the spike that produced the design, rather than being
// copied. NOTE its `SimpleStateManagerWithClearStorage` export is stale (the
// class it named is now `OverlayStorageStateManager`); nothing here reads it.
import {
	bench,
	check,
	dep,
	exitWithFailures,
	nodeDist,
	printEnvironment,
	SimpleStateManager,
	table,
	util,
	µs,
} from '../spike-storage-layout-cost-for-the-revm-write-half/support.mjs';

const {createNode} = await nodeDist('index.js');
const {OverlayStorageStateManager} = await nodeDist('state-manager.js');
const {createLegacyTx} = await dep('@ethereumjs/tx');
const {createVM, runTx} = await dep('@ethereumjs/vm');
const {createBlock} = await dep('@ethereumjs/block');
const {Common, Mainnet, Hardfork} = await dep('@ethereumjs/common');
const {
	Account,
	createAddressFromString,
	bytesToHex,
	hexToBytes,
	privateToAddress,
} = util;

/**
 * THE LAYOUT THE NODE SHIPPED BEFORE, frozen: `SimpleStateManager`'s one flat
 * `${address}_${slot}` map (copied whole by every checkpoint) plus the
 * prefix-scan `clearStorage` the node had to add over upstream's no-op. Kept
 * here verbatim so the "before" column stays the before column.
 */
class FlatBaselineStateManager extends SimpleStateManager {
	async clearStorage(address) {
		if (address === undefined) return;
		const top = this.storageStack[this.storageStack.length - 1];
		const prefix = `${address.toString()}_`;
		for (const key of top.keys()) {
			if (key.startsWith(prefix)) top.delete(key);
		}
	}
	dumpStorage() {
		const out = {};
		const top = this.storageStack[this.storageStack.length - 1];
		for (const [key, value] of top) out[key] = bytesToHex(value);
		return out;
	}
}

/** The shipped layout, in the same `{'addr_slot': '0x…'}` shape, for diffing. */
function dumpShipped(sm) {
	const out = {};
	for (const [address, inner] of sm.liveStorage())
		for (const [slot, value] of inner) out[`${address}_${slot}`] = bytesToHex(value);
	return out;
}

const LAYOUTS = [
	['flat (before)', () => new FlatBaselineStateManager()],
	['overlay (shipped)', () => new OverlayStorageStateManager()],
];

console.log('\n=== measure-overlay-storage ===');
await printEnvironment();

// ------------------------------------------------------------- fixtures ----

const CHAIN_ID = 31337; // a NUMBER: `new Common({chain})` JSON-clones it, and JSON has no BigInt
const PRIV = hexToBytes(
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const SENDER = bytesToHex(privateToAddress(PRIV));
const EOA = '0x00000000000000000000000000000000000000ee';

const hex = (bytes) =>
	'0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Runtime code: SSTORE `n` slots, then stop. */
function writerRuntime(n) {
	const out = [];
	for (let i = 0; i < n; i++) out.push(0x60, i + 1, 0x60, i, 0x55);
	out.push(0x00);
	return Uint8Array.from(out);
}
/** Runtime code: SLOAD slot 0 and return it. Pure read, for eth_call. */
const READER_RUNTIME = Uint8Array.from([
	0x60, 0x00, 0x54, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3,
]);
/** Runtime code: CALL `target` with no data, then SSTORE one slot. */
function callerRuntime(target) {
	return Uint8Array.from([
		0x60, 0x00, 0x60, 0x00, 0x60, 0x00, 0x60, 0x00, 0x60, 0x00,
		0x73, ...hexToBytes(target),
		0x5a, 0xf1, 0x50,
		0x60, 0x07, 0x60, 0x00, 0x55,
		0x00,
	]);
}
/** Wrap runtime code in the minimal init code that returns it. */
function initCodeFor(runtime) {
	const L = runtime.length;
	return Uint8Array.from([
		0x60, L, 0x60, 0x0c, 0x60, 0x00, 0x39,
		0x60, L, 0x60, 0x00, 0xf3,
		...runtime,
	]);
}

const READER = '0x00000000000000000000000000000000000000a0';
const WRITER = '0x00000000000000000000000000000000000000a1';
const C2 = '0x00000000000000000000000000000000000000a2';
const C1 = '0x00000000000000000000000000000000000000a3';

const INITIAL_STATE = {
	[SENDER]: {balance: 10n ** 20n},
	[READER]: {code: hex(READER_RUNTIME), storage: {'0x00': '0x2a'}},
	[WRITER]: {code: hex(writerRuntime(3))},
	[C2]: {code: hex(callerRuntime(WRITER))},
	[C1]: {code: hex(callerRuntime(C2))},
};

const common = new Common({
	chain: {...Mainnet, chainId: CHAIN_ID, name: 'probe'},
	hardfork: Hardfork.Cancun,
});

/** The four transaction shapes: transfer, 3 SSTOREs, 3 nested calls, CREATE. */
function txs(startNonce = 0) {
	const mk = (i, fields) =>
		createLegacyTx(
			{
				nonce: BigInt(startNonce + i),
				gasPrice: 2_000_000_000n,
				gasLimit: 1_000_000n,
				value: 0n,
				...fields,
			},
			{common},
		).sign(PRIV);
	return {
		transfer: mk(0, {to: EOA, value: 1n}),
		write: mk(1, {to: WRITER}),
		nested: mk(2, {to: C1}),
		create: mk(3, {data: initCodeFor(writerRuntime(3))}),
	};
}

const BLOCK = createBlock(
	{
		header: {
			number: 1n,
			timestamp: 1_700_000_000n,
			gasLimit: 30_000_000n,
			baseFeePerGas: 1_000_000_000n,
			coinbase: createAddressFromString(
				'0x00000000000000000000000000000000c0173a5e',
			),
		},
	},
	{common, skipConsensusFormatValidation: true},
);

const slotKey = (i) => hexToBytes(`0x${i.toString(16).padStart(64, '0')}`);
const filler = (i) =>
	createAddressFromString(`0x${(0x10000 + i).toString(16).padStart(40, '0')}`);

async function buildVm(makeSm, fillSlots) {
	const sm = makeSm();
	for (const [address, acc] of Object.entries(INITIAL_STATE)) {
		const a = createAddressFromString(address);
		await sm.putAccount(a, new Account(0n, acc.balance ?? 0n));
		if (acc.code) await sm.putCode(a, hexToBytes(acc.code));
		for (const [slot, value] of Object.entries(acc.storage ?? {})) {
			await sm.putStorage(
				a,
				hexToBytes(`0x${slot.replace(/^0x/, '').padStart(64, '0')}`),
				hexToBytes(value),
			);
		}
	}
	for (let i = 0; i < fillSlots; i++) {
		await sm.putStorage(
			filler(Math.floor(i / 100)),
			slotKey(i % 100),
			Uint8Array.from([1]),
		);
	}
	const blockchain = {
		getBlock: async () => BLOCK,
		putBlock: async () => {},
		shallowCopy() {
			return this;
		},
	};
	return {vm: await createVM({common, stateManager: sm, blockchain}), sm};
}

/** Post-state, in one comparable shape whatever the layout. */
function postState(sm) {
	const accounts = {};
	const top = sm.accountStack[sm.accountStack.length - 1];
	for (const [address, acc] of top)
		accounts[address] = acc === undefined ? null : bytesToHex(acc.serialize());
	const storage = sm.liveStorage ? dumpShipped(sm) : sm.dumpStorage();
	const sorted = (o) =>
		Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
	return JSON.stringify({accounts: sorted(accounts), storage: sorted(storage)});
}

async function runAll(vm) {
	const t = txs(0);
	const out = [];
	for (const tx of [t.transfer, t.write, t.nested, t.create]) {
		const res = await runTx(vm, {
			tx,
			block: BLOCK,
			skipBlockGasLimitValidation: true,
			skipHardForkValidation: true,
		});
		out.push({
			gas: res.totalGasSpent.toString(),
			created: res.createdAddress?.toString() ?? null,
			error: res.execResult.exceptionError?.error ?? null,
		});
	}
	return JSON.stringify(out);
}

// ------------------------------------------- 1. correctness gates the rest --

console.log('\n[1] CORRECTNESS: the same four transactions, both layouts');

{
	const before = await buildVm(() => new FlatBaselineStateManager(), 1_000);
	const beforeReceipts = await runAll(before.vm);
	const after = await buildVm(() => new OverlayStorageStateManager(), 1_000);
	const afterReceipts = await runAll(after.vm);
	check(
		'IDENTICAL receipts through @ethereumjs/vm',
		beforeReceipts === afterReceipts,
		beforeReceipts === afterReceipts ? '' : `${beforeReceipts} vs ${afterReceipts}`,
	);
	check(
		'IDENTICAL post-state (accounts + every storage slot)',
		postState(before.sm) === postState(after.sm),
	);
}

// ------------------------------------------------- 2. what a checkpoint costs

console.log('\n[2] one CHECKPOINT, by state size (microseconds)');
console.log('    dense = slots over 10 accounts; sparse = 1 slot per account');

async function fill(sm, {accounts, slotsPerAccount}) {
	for (let a = 0; a < accounts; a++) {
		const A = createAddressFromString(
			`0x${(a + 1).toString(16).padStart(40, '0')}`,
		);
		for (let s = 0; s < slotsPerAccount; s++) {
			await sm.putStorage(A, slotKey(s), Uint8Array.from([((a + s) % 251) + 1]));
		}
	}
	return sm;
}

const checkpointRows = [];
const clearRows = [];
for (const total of [1_000, 10_000, 100_000]) {
	for (const shape of ['dense', 'sparse']) {
		const accounts = shape === 'dense' ? 10 : total;
		const row = [`${total} slots / ${shape}`, accounts];
		for (const [, make] of LAYOUTS) {
			const sm = await fill(make(), {
				accounts,
				slotsPerAccount: total / accounts,
			});
			const depth = () => sm.storageOverlays?.length ?? sm.storageStack.length;
			row.push(
				µs(
					bench(() => sm.checkpointSync(), {
						setup: () => {
							if (depth() > 1) sm.revert();
						},
					}),
				),
			);
		}
		row.push((Number(row[2]) / Number(row[3])).toFixed(1) + 'x');
		checkpointRows.push(row);
	}
}
table(
	['state', 'accounts', 'flat (before) µs', 'overlay (shipped) µs', 'speedup'],
	checkpointRows,
);

console.log('\n[3] clearStorage on one account of 100 slots (microseconds)');
for (const total of [1_000, 10_000, 100_000]) {
	const accounts = total / 100;
	const row = [`${total} slots / ${accounts} accounts`];
	for (const [, make] of LAYOUTS) {
		const sm = await fill(make(), {accounts, slotsPerAccount: 100});
		const target = createAddressFromString(`0x${'1'.padStart(40, '0')}`);
		row.push(µs(bench(() => void sm.clearStorage(target))));
	}
	row.push((Number(row[1]) / Number(row[2])).toFixed(1) + 'x');
	clearRows.push(row);
}
table(
	['state', 'flat (before) µs', 'overlay (shipped) µs', 'speedup'],
	clearRows,
);

// ------------------------------------- 4. what that costs a transaction ------

console.log('\n[4] the four transactions through @ethereumjs/vm (median of 5, ms)');

const abRows = [];
for (const size of [1_000, 10_000, 100_000]) {
	const row = [`${size} slots`];
	for (const [, make] of LAYOUTS) {
		const ms = [];
		for (let i = 0; i < 5; i++) {
			const {vm} = await buildVm(make, size);
			const t0 = process.hrtime.bigint();
			await runAll(vm);
			ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
		}
		ms.sort((a, b) => a - b);
		row.push(ms[2].toFixed(3));
	}
	row.push((Number(row[1]) / Number(row[2])).toFixed(1) + 'x');
	abRows.push(row);
}
table(
	['state', 'flat (before) ms', 'overlay (shipped) ms', 'speedup'],
	abRows,
);

check(
	'the shipped layout is FLAT in state size (100k within 2x of 1k)',
	Number(abRows[2][2]) < Number(abRows[0][2]) * 2,
	`${abRows[0][2]} ms at 1k vs ${abRows[2][2]} ms at 100k`,
);

// ------------------------------- 5. through the node's own public surface ----

console.log("\n[5] the same shape through the node's OWN surface (ms)");
console.log('    one transaction each, at the given state size');

// Storage is grown through the node's OWN `evm_setStorageAt` cheat rather than by
// reaching into its state manager, so this table measures only the public surface.
const node = await createNode({chainId: CHAIN_ID, initialState: INITIAL_STATE});
const growthRows = [];
let added = 0;
let nonce = 0;
for (const size of [0, 1_000, 10_000, 100_000]) {
	for (let i = added; i < size; i++) {
		await node.request({
			method: 'evm_setStorageAt',
			params: [
				filler(Math.floor(i / 100)).toString(),
				`0x${(i % 100).toString(16)}`,
				`0x${'00'.repeat(31)}01`,
			],
		});
	}
	added = size;
	const send = async (tx) => {
		const t0 = process.hrtime.bigint();
		await node.request({
			method: 'eth_sendRawTransaction',
			params: [bytesToHex(tx.serialize())],
		});
		return (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(3);
	};
	const t0 = process.hrtime.bigint();
	await node.request({
		method: 'eth_call',
		params: [{to: READER, data: '0x'}, 'latest'],
	});
	const call = (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(3);
	const one = txs(nonce);
	growthRows.push([
		`${size} slots`,
		call,
		await send(one.transfer),
		await send(one.write),
		await send(one.nested),
		await send(one.create),
	]);
	nonce += 4;
}
table(
	['node storage', 'eth_call', 'transfer', '3 SSTOREs', 'nested', 'CREATE'],
	growthRows,
);
console.log('  (the pre-change figures for this table are in');
console.log('   ../spike-storage-layout-cost-for-the-revm-write-half/measurements.md)');

await node.dispose?.();
exitWithFailures();
