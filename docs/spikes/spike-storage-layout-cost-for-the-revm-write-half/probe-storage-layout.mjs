/**
 * probe-storage-layout.mjs: Q1 (checkpoint), Q2 (clearStorage) and Q3 (what a
 * per-account copy-on-write layout changes), measured on the state manager
 * itself.
 *
 * Section 1 is CORRECTNESS and it runs first on purpose: a faster wrong layout
 * is worth nothing, so no timing in this file means anything until the
 * checkpoint/revert and commit semantics are demonstrated, including a naive
 * per-account layout FAILING the same checks, so the checks are known to have
 * teeth.
 *
 *   node docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/probe-storage-layout.mjs
 *
 * Needs the repo installed (`pnpm install`, which also builds the node's
 * `dist/`). It installs nothing and touches no state outside its own process.
 */
import {
	bench,
	check,
	exitWithFailures,
	printEnvironment,
	table,
	util,
	µs,
} from './support.mjs';
import {
	dumpFlatStorage,
	FlatStorageStateManager,
	NaivePerAccountStorageStateManager,
	PerAccountStorageStateManager,
} from './per-account-storage.mjs';
import {OverlayFlatStateManager} from './overlay-flat-storage.mjs';
import {PerAccountOverlayStateManager} from './per-account-overlay-storage.mjs';

const {createAddressFromString, bytesToHex, hexToBytes} = util;

const addr = (i) =>
	createAddressFromString(`0x${i.toString(16).padStart(40, '0')}`);
const slot = (i) => hexToBytes(`0x${i.toString(16).padStart(64, '0')}`);
const val = (i) => hexToBytes(`0x${i.toString(16).padStart(2, '0')}`);

/** All four layouts expose the same API; the probe never special-cases one. */
const LAYOUTS = [
	['flat (shipped)', () => new FlatStorageStateManager()],
	['per-account CoW', () => new PerAccountStorageStateManager()],
	['flat + overlay', () => new OverlayFlatStateManager()],
	['per-account + overlay', () => new PerAccountOverlayStateManager()],
];
const LAYOUT_NAMES = LAYOUTS.map(([name]) => name);

/**
 * Snapshot storage in one shape whatever the layout, for diffing.
 *
 * Keys are SORTED. The two layouts genuinely differ in iteration order (the flat
 * map is in global insertion order, the per-account one is grouped by account),
 * and that difference is not a divergence: nothing in the node depends on
 * storage iteration order: `dumpState` builds an object keyed by address, and
 * `loadState` reads it back by key. Comparing raw insertion order would report a
 * failure that is an artefact of the probe.
 */
function dump(sm) {
	const raw = sm.dumpStorage ? sm.dumpStorage() : dumpFlatStorage(sm);
	return Object.fromEntries(
		Object.entries(raw).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

async function fill(sm, {accounts, slotsPerAccount}) {
	for (let a = 0; a < accounts; a++) {
		const A = addr(a + 1);
		for (let s = 0; s < slotsPerAccount; s++) {
			await sm.putStorage(A, slot(s), val((a + s) % 251 || 1));
		}
	}
	return sm;
}

console.log('\n=== probe-storage-layout ===');
await printEnvironment();

// ---------------------------------------------------------------------------
console.log('\n[1] CORRECTNESS of the copy-on-write prototype');
console.log('    (the naive shared-inner-map version is run against the same');
console.log('     checks as a control: it MUST fail them)');

const A1 = addr(1);
const A2 = addr(2);

/** checkpoint -> write -> revert: the parent's value must be untouched. */
async function revertDoesNotLeak(make) {
	const sm = make();
	await sm.putStorage(A1, slot(0), val(1));
	await sm.checkpoint();
	await sm.putStorage(A1, slot(0), val(42));
	await sm.putStorage(A1, slot(9), val(9));
	await sm.revert();
	const after = bytesToHex(await sm.getStorage(A1, slot(0)));
	const stray = bytesToHex(await sm.getStorage(A1, slot(9)));
	return after === '0x01' && stray === '0x';
}

/** checkpoint -> write -> commit: the write must survive. */
async function commitKeeps(make) {
	const sm = make();
	await sm.putStorage(A1, slot(0), val(1));
	await sm.checkpoint();
	await sm.putStorage(A1, slot(0), val(42));
	await sm.commit();
	return bytesToHex(await sm.getStorage(A1, slot(0))) === '0x2a';
}

/** Three frames deep, inner committed into a reverted outer: nothing survives. */
async function nestedCommitInsideRevert(make) {
	const sm = make();
	await sm.putStorage(A1, slot(0), val(1));
	await sm.checkpoint(); // frame 1
	await sm.putStorage(A1, slot(0), val(2));
	await sm.checkpoint(); // frame 2
	await sm.putStorage(A1, slot(0), val(3));
	await sm.commit(); // frame 2 into frame 1
	const mid = bytesToHex(await sm.getStorage(A1, slot(0)));
	await sm.revert(); // frame 1 dropped
	const end = bytesToHex(await sm.getStorage(A1, slot(0)));
	return mid === '0x03' && end === '0x01';
}

/** A committed frame must not have been mutating the frame below all along. */
async function commitThenRevertOuter(make) {
	const sm = make();
	await sm.putStorage(A1, slot(0), val(1));
	await sm.checkpoint(); // outer
	await sm.checkpoint(); // inner
	await sm.putStorage(A1, slot(0), val(7));
	await sm.commit(); // inner -> outer
	await sm.revert(); // outer dropped, so the 7 must go with it
	return bytesToHex(await sm.getStorage(A1, slot(0))) === '0x01';
}

/** clearStorage inside a reverted frame must not destroy the parent's storage. */
async function clearIsRevertSafe(make) {
	const sm = make();
	await sm.putStorage(A1, slot(0), val(1));
	await sm.putStorage(A1, slot(1), val(2));
	await sm.putStorage(A2, slot(0), val(3));
	await sm.checkpoint();
	await sm.clearStorage(A1);
	const cleared = bytesToHex(await sm.getStorage(A1, slot(0))) === '0x';
	await sm.revert();
	const restored =
		bytesToHex(await sm.getStorage(A1, slot(0))) === '0x01' &&
		bytesToHex(await sm.getStorage(A1, slot(1))) === '0x02';
	// and the committed case
	const sm2 = make();
	await sm2.putStorage(A1, slot(0), val(1));
	await sm2.putStorage(A2, slot(0), val(3));
	await sm2.checkpoint();
	await sm2.clearStorage(A1);
	await sm2.commit();
	const gone = bytesToHex(await sm2.getStorage(A1, slot(0))) === '0x';
	const neighbourKept = bytesToHex(await sm2.getStorage(A2, slot(0))) === '0x03';
	return cleared && restored && gone && neighbourKept;
}

const SEMANTICS = [
	['a write in a REVERTED frame does not survive', revertDoesNotLeak],
	['a write in a COMMITTED frame does survive', commitKeeps],
	['commit into a frame that is then reverted takes the write with it', commitThenRevertOuter],
	['three frames deep, commit-then-revert leaves the original', nestedCommitInsideRevert],
	['clearStorage is revert-safe and account-local', clearIsRevertSafe],
];

// The flat layout is the reference implementation of these semantics; the other
// two must match it exactly.
for (const [name, make] of LAYOUTS) {
	for (const [label, fn] of SEMANTICS) {
		check(`${name}: ${label}`, await fn(make));
	}
}
{
	const naiveResults = [];
	for (const [, fn] of SEMANTICS)
		naiveResults.push(await fn(() => new NaivePerAccountStorageStateManager()));
	const failed = naiveResults.filter((r) => !r).length;
	check(
		'CONTROL: the naive per-account layout (shared inner maps) FAILS these checks',
		failed > 0,
		`${failed}/${SEMANTICS.length} failed, so copy-on-write is load-bearing`,
	);
}

// ---------------------------------------------------------------------------
console.log('\n[1b] DIFFERENTIAL against the shipped flat layout: 20000 random ops');

/** xorshift32, so the sequence is identical on every machine and every run. */
function prng(seed) {
	let x = seed >>> 0;
	return () => {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5;
		x >>>= 0;
		return x / 0x100000000;
	};
}

async function fuzz(make, ops = 20000, seed = 0x2b1d) {
	const rnd = prng(seed);
	const sm = make();
	let depth = 0;
	const trace = [];
	for (let i = 0; i < ops; i++) {
		const r = rnd();
		const A = addr(1 + Math.floor(rnd() * 8));
		const S = slot(Math.floor(rnd() * 12));
		if (r < 0.5) await sm.putStorage(A, S, val(1 + Math.floor(rnd() * 250)));
		else if (r < 0.62) trace.push(bytesToHex(await sm.getStorage(A, S)));
		else if (r < 0.68) await sm.clearStorage(A);
		else if (r < 0.84) {
			await sm.checkpoint();
			depth++;
		} else if (depth > 0) {
			if (rnd() < 0.5) await sm.commit();
			else await sm.revert();
			depth--;
		}
		if (i % 500 === 0) trace.push(JSON.stringify(dump(sm)));
	}
	while (depth-- > 0) await sm.commit();
	return {trace: trace.join('|'), final: JSON.stringify(dump(sm))};
}

const flatFuzz = await fuzz(() => new FlatStorageStateManager());
const naiveFuzz = await fuzz(() => new NaivePerAccountStorageStateManager());
for (const [name, make] of LAYOUTS.slice(1)) {
	const f = await fuzz(make);
	check(
		`${name} matches the flat layout on every read and every snapshot`,
		flatFuzz.trace === f.trace && flatFuzz.final === f.final,
	);
}
check(
	'CONTROL: the naive layout DIVERGES on the same sequence',
	flatFuzz.trace !== naiveFuzz.trace,
);

// ---------------------------------------------------------------------------
console.log('\n[2] Q1: what one CHECKPOINT costs, by state size (microseconds)');
console.log('    dense = slots spread over 10 accounts; sparse = 1 slot per account');

const SIZES = [1_000, 10_000, 100_000];
const checkpointRows = [];
const commitRevertRows = [];

for (const total of SIZES) {
	for (const shape of ['dense', 'sparse']) {
		const accounts = shape === 'dense' ? 10 : total;
		const slotsPerAccount = total / accounts;
		const row = [`${total} slots / ${shape}`, accounts];
		const cr = [`${total} slots / ${shape}`, accounts];
		for (const [, make] of LAYOUTS) {
			const sm = await fill(make(), {accounts, slotsPerAccount});
			const depth = () =>
				sm.storageFrames?.length ??
				sm.overlays?.length ??
				sm.diffs?.length ??
				sm.storageStack.length;
			row.push(
				µs(
					bench(() => sm.checkpointSync(), {
						// keep the stack shallow: undo the previous iteration's push
						setup: () => {
							if (depth() > 1) sm.revert();
						},
					}),
				),
			);
			// commit and revert, each measured against a freshly pushed frame
			cr.push(
				µs(bench(() => sm.commit(), {setup: () => sm.checkpointSync()})),
				µs(bench(() => sm.revert(), {setup: () => sm.checkpointSync()})),
			);
		}
		checkpointRows.push(row);
		commitRevertRows.push(cr);
	}
}
table(['state', 'accounts', ...LAYOUT_NAMES.map((n) => `${n} µs`)], checkpointRows);
console.log('');
table(
	[
		'state',
		'accounts',
		...LAYOUT_NAMES.flatMap((n) => [`${n} commit`, `${n} revert`]),
	],
	commitRevertRows,
);

// ---------------------------------------------------------------------------
console.log('\n[3] Q2: what clearStorage costs (microseconds), one account of 100 slots');

const clearRows = [];
for (const total of SIZES) {
	const accounts = Math.max(10, total / 100);
	const slotsPerAccount = total / accounts;
	const row = [`${total} slots over ${accounts} accounts`];
	for (const [, make] of LAYOUTS) {
		const sm = await fill(make(), {accounts, slotsPerAccount});
		// Re-fill the cleared account before each timed clear, untimed.
		const target = addr(1);
		const refill = () => {
			for (let s = 0; s < slotsPerAccount; s++)
				sm.putStorage(target, slot(s), val(s % 251 || 1));
		};
		row.push(µs(bench(() => sm.clearStorage(target), {setup: refill})));
		// The overlay defers the scan to the commit that merges the clear down into
		// the base frame, so the clear alone is not the whole story: time the pair.
		row.push(
			µs(
				bench(
					() => {
						sm.clearStorage(target);
						sm.commit();
					},
					{
						setup: () => {
							refill();
							sm.checkpointSync();
						},
					},
				),
			),
		);
	}
	clearRows.push(row);
}
table(
	['state', ...LAYOUT_NAMES.flatMap((n) => [`${n} clear`, `${n} clear+commit`])],
	clearRows,
);

// ---------------------------------------------------------------------------
console.log('\n[4] Q3: per-slot read and write through the state manager API (microseconds)');
console.log('    (async API, i.e. what @ethereumjs/evm pays; revm reads the map');
console.log('     directly and is measured end-to-end in probe-cold-access-key-cost)');

const rwRows = [];
for (const total of SIZES) {
	const accounts = Math.max(10, total / 100);
	const slotsPerAccount = total / accounts;
	const row = [`${total} slots`];
	for (const [, make] of LAYOUTS) {
		const sm = await fill(make(), {accounts, slotsPerAccount});
		const A = addr(1);
		let i = 0;
		row.push(
			µs(bench(() => sm.getStorage(A, slot(i++ % slotsPerAccount)))),
			µs(bench(() => sm.putStorage(A, slot(i++ % slotsPerAccount), val(7)))),
		);
	}
	rwRows.push(row);
}
table(
	['state', ...LAYOUT_NAMES.flatMap((n) => [`${n} read`, `${n} write`])],
	rwRows,
);
console.log('  (at checkpoint depth 1; an overlay layout\'s read cost grows with depth)');

console.log('\n[4b] Q3: what an OVERLAY read costs as frame depth grows');
console.log('     (the EVM checkpoints per message frame, so depth is call nesting)');

const depthRows = [];
for (const depth of [1, 2, 4, 8]) {
	const row = [depth];
	for (const [, make] of LAYOUTS) {
		const sm = await fill(make(), {accounts: 100, slotsPerAccount: 100});
		for (let d = 1; d < depth; d++) sm.checkpointSync();
		const A = addr(1);
		let i = 0;
		// The slot lives in the BASE frame, so every frame above is walked: the
		// worst case for an overlay, and the common one (a read of committed state).
		row.push(µs(bench(() => sm.getStorage(A, slot(i++ % 100)))));
	}
	depthRows.push(row);
}
table(['frame depth', ...LAYOUT_NAMES.map((n) => `${n} read`)], depthRows);

// ---------------------------------------------------------------------------
console.log('\n[5] Q3: the PATHOLOGICAL case for copy-on-write:');
console.log('    one frame writing ONE slot each across many accounts,');
console.log('    where every account already holds `slots each` slots.');
console.log('    Cost of the whole frame: checkpoint + the writes + commit.');

const pathoRows = [];
for (const [accountsTouched, slotsEach] of [
	[10, 100],
	[100, 100],
	[100, 1_000],
	[1_000, 100],
]) {
	const accounts = Math.max(accountsTouched, 1_000);
	const row = [`${accountsTouched} accounts touched`, slotsEach, accounts * slotsEach];
	for (const [, make] of LAYOUTS) {
		const sm = await fill(make(), {accounts, slotsPerAccount: slotsEach});
		row.push(
			µs(
				bench(
					() => {
						sm.checkpointSync();
						for (let a = 0; a < accountsTouched; a++)
							sm.putStorage(addr(a + 1), slot(9999), val(3));
						sm.commit();
					},
					{minMs: 30, minIters: 3},
				),
			),
		);
	}
	pathoRows.push(row);
}
table(
	['frame', 'slots each', 'total slots', ...LAYOUT_NAMES.map((n) => `${n} µs`)],
	pathoRows,
);

exitWithFailures();
