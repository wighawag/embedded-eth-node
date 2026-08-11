/**
 * measure-transaction-cost.mjs — what a TRANSACTION costs on each engine, by
 * transaction SHAPE, against the baseline as it stands today.
 *
 *   pnpm install   # also builds packages/embedded-eth-node/dist, which this reads
 *   node docs/spikes/measure-what-transactions-on-revm-actually-cost/measure-transaction-cost.mjs
 *
 * Story 8 of `work/specs/tasked/revm-engine-behind-runtx.md` wants transaction
 * execution "measurably faster", and the honest form of that is a measurement.
 * Every number in ./measurements.md is a line this script printed; it exits
 * non-zero if any of its own checks fail, so a stale figure in that document is a
 * RED RUN rather than a wrong document.
 *
 * ## Why the numbers this task inherited could not simply be restated
 *
 * The transaction figures in this repo were taken at three different baselines,
 * and two of them moved AFTER the document this task was pointed at:
 *
 *   - ADR 0009 (`re-layer-storage-as-per-account-maps-with-per-frame-diffs`)
 *     stopped the state manager copying ALL of storage per message frame, which
 *     used to dominate a transaction. That is the baseline
 *     `docs/spikes/re-layer-storage-as-per-account-maps-with-per-frame-diffs/measurements.md`
 *     reports.
 *   - `sender-recovery-uses-the-engines-ecrecover` then moved a FIXED
 *     per-transaction cost onto the engine (~1.6 ms of JS ecrecover to ~0.4 ms).
 *   - `revm-state-store-packed-storage-keys` then took a cold revm storage access
 *     from 1.31-1.33 µs to 0.36-0.39 µs, which is the per-COLD-ACCESS term of
 *     every shape below.
 *
 * So the denominator has moved twice since, and the SHARE of a transaction that
 * any one term accounts for is a different number now. Nothing here is quoted;
 * it is all re-derived at whatever commit you run it on.
 *
 * ## The five windows, and why they are five
 *
 *  1. REFERENCE GAS. The three figures every change in this repo restates
 *     (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 and its
 *     result hash), asserted here on BOTH engines. A timing document whose engines
 *     disagree about gas is measuring two different things, so this runs first and
 *     the rest is only worth reading if it passes.
 *  2. COST BY SHAPE. Pre-signed transactions of six shapes through the node's own
 *     public surface (`eth_sendRawTransactionSync` / `evm_sendRawTransactionSyncAs`),
 *     auto-mining, on the default `@ethereumjs/evm` engine and on
 *     `embedded-eth-node/revm`, in `senderMode:'recover'` and `'trusted'`. This is
 *     what a consumer actually pays per transaction.
 *  3. SENDER RECOVERY, SEPARATED. The `'recover'` minus `'trusted'` difference of
 *     window 2, per shape and per engine. It is a FIXED per-transaction cost, so
 *     reading it as a share of a transaction is only meaningful next to the shape
 *     it is a share OF — which is exactly why the two levers are reported apart.
 *  4. THE COMMIT PATH, which had never been benchmarked. The node's state is
 *     written through host callbacks on revm (`SimpleStateManagerStore`, ADR 0010)
 *     and through the state manager's own methods on the default engine, and both
 *     are COUNTED here per shape, with the coinbase measured both ways: credited a
 *     real priority fee, and deleted when the tip is zero.
 *  5. THE CROSSOVER. Cost against the number of DISTINCT storage slots a
 *     transaction touches, which is the axis the host-callback design is most
 *     sensitive to (a boundary crossing is paid once per COLD access, ADR 0010)
 *     and the one the ADR names as the reason to revisit it.
 *
 * ## How to read it
 *
 * READ THE RATIOS AND THE SHAPES, NOT THE MILLISECONDS. This runs under Node on an
 * ordinary developer machine, not the browser the library ships to; absolute
 * values are load-sensitive and the allocation-heavy rows move tens of percent
 * between runs. Every ratio is between rows measured in the SAME run. Run it
 * twice and prefer what survives both, exactly as
 * `docs/spikes/re-layer-storage-as-per-account-maps-with-per-frame-diffs/measurements.md`
 * asks its own tables to be read.
 *
 * ## Instrumentation, and the way it could lie
 *
 * Window 4 counts by patching the PROTOTYPES the node's own build uses, reached
 * from the classes in `packages/embedded-eth-node/dist/` — the same module
 * instances `dist/node.js` and `dist/revm.js` import, so there is no second copy
 * of a class to patch by mistake (the hazard
 * `spike-storage-layout-cost-for-the-revm-write-half/support.mjs` has an assertion
 * for, which cannot arise here because the chain is walked FROM the node's own
 * class rather than from a separately resolved one). A counter that patched the
 * wrong object would report ZERO and read exactly like "this engine does no
 * writes", so every count is additionally asserted non-zero.
 *
 * Windows 2, 3 and 5 run with NO patches installed. Timing an instrumented store
 * would fold the instrument into the answer.
 *
 * Spike code: nothing under `packages/` imports it.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {
	check,
	exitWithFailures,
	printEnvironment,
	REPO_ROOT,
	table,
} from '../spike-storage-layout-cost-for-the-revm-write-half/support.mjs';

const NODE_PKG = new URL('packages/embedded-eth-node/', REPO_ROOT);
const require = createRequire(new URL('package.json', NODE_PKG));

const {createNode} = await import(new URL('dist/index.js', NODE_PKG).href);
const {createRevmEngine} = await import(new URL('dist/revm.js', NODE_PKG).href);
// The two classes window 4 counts through. Imported from the node's OWN build,
// which is what makes the patch land on the objects the node uses.
const {OverlayStorageStateManager} = await import(
	new URL('dist/state-manager.js', NODE_PKG).href
);
const {SimpleStateManagerStore} = await import(
	new URL('dist/revm-state-store.js', NODE_PKG).href
);
// The reference contract, shared with the test suite rather than copied: it is a
// plain `export const` file with no imports, and Node strips its types.
const {counterAbi, counterBytecode} = await import(
	new URL('test/helpers/counter.ts', NODE_PKG).href
);
const {privateKeyToAccount} = await import(require.resolve('viem/accounts'));
const {encodeFunctionData, decodeFunctionResult} = await import(
	require.resolve('viem')
);
const {wasmUrl} = await import(require.resolve('revm-wasm/wasm-url'));
const wasm = await WebAssembly.compile(readFileSync(fileURLToPath(wasmUrl)));

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(PK);
const CHAIN_ID = 31337;
const RECIPIENT = '0x00000000000000000000000000000000000000cc';
/** Where every shape that needs runtime code is seeded, via `evm_setCode`. */
const CONTRACT = '0x00000000000000000000000000000000000000c0';
const GENESIS_BALANCE = 10n ** 24n;
// `maxFeePerGas` and `maxPriorityFeePerGas`. The node's default base fee is 1
// gwei, so this pays a 1 gwei tip: the coinbase is CREDITED on every transaction
// here rather than deleted, which is the case window 4 measures both ways.
const MAX_FEE = 2_000_000_000n;
const TIP = 1_000_000_000n;

const hexOf = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;
const ms = (n) => (n < 10 ? n.toFixed(3) : n.toFixed(2));
const ratio = (a, b) => `${(a / b).toFixed(2)}x`;

console.log('\n=== measure-transaction-cost ===');
await printEnvironment();
console.log(
	`  revm-wasm ${JSON.parse(readFileSync(require.resolve('revm-wasm/package.json'), 'utf8')).version}`,
);

// ---------------------------------------------------------------------------
// engines and nodes
// ---------------------------------------------------------------------------

/**
 * A node on one engine. `engine: 'default'` passes NO engine at all, which is
 * how a consumer gets `@ethereumjs/evm` — never a hand-built one, so this row
 * really is the shipped default path.
 */
async function makeNode(engine, senderMode) {
	return createNode({
		chainId: CHAIN_ID,
		senderMode,
		miningConfig: {type: 'auto'},
		initialBalances: {
			[account.address]: GENESIS_BALANCE,
			[RECIPIENT]: GENESIS_BALANCE,
		},
		engine: engine === 'revm' ? await createRevmEngine({wasm}) : undefined,
	});
}

const ENGINES = ['default', 'revm'];
const MODES = ['recover', 'trusted'];

/** Send one pre-signed transaction, through the path the sender mode implies. */
const send = (node, raw, trusted) =>
	trusted
		? node.request({
				method: 'evm_sendRawTransactionSyncAs',
				params: [raw, account.address],
			})
		: node.request({method: 'eth_sendRawTransactionSync', params: [raw]});

// ---------------------------------------------------------------------------
// the shapes
// ---------------------------------------------------------------------------

/**
 * Runtime code that SLOADs `n` DISTINCT slots and does nothing else.
 *
 * Hand-assembled, like the probes in
 * `docs/spikes/revm-executes-the-first-transaction-with-commit/` and
 * `docs/spikes/revm-state-store-packed-storage-keys/`, because the point is to
 * isolate ONE opcode: a Solidity loop would add its own arithmetic and memory to
 * every iteration and the cost would stop being attributable to the accesses.
 * Every slot is UNSET, so every answer is zero — what is being measured is how
 * many times the question crossed the boundary, not what came back.
 */
function sloadLoop(n) {
	return Uint8Array.from([
		0x61, (n >> 8) & 0xff, n & 0xff, // PUSH2 n
		0x60, 0x00, // PUSH1 0  -> i
		0x5b, // JUMPDEST (offset 5)
		0x80, 0x54, 0x50, // DUP1 (i), SLOAD, POP
		0x60, 0x01, 0x01, // PUSH1 1, ADD -> i+1
		0x81, 0x81, 0x10, // DUP2 (n), DUP2 (i+1), LT
		0x60, 0x05, 0x57, // PUSH1 5, JUMPI
		0x00, // STOP
	]);
}

/**
 * Runtime code that SSTOREs three slots, based at the 32-byte word in CALLDATA.
 *
 * THE BASE COMES FROM CALLDATA on purpose. A fixed slot would be a cold
 * zero-to-nonzero SSTORE (20,000 gas) on the FIRST transaction of a batch and a
 * warm no-op (100 gas) on every one after it, so the batch average would measure
 * a shape nobody asked for. Each transaction passes a different base, so all of
 * them are the shape the row is named after.
 */
const SSTORE3 = Uint8Array.from([
	0x60, 0x00, 0x35, // PUSH1 0, CALLDATALOAD  -> base
	0x60, 0x01, 0x81, 0x55, // PUSH1 1, DUP2 (base), SSTORE
	0x60, 0x01, 0x81, 0x60, 0x01, 0x01, 0x55, // ... base+1
	0x60, 0x01, 0x81, 0x60, 0x02, 0x01, 0x55, // ... base+2
	0x00, // STOP
]);

/**
 * Runtime code that SSTOREs `n` DISTINCT slots, based at the 32-byte word in
 * CALLDATA for the same reason {@link SSTORE3} is.
 *
 * This is the shape the COMMIT path is sensitive to: `n` slots written means `n`
 * `setStorage` callbacks arriving at the end of the execution, where the
 * three-slot shape leaves the commit too small to see.
 */
function sstoreLoop(n) {
	return Uint8Array.from([
		0x60, 0x00, 0x35, // PUSH1 0, CALLDATALOAD -> base
		0x61, (n >> 8) & 0xff, n & 0xff, // PUSH2 n
		0x60, 0x00, // PUSH1 0 -> i
		0x5b, // JUMPDEST (offset 8)
		0x60, 0x01, // PUSH1 1                 (the value)
		0x81, // DUP2 (i)
		0x84, // DUP5 (base)
		0x01, // ADD  -> base + i             (the key)
		0x55, // SSTORE
		0x60, 0x01, 0x01, // PUSH1 1, ADD -> i+1
		0x81, 0x81, 0x10, // DUP2 (n), DUP2 (i+1), LT
		0x60, 0x08, 0x57, // PUSH1 8, JUMPI
		0x00, // STOP
	]);
}

/** Runtime code that emits `n` LOG1 events of 32 zero bytes each. */
function logLoop(n) {
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push(0x60, 0x2a, 0x60, 0x20, 0x60, 0x00, 0xa1); // topic, size, offset, LOG1
	}
	out.push(0x00); // STOP
	return Uint8Array.from(out);
}

/** Init code that deploys `runtime` — the standard CODECOPY/RETURN prelude. */
function deployerFor(runtime) {
	const prelude = [
		0x60, runtime.length, // PUSH1 len
		0x80, // DUP1
		0x60, 0x0b, // PUSH1 11 (this prelude's own length)
		0x60, 0x00, // PUSH1 0
		0x39, // CODECOPY
		0x60, 0x00, // PUSH1 0
		0xf3, // RETURN
	];
	return Uint8Array.from([...prelude, ...runtime]);
}

/** A 32-byte word holding `n`, used as the SSTORE shape's slot base. */
function word(n) {
	const b = new Uint8Array(32);
	b[27] = (n >>> 24) & 0xff;
	b[28] = (n >>> 16) & 0xff;
	b[29] = (n >>> 8) & 0xff;
	b[30] = n & 0xff;
	b[31] = 0x11; // keep the low byte non-zero so calldata gas does not vary
	return b;
}

const DISTINCT_SLOTS = 256;
const WRITTEN_SLOTS = 256;
const LOG_COUNT = 8;

/**
 * The six shapes, chosen because one number for "a transaction" hides the
 * answer: they differ in what they make the SEAM do, not merely in how much gas
 * they burn.
 *
 * `txs` is the batch size for the timed rows. It is per shape because a 4,096-slot
 * transaction is two orders of magnitude more work than a transfer, and one batch
 * size for both would either take minutes or measure noise.
 */
const SHAPES = [
	{
		name: 'transfer',
		what: 'a 21,000-gas value transfer to an EOA',
		code: undefined,
		txs: 40,
		tx: () => ({to: RECIPIENT, value: 1n, gas: 21_000n}),
	},
	{
		name: 'storage write',
		what: '3 cold zero-to-nonzero SSTOREs',
		code: SSTORE3,
		txs: 40,
		tx: (nonce) => ({
			to: CONTRACT,
			value: 0n,
			gas: 200_000n,
			data: hexOf(word(nonce)),
		}),
	},
	{
		name: `${DISTINCT_SLOTS} distinct slots`,
		what: `${DISTINCT_SLOTS} SLOADs of DISTINCT slots, i.e. ${DISTINCT_SLOTS} cold accesses`,
		code: sloadLoop(DISTINCT_SLOTS),
		txs: 20,
		tx: () => ({to: CONTRACT, value: 0n, gas: 2_000_000n}),
	},
	{
		name: `${WRITTEN_SLOTS} slot writes`,
		what: `${WRITTEN_SLOTS} cold zero-to-nonzero SSTOREs of DISTINCT slots`,
		code: sstoreLoop(WRITTEN_SLOTS),
		txs: 10,
		tx: (nonce) => ({
			to: CONTRACT,
			value: 0n,
			gas: 29_000_000n,
			data: hexOf(word(nonce * (WRITTEN_SLOTS + 1))),
		}),
	},
	{
		name: 'creation',
		what: 'a contract creation depositing 22 bytes of runtime',
		code: undefined,
		txs: 40,
		tx: () => ({
			to: undefined,
			value: 0n,
			gas: 200_000n,
			data: hexOf(deployerFor(SSTORE3)),
		}),
	},
	{
		name: `${LOG_COUNT} logs`,
		what: `${LOG_COUNT} LOG1 events of 32 bytes each`,
		code: logLoop(LOG_COUNT),
		txs: 40,
		tx: () => ({to: CONTRACT, value: 0n, gas: 200_000n}),
	},
];

/** Pre-sign `count` transactions of `shape`, from nonce 0. Never timed. */
async function signBatch(shape, count, tip = TIP) {
	const raws = [];
	for (let nonce = 0; nonce < count; nonce++) {
		const {to, value, gas, data} = shape.tx(nonce);
		raws.push(
			await account.signTransaction({
				chainId: CHAIN_ID,
				type: 'eip1559',
				nonce,
				...(to === undefined ? {} : {to}),
				value,
				gas,
				maxFeePerGas: MAX_FEE,
				maxPriorityFeePerGas: tip,
				...(data === undefined ? {} : {data}),
			}),
		);
	}
	return raws;
}

// ---------------------------------------------------------------------------
// 1) REFERENCE GAS, on both engines
// ---------------------------------------------------------------------------
console.log('\n[1] reference gas — the figures every change in this repo restates');

const REFERENCE = {
	'number()': 2446n,
	'sumTo(2000)': 498689n,
	'keccakLoop(2000)': 1107052n,
};
const KECCAK_RESULT =
	'0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a';

/**
 * Intrinsic gas of a NON-CREATE call: 21,000 plus 16 per non-zero and 4 per zero
 * calldata byte. Subtracting it from `eth_estimateGas` recovers the EXECUTION gas
 * the reference figures are quoted in — the same arithmetic
 * `packages/benchmarks/test/helpers/scenario.ts` does, inlined rather than
 * imported so this probe stays independent of the benchmark package's toolchain.
 */
function intrinsicGasForCall(data) {
	const h = data.startsWith('0x') ? data.slice(2) : data;
	let gas = 21_000n;
	for (let i = 0; i + 1 < h.length; i += 2)
		gas += h.slice(i, i + 2) === '00' ? 4n : 16n;
	return gas;
}

const referenceRows = [];
for (const engine of ENGINES) {
	const node = await makeNode(engine, 'trusted');
	// Deployed by a real creation transaction rather than `evm_setCode`, so the
	// contract the reference gas is charged against is one this node built.
	const deployRaw = await account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		nonce: 0,
		value: 0n,
		gas: 2_000_000n,
		maxFeePerGas: MAX_FEE,
		maxPriorityFeePerGas: TIP,
		data: counterBytecode,
	});
	const deployed = await send(node, deployRaw, true);
	const address = deployed.contractAddress;
	const call = async (functionName, args) => {
		const data = encodeFunctionData({abi: counterAbi, functionName, args});
		const returned = await node.request({
			method: 'eth_call',
			params: [{from: account.address, to: address, data}, 'latest'],
		});
		const estimate = await node.request({
			method: 'eth_estimateGas',
			params: [{from: account.address, to: address, data}],
		});
		return {
			gas: BigInt(estimate) - intrinsicGasForCall(data),
			returned,
			decoded: decodeFunctionResult({abi: counterAbi, functionName, data: returned}),
		};
	};
	const number = await call('number', []);
	const sumTo = await call('sumTo', [2000n]);
	const keccak = await call('keccakLoop', [2000n]);
	referenceRows.push([
		engine,
		String(number.gas),
		String(sumTo.gas),
		String(keccak.gas),
		keccak.decoded === KECCAK_RESULT ? 'as expected' : keccak.decoded,
	]);
	check(
		`${engine}: number() charges ${REFERENCE['number()']} execution gas`,
		number.gas === REFERENCE['number()'],
		`got ${number.gas}`,
	);
	check(
		`${engine}: sumTo(2000) charges ${REFERENCE['sumTo(2000)']} execution gas`,
		sumTo.gas === REFERENCE['sumTo(2000)'],
		`got ${sumTo.gas}`,
	);
	check(
		`${engine}: keccakLoop(2000) charges ${REFERENCE['keccakLoop(2000)']} execution gas`,
		keccak.gas === REFERENCE['keccakLoop(2000)'],
		`got ${keccak.gas}`,
	);
	check(
		`${engine}: keccakLoop(2000) returns the reference hash`,
		keccak.decoded === KECCAK_RESULT,
		keccak.decoded,
	);
	await node.dispose();
}
table(
	['engine', 'number()', 'sumTo(2000)', 'keccakLoop(2000)', 'keccak result'],
	referenceRows,
);

// ---------------------------------------------------------------------------
// 2) COST BY SHAPE
// ---------------------------------------------------------------------------
console.log(
	'\n[2] what a transaction costs, by shape, on both engines (ms per transaction)',
);
console.log(
	'    Signing is OUTSIDE the window; a FRESH node per repeat, because a batch',
	'\n    starts at nonce 0 and a node cannot be replayed. Median of 5 batches.',
);
for (const s of SHAPES)
	console.log(`      ${s.name.padEnd(19)} ${s.what}, x${s.txs} per batch`);

const REPEATS = 5;

/**
 * One row: `repeats` batches of the whole pre-signed batch, each against a fresh
 * node, timing only the sends. Returns the MEDIAN per-transaction cost plus the
 * last receipt, which the caller asserts on.
 */
async function timeRow(shape, engine, mode, raws) {
	const samples = [];
	let receipt;
	let gasUsed;
	for (let i = -1; i < REPEATS; i++) {
		const node = await makeNode(engine, mode);
		if (shape.code !== undefined) {
			await node.request({
				method: 'evm_setCode',
				params: [CONTRACT, hexOf(shape.code)],
			});
		}
		const t0 = performance.now();
		for (const raw of raws) receipt = await send(node, raw, mode === 'trusted');
		const elapsed = performance.now() - t0;
		if (i >= 0) samples.push(elapsed / raws.length); // i === -1 is the warm-up
		gasUsed = BigInt(receipt.gasUsed);
		await node.dispose();
	}
	samples.sort((a, b) => a - b);
	return {perTx: samples[samples.length >> 1], receipt, gasUsed};
}

/** shape -> engine -> mode -> row */
const byShape = new Map();

for (const shape of SHAPES) {
	const raws = await signBatch(shape, shape.txs);
	const rows = {};
	for (const engine of ENGINES) {
		rows[engine] = {};
		for (const mode of MODES) {
			const row = await timeRow(shape, engine, mode, raws);
			rows[engine][mode] = row;
			check(
				`${shape.name} / ${engine} / '${mode}': the last transaction succeeded`,
				String(row.receipt.status) === '0x1',
				`status ${row.receipt.status}, gasUsed ${row.gasUsed}`,
			);
			check(
				`${shape.name} / ${engine} / '${mode}': receipt.from is the signer`,
				String(row.receipt.from).toLowerCase() ===
					account.address.toLowerCase(),
				String(row.receipt.from),
			);
		}
	}
	byShape.set(shape.name, {shape, rows});
	// THE GAS GATE, per shape. Two engines that disagree about what a shape costs
	// in GAS are not two implementations of one transaction, and comparing their
	// wall clock would be comparing two different transactions.
	const gasFigures = ENGINES.flatMap((e) =>
		MODES.map((m) => rows[e][m].gasUsed),
	);
	check(
		`${shape.name}: both engines and both sender modes charge the same gas`,
		gasFigures.every((g) => g === gasFigures[0]),
		gasFigures.join(' / '),
	);
	if (shape.name === 'creation') {
		check(
			'creation: both engines report the same contractAddress',
			rows.default.trusted.receipt.contractAddress ===
				rows.revm.trusted.receipt.contractAddress,
			`${rows.default.trusted.receipt.contractAddress} / ${rows.revm.trusted.receipt.contractAddress}`,
		);
	}
	if (shape.name === `${LOG_COUNT} logs`) {
		check(
			`${LOG_COUNT} logs: both engines report ${LOG_COUNT} logs`,
			ENGINES.every((e) => rows[e].trusted.receipt.logs.length === LOG_COUNT),
			ENGINES.map((e) => `${e}: ${rows[e].trusted.receipt.logs.length}`).join(', '),
		);
	}
}

table(
	[
		'shape',
		'gas',
		"default 'recover'",
		"default 'trusted'",
		"revm 'recover'",
		"revm 'trusted'",
		"revm speed-up ('recover')",
		"revm speed-up ('trusted')",
	],
	SHAPES.map(({name}) => {
		const {rows} = byShape.get(name);
		return [
			name,
			String(rows.default.trusted.gasUsed),
			ms(rows.default.recover.perTx),
			ms(rows.default.trusted.perTx),
			ms(rows.revm.recover.perTx),
			ms(rows.revm.trusted.perTx),
			ratio(rows.default.recover.perTx, rows.revm.recover.perTx),
			ratio(rows.default.trusted.perTx, rows.revm.trusted.perTx),
		];
	}),
);

// ---------------------------------------------------------------------------
// 3) SENDER RECOVERY, SEPARATED FROM EXECUTION
// ---------------------------------------------------------------------------
console.log(
	'\n[3] the two levers, told apart: recovery is a FIXED per-transaction cost',
);
console.log(
	"    recovery = ('recover' - 'trusted') on the same engine, same shape, same run.",
);

table(
	[
		'shape',
		'default: recovery ms',
		'default: execution ms',
		'revm: recovery ms',
		'revm: execution ms',
		'revm speed-up, execution only',
	],
	SHAPES.map(({name}) => {
		const {rows} = byShape.get(name);
		const dRec = rows.default.recover.perTx - rows.default.trusted.perTx;
		const rRec = rows.revm.recover.perTx - rows.revm.trusted.perTx;
		return [
			name,
			ms(dRec),
			ms(rows.default.trusted.perTx),
			ms(rRec),
			ms(rows.revm.trusted.perTx),
			ratio(rows.default.trusted.perTx, rows.revm.trusted.perTx),
		];
	}),
);

// ---------------------------------------------------------------------------
// 4) THE COMMIT PATH
// ---------------------------------------------------------------------------
console.log('\n[4] the COMMIT path: how many writes reach the node, per shape');
console.log(
	'    revm writes through the store\'s host callbacks, ALL of them at the end of',
	'\n    the execution (ADR 0010); the default engine writes through the state',
	'\n    manager as it goes, so it has no separable commit phase. The two columns',
	'\n    are therefore comparable in COUNT and not in mechanism.',
);

/**
 * Patch every named method on the prototype that OWNS it, walking up from
 * `start`. Returns `{counts, nanos, restore}`.
 *
 * Walking from the class the NODE uses is what makes this safe: there is no
 * second resolved copy of `SimpleStateManager` to patch by mistake, which is the
 * failure mode `support.mjs`'s `assertSameStateManagerInstance` exists for.
 */
function patchCounting(start, names) {
	const counts = {};
	const nanos = {};
	const undo = [];
	for (const name of names) {
		let owner = start;
		while (owner && !Object.prototype.hasOwnProperty.call(owner, name))
			owner = Object.getPrototypeOf(owner);
		if (!owner)
			throw new Error(
				`patchCounting: no '${name}' anywhere on the prototype chain — the ` +
					'method was renamed, and a counter that silently counts nothing is ' +
					'indistinguishable from an engine that does not write.',
			);
		const original = owner[name];
		counts[name] = 0;
		nanos[name] = 0;
		owner[name] = function (...args) {
			counts[name]++;
			const t0 = process.hrtime.bigint();
			try {
				return original.apply(this, args);
			} finally {
				nanos[name] += Number(process.hrtime.bigint() - t0);
			}
		};
		undo.push(() => {
			owner[name] = original;
		});
	}
	return {
		counts,
		nanos,
		reset() {
			for (const k of Object.keys(counts)) {
				counts[k] = 0;
				nanos[k] = 0;
			}
		},
		restore() {
			for (const f of undo) f();
		},
	};
}

const REVM_READS = ['getAccount', 'getStorage', 'getCode', 'getBlockHash'];
const REVM_WRITES = [
	'setAccount',
	'setCode',
	'setStorage',
	'clearStorage',
	'removeAccount',
];
const DEFAULT_READS = ['getAccount', 'getCode', 'getStorage'];
const DEFAULT_WRITES = [
	'putAccount',
	'putCode',
	'putStorage',
	'deleteAccount',
	'modifyAccountFields',
	'clearStorage',
];

const sum = (o, keys) => keys.reduce((t, k) => t + (o[k] ?? 0), 0);

/**
 * ONE transaction of `shape` on `engine`, with the callbacks counted. The
 * counters are reset AFTER the seeding `evm_setCode` and the node's construction,
 * so what they report is one transaction and nothing else.
 */
async function countBatch(shape, engine, tip = TIP, batch = 10) {
	const probe =
		engine === 'revm'
			? patchCounting(SimpleStateManagerStore.prototype, [
					...REVM_READS,
					...REVM_WRITES,
				])
			: patchCounting(OverlayStorageStateManager.prototype, [
					...DEFAULT_READS,
					...DEFAULT_WRITES,
				]);
	try {
		const raws = await signBatch(shape, batch, tip);
		// TWO nodes: the first is a warm-up whose counts are thrown away, because a
		// single cold transaction times the JIT rather than the commit.
		let result;
		for (const warm of [true, false]) {
			const node = await makeNode(engine, 'trusted');
			if (shape.code !== undefined) {
				await node.request({
					method: 'evm_setCode',
					params: [CONTRACT, hexOf(shape.code)],
				});
			}
			probe.reset();
			let receipt;
			const t0 = process.hrtime.bigint();
			for (const raw of raws) receipt = await send(node, raw, true);
			const wallNs = Number(process.hrtime.bigint() - t0);
			const dump = await node.dumpState();
			await node.dispose();
			if (!warm)
				result = {
					counts: {...probe.counts},
					nanos: {...probe.nanos},
					wallNs,
					batch,
					receipt,
					coinbase:
						dump.accounts['0x0000000000000000000000000000000000000000'],
				};
		}
		return result;
	} finally {
		probe.restore();
	}
}

const commitRows = [];
for (const shape of SHAPES) {
	for (const engine of ENGINES) {
		const r = await countBatch(shape, engine);
		const reads = engine === 'revm' ? REVM_READS : DEFAULT_READS;
		const writes = engine === 'revm' ? REVM_WRITES : DEFAULT_WRITES;
		const writeNs = sum(r.nanos, writes);
		const readNs = sum(r.nanos, reads);
		const per = (n) => n / r.batch;
		commitRows.push([
			shape.name,
			engine,
			per(sum(r.counts, reads)),
			per(sum(r.counts, writes)),
			writes
				.filter((w) => r.counts[w] > 0)
				.map((w) => `${w} ${per(r.counts[w])}`)
				.join(', '),
			(readNs / r.batch / 1000).toFixed(1),
			(writeNs / r.batch / 1000).toFixed(1),
			`${((writeNs / r.wallNs) * 100).toFixed(1)}%`,
		]);
		check(
			`${shape.name} / ${engine}: the counters saw every transaction, uniformly`,
			sum(r.counts, reads) > 0 &&
				sum(r.counts, writes) > 0 &&
				[...reads, ...writes].every((k) => r.counts[k] % r.batch === 0),
			`reads ${per(sum(r.counts, reads))}/tx, writes ${per(sum(r.counts, writes))}/tx`,
		);
	}
}
table(
	[
		'shape',
		'engine',
		'read callbacks',
		'write callbacks',
		'which writes',
		'µs inside the reads',
		'µs inside the writes',
		'writes as a share of the send',
	],
	commitRows,
);

console.log(
	'\n    the COINBASE, both ways: credited a real tip, and deleted at a zero tip',
);
const coinbaseRows = [];
for (const engine of ENGINES) {
	for (const [label, tip] of [
		['tip 1 gwei (credited)', TIP],
		['tip 0 (deleted)', 0n],
	]) {
		const r = await countBatch(SHAPES[0], engine, tip);
		const writes = engine === 'revm' ? REVM_WRITES : DEFAULT_WRITES;
		const per = (n) => n / r.batch;
		coinbaseRows.push([
			engine,
			label,
			per(sum(r.counts, writes)),
			writes
				.filter((w) => r.counts[w] > 0)
				.map((w) => `${w} ${per(r.counts[w])}`)
				.join(', '),
			r.coinbase === undefined ? 'absent from dumpState' : 'present',
		]);
		check(
			`${engine}, ${label}: the coinbase is ${tip === 0n ? 'absent' : 'present'} afterwards`,
			(r.coinbase === undefined) === (tip === 0n),
			r.coinbase === undefined ? 'absent' : 'present',
		);
	}
}
table(
	['engine', 'a transfer with...', 'write callbacks', 'which writes', 'coinbase'],
	coinbaseRows,
);

// ---------------------------------------------------------------------------
// 5) THE CROSSOVER
// ---------------------------------------------------------------------------
console.log(
	'\n[5] cost against DISTINCT slots touched — the axis the seam is sensitive to',
);
console.log(
	"    `senderMode:'trusted'`, so this is execution and commit with no recovery in it.",
);

// UP TO WHAT ONE TRANSACTION CAN ACTUALLY REACH. 12,288 cold SLOADs cost about
// 26M gas, so the next point on this axis is not measurable at all: the block
// gas limit (30,000,000, and both engines now enforce it) refuses it. That is
// what makes the frame-budget column an answer rather than a trend.
//
// 2,048 is in the list for one reason: it is where the DEFAULT engine crosses
// the 16.6 ms frame budget, and a crossing read off a straight line between
// 1,024 and 4,096 would be arithmetic rather than a measurement.
const SWEEP = [1, 16, 64, 256, 1024, 2048, 4096, 8192, 12288];
const sweepRows = [];
for (const k of SWEEP) {
	const shape = {
		name: `${k} slots`,
		code: sloadLoop(k),
		txs: k >= 4096 ? 4 : k >= 1024 ? 8 : 20,
		tx: () => ({to: CONTRACT, value: 0n, gas: 29_000_000n}),
	};
	const raws = await signBatch(shape, shape.txs);
	const cells = {};
	for (const engine of ENGINES) {
		cells[engine] = await timeRow(shape, engine, 'trusted', raws);
	}
	check(
		`${k} distinct slots: both engines charge the same gas`,
		cells.default.gasUsed === cells.revm.gasUsed,
		`${cells.default.gasUsed} / ${cells.revm.gasUsed}`,
	);
	sweepRows.push([
		k,
		String(cells.default.gasUsed),
		ms(cells.default.perTx),
		ms(cells.revm.perTx),
		ratio(cells.default.perTx, cells.revm.perTx),
		`${((cells.default.perTx / 16.6) * 100).toFixed(0)}% / ${((cells.revm.perTx / 16.6) * 100).toFixed(0)}%`,
	]);
}
table(
	[
		'distinct slots',
		'gas',
		'default ms',
		'revm ms',
		'revm speed-up',
		'share of a 16.6 ms frame (default / revm)',
	],
	sweepRows,
);

exitWithFailures();
