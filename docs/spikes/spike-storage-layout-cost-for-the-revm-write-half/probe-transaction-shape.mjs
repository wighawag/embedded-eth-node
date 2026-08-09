/**
 * probe-transaction-shape.mjs: Q1's other half and Q2's other half, i.e. how many
 * checkpoints and `clearStorage` calls a REAL operation actually incurs, and
 * what that costs end to end at realistic state sizes.
 *
 * The per-checkpoint figure from `probe-storage-layout.mjs` is only half an
 * answer. `SimpleStateManager.checkpointSync()` copies the whole storage map,
 * and `@ethereumjs/evm` checkpoints per MESSAGE FRAME, so the per-transaction
 * cost is (frames + 1) full copies. This probe counts the frames rather than
 * assuming them: section 1 counts through the real `createNode()` (so the counts
 * are the node's, not a harness's), and section 3 runs the identical
 * transactions through a standalone `@ethereumjs/vm` on each layout, checks the
 * two agree on receipts AND post-state, and only then reports wall clock.
 *
 *   node docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/probe-transaction-shape.mjs
 *
 * Needs the repo installed (`pnpm install`, which also builds the node's
 * `dist/`). It installs nothing.
 */
import {
	assertSameStateManagerInstance,
	benchAsync,
	check,
	dep,
	exitWithFailures,
	nodeDist,
	printEnvironment,
	REPO_ROOT,
	SimpleStateManager,
	table,
	util,
} from './support.mjs';
import {
	dumpFlatStorage,
	FlatStorageStateManager,
	PerAccountStorageStateManager,
} from './per-account-storage.mjs';
import {OverlayFlatStateManager} from './overlay-flat-storage.mjs';
import {PerAccountOverlayStateManager} from './per-account-overlay-storage.mjs';

const {createNode} = await nodeDist('index.js');
const {SimpleStateManagerWithClearStorage} = await nodeDist('state-manager.js');
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

assertSameStateManagerInstance();

console.log('\n=== probe-transaction-shape ===');
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
		0x60, 0x00, 0x60, 0x00, 0x60, 0x00, 0x60, 0x00, 0x60, 0x00, // ret/args/value
		0x73, ...hexToBytes(target), // PUSH20 target
		0x5a, 0xf1, 0x50, // GAS, CALL, POP
		0x60, 0x07, 0x60, 0x00, 0x55, // SSTORE slot 0 = 7
		0x00,
	]);
}
/** Wrap runtime code in the minimal init code that returns it. */
function initCodeFor(runtime) {
	const L = runtime.length;
	if (L > 255) throw new Error('runtime too long for this 1-byte deployer');
	return Uint8Array.from([
		0x60, L, 0x60, 0x0c, 0x60, 0x00, 0x39, // CODECOPY(0, 12, L)
		0x60, L, 0x60, 0x00, 0xf3, // RETURN(0, L)
		...runtime,
	]);
}

const READER = '0x00000000000000000000000000000000000000a0';
const WRITER = '0x00000000000000000000000000000000000000a1';
// A three-deep call chain: C1 -> C2 -> WRITER, each writing a slot of its own.
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
	// no customCrypto: the probe measures storage, and keccak is the same either way
	hardfork: Hardfork.Cancun,
});

/** The transaction shapes measured everywhere in this probe. */
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

// -------------------------------------------- 1. counts through the node ----

console.log('\n[1] how many checkpoints ONE operation incurs, counted inside');
console.log('    the real createNode() (stateMode:\'none\', default engine)');

const counters = {checkpoint: 0, commit: 0, revert: 0, clearStorage: 0};
let capturedSm;
{
	const proto = SimpleStateManager.prototype;
	const orig = {
		checkpointSync: proto.checkpointSync,
		commit: proto.commit,
		revert: proto.revert,
	};
	proto.checkpointSync = function (...a) {
		counters.checkpoint++;
		capturedSm = this; // the node builds its own state manager; this is how we reach it
		return orig.checkpointSync.apply(this, a);
	};
	proto.commit = function (...a) {
		counters.commit++;
		return orig.commit.apply(this, a);
	};
	proto.revert = function (...a) {
		counters.revert++;
		return orig.revert.apply(this, a);
	};
	const clearProto = SimpleStateManagerWithClearStorage.prototype;
	const origClear = clearProto.clearStorage;
	clearProto.clearStorage = function (...a) {
		counters.clearStorage++;
		return origClear.apply(this, a);
	};
}

const reset = () => {
	counters.checkpoint = 0;
	counters.commit = 0;
	counters.revert = 0;
	counters.clearStorage = 0;
};
const snapshot = () => ({...counters});

const node = await createNode({chainId: CHAIN_ID, initialState: INITIAL_STATE});
check('the probe reached the node\'s own state manager', capturedSm !== undefined);

const countRows = [];
async function counted(label, fn) {
	reset();
	await fn();
	const c = snapshot();
	countRows.push([label, c.checkpoint, c.commit, c.revert, c.clearStorage]);
	return c;
}

await counted('eth_call (SLOAD + return)', () =>
	node.request({method: 'eth_call', params: [{to: READER, data: '0x'}, 'latest']}),
);
await counted('eth_estimateGas (same call)', () =>
	node.request({method: 'eth_estimateGas', params: [{to: READER, data: '0x'}]}),
);
{
	const t = txs(0);
	await counted('tx: plain value transfer', () =>
		node.request({
			method: 'eth_sendRawTransaction',
			params: [bytesToHex(t.transfer.serialize())],
		}),
	);
	await counted('tx: 3 SSTOREs, no sub-call', () =>
		node.request({
			method: 'eth_sendRawTransaction',
			params: [bytesToHex(t.write.serialize())],
		}),
	);
	await counted('tx: 3 nested CALLs, each writing', () =>
		node.request({
			method: 'eth_sendRawTransaction',
			params: [bytesToHex(t.nested.serialize())],
		}),
	);
	await counted('tx: CREATE a contract', () =>
		node.request({
			method: 'eth_sendRawTransaction',
			params: [bytesToHex(t.create.serialize())],
		}),
	);
}
// The same read, on the revm engine: it cannot commit, so `engine.ts` wraps it
// in no checkpoint at all. Counted here because it changes WHICH half of the
// node the layout finding applies to.
{
	const {createRevmEngine} = await nodeDist('revm.js');
	const {readFileSync} = await import('node:fs');
	const {fileURLToPath} = await import('node:url');
	const {createRequire} = await import('node:module');
	const req = createRequire(
		new URL('packages/embedded-eth-node/package.json', REPO_ROOT),
	);
	const {wasmUrl} = await import(req.resolve('revm-wasm/wasm-url'));
	const revmNode = await createNode({
		chainId: CHAIN_ID,
		initialState: INITIAL_STATE,
		engine: await createRevmEngine({wasm: readFileSync(fileURLToPath(wasmUrl))}),
	});
	reset();
	await revmNode.request({
		method: 'eth_call',
		params: [{to: READER, data: '0x'}, 'latest'],
	});
	const c = snapshot();
	countRows.push([
		'eth_call, revm engine installed',
		c.checkpoint,
		c.commit,
		c.revert,
		c.clearStorage,
	]);
	check(
		'the revm read path costs ZERO state-manager checkpoints',
		c.checkpoint === 0,
		'so the flat layout\'s checkpoint cost is a WRITE-path problem once revm serves reads',
	);
	await revmNode.dispose?.();
}

table(
	['operation', 'checkpointSync', 'commit', 'revert', 'clearStorage'],
	countRows,
);

const createCounts = countRows.find((r) => r[0].startsWith('tx: CREATE'));
check(
	'a CREATE transaction really does call clearStorage',
	createCounts[4] >= 1,
	`${createCounts[4]} call(s), so "clearStorage is rare" is a claim about how often you CREATE`,
);

// --------------------------------- 2. what that costs as state grows --------

console.log('\n[2] Q1: the same operations through the node, timed, as the');
console.log('    node\'s OWN storage map grows (flat layout, milliseconds)');

const slotKey = (i) => hexToBytes(`0x${i.toString(16).padStart(64, '0')}`);
const filler = (i) =>
	createAddressFromString(`0x${(0x10000 + i).toString(16).padStart(40, '0')}`);

/** Add `n` slots to the node's live map, 100 slots per account. */
async function growNodeState(n) {
	for (let i = 0; i < n; i++) {
		await capturedSm.putStorage(filler(Math.floor(i / 100)), slotKey(i % 100), Uint8Array.from([1]));
	}
}

const growthRows = [];
let added = 0;
let nonce = 4;
for (const size of [0, 1_000, 10_000, 100_000]) {
	await growNodeState(size - added);
	added = size;
	const t = () => txs(nonce);
	const call = await benchAsync(
		() =>
			node.request({method: 'eth_call', params: [{to: READER, data: '0x'}, 'latest']}),
		5,
	);
	// Each timed transaction must be a NEW nonce, so these are measured once each
	// rather than by benchAsync.
	const send = async (tx) => {
		const t0 = process.hrtime.bigint();
		await node.request({
			method: 'eth_sendRawTransaction',
			params: [bytesToHex(tx.serialize())],
		});
		return Number(process.hrtime.bigint() - t0) / 1e6;
	};
	const one = t();
	const transfer = await send(one.transfer);
	const write = await send(one.write);
	const nested = await send(one.nested);
	const create = await send(one.create);
	nonce += 4;
	growthRows.push([
		`${size} slots`,
		call.toFixed(3),
		transfer.toFixed(3),
		write.toFixed(3),
		nested.toFixed(3),
		create.toFixed(3),
	]);
}
table(
	['node storage', 'eth_call', 'transfer', '3 SSTOREs', 'nested', 'CREATE'],
	growthRows,
);
console.log('  (one transaction each, at the given state size; eth_call is a median of 5)');

// ------------------------------- 3. the A/B: same txs, two storage layouts ---

console.log('\n[3] Q3: the SAME transactions through @ethereumjs/vm on each');
console.log('    layout. Equality of receipts and post-state is checked FIRST.');

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
		await sm.putStorage(filler(Math.floor(i / 100)), slotKey(i % 100), Uint8Array.from([1]));
	}
	const blockchain = {
		getBlock: async () => BLOCK,
		putBlock: async () => {},
		shallowCopy() {
			return this;
		},
	};
	const vm = await createVM({common, stateManager: sm, blockchain});
	return {vm, sm};
}

/** Post-state, in one comparable shape whatever the layout. */
function postState(sm) {
	const accounts = {};
	const top = sm.accountStack[sm.accountStack.length - 1];
	for (const [address, acc] of top) {
		accounts[address] = acc === undefined ? null : bytesToHex(acc.serialize());
	}
	const storage = sm.dumpStorage ? sm.dumpStorage() : dumpFlatStorage(sm);
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

{
	const flat = await buildVm(() => new FlatStorageStateManager(), 1_000);
	const flatReceipts = await runAll(flat.vm);
	for (const [name, make] of [
		['per-account CoW', () => new PerAccountStorageStateManager()],
		['flat + overlay', () => new OverlayFlatStateManager()],
		['per-account + overlay', () => new PerAccountOverlayStateManager()],
	]) {
		const other = await buildVm(make, 1_000);
		const receipts = await runAll(other.vm);
		check(
			`${name} produces IDENTICAL receipts through @ethereumjs/vm`,
			flatReceipts === receipts,
			flatReceipts === receipts ? '' : `${flatReceipts} vs ${receipts}`,
		);
		check(
			`…and IDENTICAL post-state (accounts + every storage slot)`,
			postState(flat.sm) === postState(other.sm),
		);
	}
}

const abRows = [];
for (const size of [1_000, 10_000, 100_000]) {
	const row = [`${size} slots`];
	for (const make of [
		() => new FlatStorageStateManager(),
		() => new PerAccountStorageStateManager(),
		() => new OverlayFlatStateManager(),
		() => new PerAccountOverlayStateManager(),
	]) {
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
	abRows.push([
		...row,
		(Number(row[1]) / Number(row[2])).toFixed(1) + 'x',
		(Number(row[1]) / Number(row[3])).toFixed(1) + 'x',
		(Number(row[1]) / Number(row[4])).toFixed(1) + 'x',
	]);
}
table(
	[
		'state',
		'flat ms',
		'per-account CoW ms',
		'flat+overlay ms',
		'per-account+overlay ms',
		'CoW speedup',
		'flat+overlay speedup',
		'per-account+overlay speedup',
	],
	abRows,
);
console.log('  (the four transactions above, run back to back; median of 5)');

// ------------------------------------------------ 4. the blast radius -------

console.log('\n[4] BLAST RADIUS: can the layout change behind revm-state-store\'s');
console.log('    #storageOf alone? Run the SHIPPED readers against the prototype.');

{
	const {SimpleStateManagerStore, assertStackShape} = await nodeDist(
		'revm-state-store.js',
	);
	const sm = new PerAccountStorageStateManager();
	const target = createAddressFromString(WRITER);
	const slot0 = slotKey(0);
	await sm.putStorage(target, slot0, Uint8Array.from([0x2a]));
	check(
		'the prototype answers its own getStorage correctly',
		bytesToHex(await sm.getStorage(target, slot0)) === '0x2a',
	);

	// (a) the structural guard the engine runs at construction
	let shapeThrew = false;
	try {
		assertStackShape(sm);
	} catch {
		shapeThrew = true;
	}
	check(
		'assertStackShape still PASSES on the per-account prototype',
		!shapeThrew,
		'the three stacks are still there and still Maps, so the guard cannot see this change',
	);

	// (b) the read adapter itself, unmodified, bound to the prototype
	const store = new SimpleStateManagerStore();
	store.bind(sm);
	const viaStore = store.getStorage(
		Uint8Array.from(hexToBytes(WRITER)),
		Uint8Array.from(slot0),
	);
	check(
		'the SHIPPED revm read store returns the WRONG answer (silently) on the new layout',
		viaStore === undefined,
		`getStorage -> ${viaStore === undefined ? 'undefined, i.e. slot is zero' : bytesToHex(viaStore)}; the value IS 0x2a. No throw, no warning.`,
	);

	// (c) node.ts's dumpState 'none' branch, replicated verbatim (src/node.ts:1058-1077)
	const dumped = {};
	{
		const storageMap = sm.storageStack[sm.storageStack.length - 1];
		for (const [combined, value] of storageMap) {
			const sep = combined.indexOf('_');
			(dumped[combined.slice(0, sep)] ??= {})[combined.slice(sep + 1)] =
				bytesToHex(value);
		}
	}
	check(
		"dumpState's 'none' branch dumps NOTHING on the new layout",
		Object.keys(dumped).length === 0,
		'it reads storageStack directly and splits the flat key on "_", so the dump silently loses all storage, which persistence then saves',
	);
}

await node.dispose?.();
exitWithFailures();
