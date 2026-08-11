/**
 * probe-shipped-store-key-cost.mjs: what a cold revm storage access costs
 * through the SHIPPED store, before and after the packed key encoding.
 *
 * `spike-storage-layout-cost-for-the-revm-write-half`'s Q4 answered the same
 * question against four PROTOTYPE stores, because the node did not own its
 * storage representation yet. It does now (ADR 0009), so this re-measures the
 * claim against the real `SimpleStateManagerStore` bound to a real
 * `OverlayStorageStateManager` — the code that ships — with ONE thing changed
 * between the arms:
 *
 *   * `shipped (packed keys)`  — `src/storage-keys.ts`, two bytes per UTF-16
 *                                code unit, exactly as `dist/` builds it.
 *   * `hex keys (replaced)`    — the SAME shipped store and the SAME overlay
 *                                manager, with the storage key built the way it
 *                                was before this change (`0x`-hex, 42 + 66
 *                                characters). The manager keys storage by opaque
 *                                string, so this arm is the previous encoding
 *                                over the identical data structure.
 *   * `flat hex (pre-ADR-0009)`— one flat `${address}_${slot}` map, i.e. the
 *                                store as it shipped before the overlay layout.
 *                                Carried only so this table can be read against
 *                                Q4's, whose 100% column is this arm.
 *   * `null store`             — answers without looking at the key. The floor:
 *                                the wasm crossing alone.
 *
 * The contract SLOADs 2,000 DISTINCT slots (2,000 cold accesses, so 2,000 host
 * callbacks, COUNTED rather than assumed) or the SAME slot 2,000 times (one
 * callback). The difference between those two runs is the crossing plus its key
 * handling; the difference BETWEEN ARMS is the key handling alone.
 *
 *   pnpm install   # builds packages/embedded-eth-node/dist, which this reads
 *   node docs/spikes/revm-state-store-packed-storage-keys/probe-shipped-store-key-cost.mjs
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {
	bench,
	check,
	dep,
	exitWithFailures,
	nodeDist,
	packageVersion,
	printEnvironment,
	REPO_ROOT,
	table,
	µs,
} from '../spike-storage-layout-cost-for-the-revm-write-half/support.mjs';

const require = createRequire(
	new URL('packages/embedded-eth-node/package.json', REPO_ROOT),
);
const {createRevm} = await import(require.resolve('revm-wasm'));
const {wasmUrl} = await import(require.resolve('revm-wasm/wasm-url'));
const {keccak_256} = await import(require.resolve('@noble/hashes/sha3.js'));
const {Account, createAddressFromString} = await dep('@ethereumjs/util');
const revmVersion = await packageVersion('revm-wasm');

// The SHIPPED code, from the node's own build.
const {OverlayStorageStateManager} = await nodeDist('state-manager.js');
const {SimpleStateManagerStore} = await nodeDist('revm-state-store.js');
const {packAddressKey, packSlotKey} = await nodeDist('storage-keys.js');

const wasmBytes = readFileSync(fileURLToPath(wasmUrl));
const wasmModule = new WebAssembly.Module(wasmBytes);

console.log('\n=== probe-shipped-store-key-cost ===');
await printEnvironment();
console.log(`  revm-wasm ${revmVersion}`);

// --------------------------------------------------------------- fixture ----

const N = 2000;
const CONTRACT_HEX = '0x00000000000000000000000000000000000000c0';
const CALLER_HEX = '0x00000000000000000000000000000000000f0000';
const CONTRACT = Uint8Array.from(Buffer.from(CONTRACT_HEX.slice(2), 'hex'));
const CALLER = Uint8Array.from(Buffer.from(CALLER_HEX.slice(2), 'hex'));

/** A loop of `N` SLOADs: distinct slots (all COLD) or the same slot (WARM). */
function sloadLoop(distinct) {
	const body = distinct
		? [0x80, 0x54, 0x50] // DUP1 (i), SLOAD, POP
		: [0x60, 0x00, 0x54, 0x50]; // PUSH1 0, SLOAD, POP
	return Uint8Array.from([
		0x61, (N >> 8) & 0xff, N & 0xff, // PUSH2 N
		0x60, 0x00, // PUSH1 0            -> i
		0x5b, // JUMPDEST (offset 5)
		...body,
		0x60, 0x01, 0x01, // PUSH1 1, ADD -> i+1
		0x81, 0x81, 0x10, // DUP2 (N), DUP2 (i+1), LT
		0x60, 0x05, 0x57, // PUSH1 5, JUMPI
		0x00, // STOP
	]);
}

const CODE_DISTINCT = sloadLoop(true);
const CODE_SAME = sloadLoop(false);
const VALUE = new Uint8Array(32).fill(7);

function slotBytes(i) {
	const b = new Uint8Array(32);
	b[30] = (i >> 8) & 0xff;
	b[31] = i & 0xff;
	return b;
}

const HEX = (() => {
	const t = [];
	for (let i = 0; i < 256; i++) t.push(i.toString(16).padStart(2, '0'));
	return t;
})();
/** The address key the store built for storage BEFORE the packed encoding. */
function addrKeyHex(a) {
	let s = '0x';
	for (let i = 0; i < 20; i++) s += HEX[a[i]];
	return s;
}
function hexOf(b) {
	let s = '';
	for (let i = 0; i < b.length; i++) s += HEX[b[i]];
	return s;
}
/** `src/revm-state-store.ts`'s pad32, which every arm pays equally. */
function pad32(v) {
	if (v.length === 32) return v;
	const out = new Uint8Array(32);
	out.set(v, 32 - v.length);
	return out;
}

// ------------------------------------------------------------- the arms -----

/**
 * A state manager holding the contract, the caller and `N` slots, with the slot
 * keys written by `write` — the packed encoder for the shipped arm, the hex one
 * for the arm it replaced. Accounts and code are identical in every arm.
 */
async function manager(code, write) {
	const sm = new OverlayStorageStateManager();
	const contract = createAddressFromString(CONTRACT_HEX);
	await sm.putAccount(contract, new Account(0n, 0n));
	await sm.putCode(contract, code);
	await sm.putAccount(createAddressFromString(CALLER_HEX), new Account(0n, 10n ** 20n));
	for (let i = 0; i < N; i++) write(sm, slotBytes(i));
	return sm;
}

/** THE SHIPPED STORE, unmodified, over storage written the shipped way. */
async function shippedStore(code) {
	const sm = await manager(code, (sm, slot) =>
		sm.setStorageAt(packAddressKey(CONTRACT), packSlotKey(slot), VALUE),
	);
	const store = new SimpleStateManagerStore();
	store.bind(sm);
	store.label = 'shipped (packed keys)';
	return store;
}

/**
 * The SAME shipped store and the SAME manager, with only the STORAGE KEY built
 * the way it was before: `getStorage` is the one method overridden, and it is a
 * verbatim copy of the pre-change body.
 */
async function hexKeyStore(code) {
	const sm = await manager(code, (sm, slot) =>
		sm.setStorageAt(addrKeyHex(CONTRACT), '0x' + hexOf(slot), VALUE),
	);
	const store = new SimpleStateManagerStore();
	store.bind(sm);
	return {
		label: 'hex keys (the encoding this replaced)',
		getAccount: (a) => store.getAccount(a),
		getCode: (h) => store.getCode(h),
		getBlockHash: () => undefined,
		getStorage: (a, slot) => {
			const v = sm.storageAt(addrKeyHex(a), '0x' + hexOf(slot));
			if (v === undefined || v.length === 0) return undefined;
			return pad32(v);
		},
	};
}

/**
 * The store as it shipped BEFORE ADR 0009: one flat `${address}_${slot}` map.
 * Here only so this table can be read against Q4's, whose 100% column is this.
 */
async function flatHexStore(code) {
	const sm = await manager(code, () => {});
	const store = new SimpleStateManagerStore();
	store.bind(sm);
	const flat = new Map();
	const contractKey = addrKeyHex(CONTRACT);
	for (let i = 0; i < N; i++)
		flat.set(`${contractKey}_0x${hexOf(slotBytes(i))}`, VALUE);
	return {
		label: 'flat hex (pre-ADR-0009)',
		getAccount: (a) => store.getAccount(a),
		getCode: (h) => store.getCode(h),
		getBlockHash: () => undefined,
		getStorage: (a, slot) => {
			const v = flat.get(`${addrKeyHex(a)}_0x${hexOf(slot)}`);
			return v === undefined || v.length === 0 ? undefined : pad32(v);
		},
	};
}

/** The floor: answers without looking at the key at all. */
async function nullStore(code) {
	const sm = await manager(code, () => {});
	const store = new SimpleStateManagerStore();
	store.bind(sm);
	return {
		label: 'null store (crossing only)',
		getAccount: (a) => store.getAccount(a),
		getCode: (h) => store.getCode(h),
		getBlockHash: () => undefined,
		getStorage: () => VALUE,
	};
}

const STORES = [shippedStore, hexKeyStore, flatHexStore, nullStore];

// --------------------------------------------------------- the two runs -----

const block = {
	number: 1n,
	timestamp: 1_700_000_000n,
	gasLimit: 100_000_000n,
	coinbase: Uint8Array.from(Buffer.from('00000000000000000000000000000000c0173a5e', 'hex')),
	baseFeePerGas: 0n,
	prevRandao: new Uint8Array(32),
};

async function runFor(makeStore, distinct) {
	const store = await makeStore(distinct ? CODE_DISTINCT : CODE_SAME);
	let callbacks = 0;
	const counted = {
		label: store.label,
		getAccount: (a) => store.getAccount(a),
		getCode: (h) => store.getCode(h),
		getBlockHash: (n) => store.getBlockHash(n),
		getStorage: (a, s) => {
			callbacks++;
			return store.getStorage(a, s);
		},
	};
	const revm = await createRevm({wasm: wasmModule, state: counted});
	const call = () =>
		revm.call({
			from: CALLER,
			to: CONTRACT,
			data: new Uint8Array(),
			value: 0n,
			gasLimit: 100_000_000n,
			spec: 'CANCUN',
			chainId: 1n,
			block,
			disableBaseFee: true,
			disableBlockGasLimit: true,
			disableEip3607: true,
			returnState: false,
		});
	const first = call();
	const callbacksPerCall = callbacks;
	const ms = bench(call, {minMs: 200, samples: 5}) / 1000;
	return {
		label: store.label,
		ms,
		status: first.status,
		gas: first.totalGasSpent,
		callbacksPerCall,
	};
}

console.log(`\n[1] ${N} SLOADs, DISTINCT slots (every access cold) vs the SAME slot`);

const rows = [];
const cold = new Map();
const warm = new Map();
for (const make of STORES) {
	const c = await runFor(make, true);
	const w = await runFor(make, false);
	cold.set(c.label, c);
	warm.set(c.label, w);
	rows.push([
		c.label,
		c.callbacksPerCall,
		w.callbacksPerCall,
		c.ms.toFixed(3),
		w.ms.toFixed(3),
		µs(((c.ms - w.ms) * 1000) / N),
	]);
}
table(
	[
		'store',
		'cold callbacks',
		'warm callbacks',
		`cold ms (${N} SLOADs)`,
		'warm ms',
		'µs per cold access',
	],
	rows,
);

const SHIPPED = 'shipped (packed keys)';
const REPLACED = 'hex keys (the encoding this replaced)';
const FLAT = 'flat hex (pre-ADR-0009)';
const NULL = 'null store (crossing only)';

{
	const c = cold.get(SHIPPED);
	const w = warm.get(SHIPPED);
	check(
		'one host callback per COLD access, one in total when the slot is warm',
		c.status === 'success' &&
			w.status === 'success' &&
			c.callbacksPerCall === N &&
			w.callbacksPerCall === 1,
		`gas: cold ${c.gas}, warm ${w.gas} (the ${c.gas - w.gas} difference is EIP-2929 cold-vs-warm, i.e. 2000 x 1999)`,
	);
	// The arms must be reading REAL storage, or the fastest one is the one that
	// found nothing: an unfound slot is `undefined`, i.e. zero, and just as fast.
	check(
		'every arm answered the same gas, i.e. every arm FOUND the slots',
		[REPLACED, FLAT, NULL].every((l) => cold.get(l).gas === c.gas),
		[SHIPPED, REPLACED, FLAT, NULL]
			.map((l) => `${l}: ${cold.get(l).gas}`)
			.join(', '),
	);
}

const perAccess = (label) =>
	((cold.get(label).ms - warm.get(label).ms) * 1000) / N;
const shippedCost = perAccess(SHIPPED);
const replacedCost = perAccess(REPLACED);
const flatCost = perAccess(FLAT);
const nullCost = perAccess(NULL);

console.log('\n[2] what the packed encoding RECOVERED, against the encoding it');
console.log('    replaced (100% = the hex-key access this change removed)');
const share = (v) => `${((v / replacedCost) * 100).toFixed(0)}%`;
table(
	['quantity', 'µs', 'share of the hex-key cold access'],
	[
		['hex-key access (before this change)', µs(replacedCost), '100%'],
		['flat hex, pre-ADR-0009 (Q4 measured this)', µs(flatCost), share(flatCost)],
		['crossing alone (null store)', µs(nullCost), share(nullCost)],
		['key handling (hex - null)', µs(replacedCost - nullCost), share(replacedCost - nullCost)],
		['SHIPPED packed access', µs(shippedCost), share(shippedCost)],
		['RECOVERED by packing (hex - packed)', µs(replacedCost - shippedCost), share(replacedCost - shippedCost)],
	],
);

// -------------------------------------------- 3. the same, without wasm -----

console.log('\n[3] the JS half alone (no wasm): build the key(s) and do the lookup');

const smPacked = await manager(CODE_DISTINCT, (sm, slot) =>
	sm.setStorageAt(packAddressKey(CONTRACT), packSlotKey(slot), VALUE),
);
const smHex = await manager(CODE_DISTINCT, (sm, slot) =>
	sm.setStorageAt(addrKeyHex(CONTRACT), '0x' + hexOf(slot), VALUE),
);
let k = 0;
table(
	['lookup', 'µs per access'],
	[
		[
			'hex keys (the encoding this replaced)',
			µs(
				bench(() => {
					const s = slotBytes(k++ % N);
					return smHex.storageAt(addrKeyHex(CONTRACT), '0x' + hexOf(s));
				}),
			),
		],
		[
			'shipped (packed keys)',
			µs(
				bench(() => {
					const s = slotBytes(k++ % N);
					return smPacked.storageAt(packAddressKey(CONTRACT), packSlotKey(s));
				}),
			),
		],
		[
			"slotBytes() alone (the probe's own overhead)",
			µs(bench(() => slotBytes(k++ % N))),
		],
	],
);

exitWithFailures();
