/**
 * probe-cold-access-key-cost.mjs: Q4, how much of a cold state access is the
 * KEY, and how much of that a per-account layout actually recovers.
 *
 * `revm-engine-behind-runtx`'s Further Notes record ~1.3 microseconds per cold
 * state access, "of which about 60% is JS-side hex key construction". That
 * number came from `revm-wasm`'s own spike against its `MemoryStore`, not from
 * this node's adapter, so this probe re-measures it HERE (through the real wasm
 * module, with a store shaped exactly like `src/revm-state-store.ts`'s
 * `#storageOf`), and then measures the two per-account alternatives against it.
 *
 * The contract SLOADs 2000 DISTINCT slots (2000 cold accesses, i.e. 2000 host
 * crossings) or the SAME slot 2000 times (one crossing). The difference between
 * those two runs is what a crossing plus its key handling costs; the difference
 * BETWEEN STORES on the cold run is the key handling alone.
 *
 *   node docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/probe-cold-access-key-cost.mjs
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {
	bench,
	check,
	exitWithFailures,
	printEnvironment,
	REPO_ROOT,
	table,
	µs,
} from './support.mjs';

const require = createRequire(
	new URL('packages/embedded-eth-node/package.json', REPO_ROOT),
);
const {createRevm} = await import(require.resolve('revm-wasm'));
const {wasmUrl} = await import(require.resolve('revm-wasm/wasm-url'));
const {keccak_256} = await import(require.resolve('@noble/hashes/sha3.js'));
const revmVersion = JSON.parse(
	readFileSync(
		require.resolve('revm-wasm').replace(/dist[/\\]index\.js$/, 'package.json'),
		'utf8',
	),
).version;

const wasmBytes = readFileSync(fileURLToPath(wasmUrl));
const wasmModule = new WebAssembly.Module(wasmBytes);

console.log('\n=== probe-cold-access-key-cost ===');
await printEnvironment();
console.log(`  revm-wasm ${revmVersion}`);

// --------------------------------------------------------------- fixture ----

const N = 2000;
const CONTRACT = Uint8Array.from(
	Buffer.from('00000000000000000000000000000000000000c0', 'hex'),
);
const CALLER = Uint8Array.from(
	Buffer.from('00000000000000000000000000000000000f0000', 'hex'),
);

/**
 * A loop of `N` SLOADs: distinct slots (all COLD, one host callback each) or the
 * same slot (WARM after the first, one callback in total).
 */
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

/** The 32-byte slot values the stores are preloaded with. */
function slotBytes(i) {
	const b = new Uint8Array(32);
	b[30] = (i >> 8) & 0xff;
	b[31] = i & 0xff;
	return b;
}
const VALUE = new Uint8Array(32).fill(7);

// ------------------------------------------------------- the four stores ----

const HEX = (() => {
	const t = [];
	for (let i = 0; i < 256; i++) t.push(i.toString(16).padStart(2, '0'));
	return t;
})();
/** `src/revm-state-store.ts`'s addrKey: `0x`-prefixed lowercase hex, per access. */
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
/** `revm-wasm`'s MemoryStore key: two bytes per UTF-16 code unit. */
function packKey(a) {
	let s = '';
	for (let i = 0; i < a.length; i += 2) s += String.fromCharCode((a[i] << 8) | a[i + 1]);
	return s;
}

const EMPTY_CODE_HASH = keccak_256(new Uint8Array());
const CONTRACT_CODE_HASH_DISTINCT = keccak_256(CODE_DISTINCT);
const CONTRACT_CODE_HASH_SAME = keccak_256(CODE_SAME);

/** Accounts and code are identical across stores; only STORAGE differs. */
function commonParts() {
	const code = new Map([
		[hexOf(CONTRACT_CODE_HASH_DISTINCT), CODE_DISTINCT],
		[hexOf(CONTRACT_CODE_HASH_SAME), CODE_SAME],
		[hexOf(EMPTY_CODE_HASH), new Uint8Array()],
	]);
	return {
		codeByHash: code,
		accountOf(addressKey, contractKey, codeHash) {
			return addressKey === contractKey
				? {balance: 0n, nonce: 0n, codeHash}
				: {balance: 10n ** 20n, nonce: 0n, codeHash: EMPTY_CODE_HASH};
		},
	};
}

/**
 * THE SHIPPED SHAPE: one flat map keyed `${addressHex}_${slotHex}`, with the
 * address key and the concatenation rebuilt on every access, exactly as
 * `SimpleStateManagerStore#storageOf` does.
 */
function flatHexStore(codeHash) {
	const parts = commonParts();
	const contractKey = addrKeyHex(CONTRACT);
	const storage = new Map();
	for (let i = 0; i < N; i++) storage.set(`${contractKey}_0x${hexOf(slotBytes(i))}`, VALUE);
	return {
		label: 'flat hex (shipped)',
		getAccount: (a) => parts.accountOf(addrKeyHex(a), contractKey, codeHash),
		getStorage: (a, slot) => storage.get(`${addrKeyHex(a)}_0x${hexOf(slot)}`),
		getCode: (h) => parts.codeByHash.get(hexOf(h)),
		getBlockHash: () => undefined,
	};
}

/** Per-account, same hex key format: one map lookup replaces the concatenation. */
function perAccountHexStore(codeHash) {
	const parts = commonParts();
	const contractKey = addrKeyHex(CONTRACT);
	const inner = new Map();
	for (let i = 0; i < N; i++) inner.set(`0x${hexOf(slotBytes(i))}`, VALUE);
	const storage = new Map([[contractKey, inner]]);
	return {
		label: 'per-account, hex keys',
		getAccount: (a) => parts.accountOf(addrKeyHex(a), contractKey, codeHash),
		getStorage: (a, slot) => storage.get(addrKeyHex(a))?.get(`0x${hexOf(slot)}`),
		getCode: (h) => parts.codeByHash.get(hexOf(h)),
		getBlockHash: () => undefined,
	};
}

/**
 * Per-account with `revm-wasm`'s own packed key encoding (ten code units for an
 * address, sixteen for a slot). Only reachable if the NODE owns the key format,
 * which is precisely what re-layering `SimpleStateManager`'s storage would mean.
 */
function perAccountPackedStore(codeHash) {
	const parts = commonParts();
	const contractKey = addrKeyHex(CONTRACT);
	const inner = new Map();
	for (let i = 0; i < N; i++) inner.set(packKey(slotBytes(i)), VALUE);
	const storage = new Map([[packKey(CONTRACT), inner]]);
	return {
		label: 'per-account, packed keys',
		getAccount: (a) => parts.accountOf(addrKeyHex(a), contractKey, codeHash),
		getStorage: (a, slot) => storage.get(packKey(a))?.get(packKey(slot)),
		getCode: (h) => parts.codeByHash.get(hexOf(h)),
		getBlockHash: () => undefined,
	};
}

/** The floor: answers without looking at the key at all. Isolates the crossing. */
function nullStore(codeHash) {
	const parts = commonParts();
	const contractKey = addrKeyHex(CONTRACT);
	return {
		label: 'null store (crossing only)',
		getAccount: (a) => parts.accountOf(addrKeyHex(a), contractKey, codeHash),
		getStorage: () => VALUE,
		getCode: (h) => parts.codeByHash.get(hexOf(h)),
		getBlockHash: () => undefined,
	};
}

const STORES = [flatHexStore, perAccountHexStore, perAccountPackedStore, nullStore];

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
	const codeHash = distinct ? CONTRACT_CODE_HASH_DISTINCT : CONTRACT_CODE_HASH_SAME;
	const store = makeStore(codeHash);
	let callbacks = 0;
	const counted = {
		...store,
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

{
	const c = cold.get('flat hex (shipped)');
	const w = warm.get('flat hex (shipped)');
	check(
		'one host callback per COLD access, one in total when the slot is warm',
		c.status === 'success' &&
			w.status === 'success' &&
			c.callbacksPerCall === N &&
			w.callbacksPerCall === 1,
		`gas: cold ${c.gas}, warm ${w.gas} (the ${c.gas - w.gas} difference is EIP-2929 cold-vs-warm, i.e. 2000 x 1999)`,
	);
}

const perAccess = (label) =>
	((cold.get(label).ms - warm.get(label).ms) * 1000) / N;
const flatCost = perAccess('flat hex (shipped)');
const nullCost = perAccess('null store (crossing only)');
const hexCost = perAccess('per-account, hex keys');
const packedCost = perAccess('per-account, packed keys');

console.log('\n[2] what fraction of a cold access is KEY HANDLING, and what a');
console.log('    per-account layout recovers');
table(
	['quantity', 'µs', 'share of the shipped cold access'],
	[
		['shipped flat-hex access', µs(flatCost), '100%'],
		['crossing alone (null store)', µs(nullCost), `${((nullCost / flatCost) * 100).toFixed(0)}%`],
		['key handling (flat - null)', µs(flatCost - nullCost), `${(((flatCost - nullCost) / flatCost) * 100).toFixed(0)}%`],
		['recovered by per-account hex', µs(flatCost - hexCost), `${(((flatCost - hexCost) / flatCost) * 100).toFixed(0)}%`],
		['recovered by per-account packed', µs(flatCost - packedCost), `${(((flatCost - packedCost) / flatCost) * 100).toFixed(0)}%`],
	],
);

// -------------------------------------------- 3. the same, without wasm -----

console.log('\n[3] the JS half alone (no wasm): build the key(s) and do the lookup(s)');

const contractKeyHex = addrKeyHex(CONTRACT);
const flatMap = new Map();
const nestedHex = new Map([[contractKeyHex, new Map()]]);
const nestedPacked = new Map([[packKey(CONTRACT), new Map()]]);
for (let i = 0; i < N; i++) {
	const s = slotBytes(i);
	flatMap.set(`${contractKeyHex}_0x${hexOf(s)}`, VALUE);
	nestedHex.get(contractKeyHex).set(`0x${hexOf(s)}`, VALUE);
	nestedPacked.get(packKey(CONTRACT)).set(packKey(s), VALUE);
}
let k = 0;
const jsRows = [
	[
		'flat hex (shipped)',
		µs(
			bench(() => {
				const s = slotBytes(k++ % N);
				return flatMap.get(`${addrKeyHex(CONTRACT)}_0x${hexOf(s)}`);
			}),
		),
	],
	[
		'per-account, hex keys',
		µs(
			bench(() => {
				const s = slotBytes(k++ % N);
				return nestedHex.get(addrKeyHex(CONTRACT))?.get(`0x${hexOf(s)}`);
			}),
		),
	],
	[
		'per-account, packed keys',
		µs(
			bench(() => {
				const s = slotBytes(k++ % N);
				return nestedPacked.get(packKey(CONTRACT))?.get(packKey(s));
			}),
		),
	],
	['slotBytes() alone (the probe\'s own overhead)', µs(bench(() => slotBytes(k++ % N)))],
];
table(['lookup', 'µs per access'], jsRows);

exitWithFailures();
