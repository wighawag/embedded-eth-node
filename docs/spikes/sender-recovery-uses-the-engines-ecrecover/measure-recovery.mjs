/**
 * measure-recovery.mjs — what the engine's `ecrecover` actually buys, measured in
 * THIS repo rather than quoted from the binding's README.
 *
 * `sender-recovery-uses-the-engines-ecrecover` inherited two figures it was told
 * to treat as claims: "roughly 4.2x" on the recovery itself (measured on the
 * ENGINE side, by `revm-wasm`) and "about 13x, narrowing to about 3x" for
 * `'recover'` vs `'trusted'` (measured on `runTx` in isolation, by an earlier
 * version of this node, before the storage re-layer of ADR 0009 removed the cost
 * that used to dominate a transaction). Neither survives being restated; both are
 * re-derived here.
 *
 *   node docs/spikes/sender-recovery-uses-the-engines-ecrecover/measure-recovery.mjs
 *
 * Run it against the repo's own build (`pnpm build` first, which `pnpm install`
 * already does). It exits non-zero if any of its own correctness checks fail, so a
 * stale number in ./measurements.md is a red run rather than a wrong document.
 * Spike code: nothing under `packages/` imports it.
 *
 * WHAT IT MEASURES, and why in three windows rather than one:
 *
 *  1. THE PRIMITIVE. One recovery, nothing else: `@ethereumjs/util`'s `ecrecover`
 *     (`@noble/curves`, which is what `tx.getSenderAddress()` runs) against
 *     `Engine.ecrecover` on `embedded-eth-node/revm`. This is the only window
 *     where the ratio is the CURVE's; every window below dilutes it with work
 *     neither implementation can make cheaper, which is the point of measuring
 *     them separately.
 *  2. THE ISOLATED TRANSACTION PATH. Pre-signed raw bytes into
 *     `eth_sendRawTransactionSync` (`'recover'`) against
 *     `evm_sendRawTransactionSyncAs` (`'trusted'`), on the default engine and on
 *     revm. Signing is OUTSIDE the window, so the difference between the two modes
 *     is the node's recovery and nothing else. This is the successor to the "13x
 *     on `runTx` in isolation" figure the repo has been quoting.
 *  3. END TO END. The same transactions with the CLIENT's own signing inside the
 *     window, which is what a dapp actually pays and the residual `'trusted'` can
 *     never remove.
 *
 * READ THE RATIOS, NOT THE MILLISECONDS. Absolute values are load-sensitive and
 * this is an ordinary developer machine under Node, not the browser the library
 * ships to; the ratios between rows measured in the same run are the durable part.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const pkg = new URL('../../../packages/embedded-eth-node/', import.meta.url);
const require = createRequire(new URL('package.json', pkg));
const {createNode} = await import(new URL('dist/index.js', pkg).href);
const {createRevmEngine} = await import(new URL('dist/revm.js', pkg).href);
const {wasmUrl} = await import(require.resolve('revm-wasm/wasm-url'));
const wasmBytes = readFileSync(fileURLToPath(wasmUrl));
const wasm = await WebAssembly.compile(wasmBytes);
const {privateKeyToAccount} = await import(require.resolve('viem/accounts'));
const {ecrecover, publicToAddress, bytesToHex, hexToBytes} = await import(
	require.resolve('@ethereumjs/util')
);

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const RECIPIENT = '0x00000000000000000000000000000000000000cc';
const account = privateKeyToAccount(PK);

const failures = [];
const check = (ok, what) => {
	if (!ok) failures.push(what);
};

/** Median of `repeats` timed runs of `fn`, in milliseconds, after a warm-up. */
async function bench(label, repeats, warmup, fn) {
	for (let i = 0; i < warmup; i++) await fn(i, true);
	const samples = [];
	for (let i = 0; i < repeats; i++) {
		const t0 = performance.now();
		await fn(i, false);
		samples.push(performance.now() - t0);
	}
	samples.sort((a, b) => a - b);
	const median = samples[Math.floor(samples.length / 2)];
	return {label, median, min: samples[0], max: samples[samples.length - 1]};
}

const ms = (n) => n.toFixed(3);
const µs = (n) => (n * 1000).toFixed(1);

// ---------------------------------------------------------------------------
// 1) THE PRIMITIVE
// ---------------------------------------------------------------------------
console.log('\n=== 1) one ecrecover, nothing else ===\n');

const engineForPrimitive = await createRevmEngine({wasm});
check(
	typeof engineForPrimitive.ecrecover === 'function',
	'the revm engine exposes no `ecrecover` — the binding no longer offers signature recovery, and this task has DRIFTED',
);

const digest = hexToBytes('0x' + '11223344'.repeat(8));
const sigHex = await account.sign({hash: bytesToHex(digest)});
const r = hexToBytes('0x' + sigHex.slice(2, 66));
const s = hexToBytes('0x' + sigHex.slice(66, 130));
const recoveryId = Number.parseInt(sigHex.slice(130, 132), 16) - 27;

const jsAddress = bytesToHex(
	publicToAddress(ecrecover(digest, BigInt(recoveryId), r, s)),
);
const engineAddress = bytesToHex(
	engineForPrimitive.ecrecover(digest, recoveryId, r, s),
);
check(
	jsAddress === account.address.toLowerCase() &&
		engineAddress === account.address.toLowerCase(),
	`the two implementations do not agree on the signer: js ${jsAddress}, engine ${engineAddress}, signer ${account.address}`,
);

const N_RECOVERIES = 200;
const primitive = [
	await bench('@ethereumjs/util (@noble/curves)', 7, 2, () => {
		for (let i = 0; i < N_RECOVERIES; i++) {
			publicToAddress(ecrecover(digest, BigInt(recoveryId), r, s));
		}
	}),
	await bench('engine.ecrecover (revm-wasm)', 7, 2, () => {
		for (let i = 0; i < N_RECOVERIES; i++) {
			engineForPrimitive.ecrecover(digest, recoveryId, r, s);
		}
	}),
];
for (const row of primitive) {
	console.log(
		`  ${row.label.padEnd(34)} ${µs(row.median / N_RECOVERIES).padStart(8)} µs/recovery`,
	);
}
const primitiveRatio = primitive[0].median / primitive[1].median;
console.log(`\n  engine ecrecover is ${primitiveRatio.toFixed(2)}x faster\n`);

// ---------------------------------------------------------------------------
// 2 + 3) THE TRANSACTION PATH
// ---------------------------------------------------------------------------
const GENESIS_BALANCE = 10n ** 24n;
const TXS = 60;

/** Pre-sign `TXS` value transfers from nonce 0. */
async function signBatch() {
	const raws = [];
	for (let nonce = 0; nonce < TXS; nonce++) {
		raws.push(
			await account.signTransaction({
				chainId: CHAIN_ID,
				type: 'eip1559',
				nonce,
				to: RECIPIENT,
				value: 1n,
				gas: 21_000n,
				maxFeePerGas: 2_000_000_000n,
				maxPriorityFeePerGas: 1_000_000_000n,
			}),
		);
	}
	return raws;
}
const preSigned = await signBatch();

const makeNode = async (senderMode, engineChoice) =>
	createNode({
		chainId: CHAIN_ID,
		senderMode,
		miningConfig: {type: 'auto'},
		initialBalances: {
			[account.address]: GENESIS_BALANCE,
			[RECIPIENT]: GENESIS_BALANCE,
		},
		engine:
			engineChoice === 'default' ? undefined : await makeEngine(engineChoice),
	});

/**
 * The revm engine, optionally WITHOUT its `ecrecover` — the third row, and the
 * one that isolates this task's change from the engine swap it rides on. Deleting
 * the method is exactly what the node sees for any engine that does not offer
 * one, so this row is "revm before this task" rather than a simulation of it.
 */
async function makeEngine(choice) {
	const engine = await createRevmEngine({wasm});
	if (choice === 'revm') return engine;
	const {ecrecover: _dropped, ...withoutEcrecover} = engine;
	return withoutEcrecover;
}

/** Send the whole batch, one at a time, and return the last receipt. */
async function sendPreSigned(node, trusted) {
	let receipt;
	for (const raw of preSigned) {
		receipt = trusted
			? await node.request({
					method: 'evm_sendRawTransactionSyncAs',
					params: [raw, account.address],
				})
			: await node.request({
					method: 'eth_sendRawTransactionSync',
					params: [raw],
				});
	}
	return receipt;
}

/** Sign AND send, which is what a dapp pays. */
async function signAndSend(node, trusted) {
	let receipt;
	for (let nonce = 0; nonce < TXS; nonce++) {
		const raw = await account.signTransaction({
			chainId: CHAIN_ID,
			type: 'eip1559',
			nonce,
			to: RECIPIENT,
			value: 1n,
			gas: 21_000n,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
		});
		receipt = trusted
			? await node.request({
					method: 'evm_sendRawTransactionSyncAs',
					params: [raw, account.address],
				})
			: await node.request({
					method: 'eth_sendRawTransactionSync',
					params: [raw],
				});
	}
	return receipt;
}

/**
 * One row: a FRESH node per repeat (the batch starts at nonce 0, so the same node
 * cannot be replayed), timing only the sends.
 */
async function row(label, senderMode, engineChoice, send) {
	const nodes = [];
	const result = await bench(label, 5, 1, async (_i, warm) => {
		const node = await makeNode(senderMode, engineChoice);
		nodes.push(node);
		const receipt = await send(node, senderMode === 'trusted');
		if (!warm) {
			check(
				String(receipt.status) === '0x1',
				`${label}: last receipt status ${receipt.status}`,
			);
			check(
				String(receipt.from).toLowerCase() === account.address.toLowerCase(),
				`${label}: receipt.from ${receipt.from} != ${account.address}`,
			);
			check(
				String(receipt.gasUsed) === '0x5208',
				`${label}: gasUsed ${receipt.gasUsed} != 0x5208 (21000)`,
			);
		}
	});
	for (const n of nodes) await n.dispose();
	return {...result, perTx: result.median / TXS};
}

console.log('=== 2) the isolated transaction path (signing OUTSIDE the window) ===\n');
const isolated = [
	await row("default engine, 'recover'", 'recover', 'default', sendPreSigned),
	await row("default engine, 'trusted'", 'trusted', 'default', sendPreSigned),
	await row(
		"revm engine (no engine ecrecover), 'recover'",
		'recover',
		'revm-no-ecrecover',
		sendPreSigned,
	),
	await row("revm engine, 'recover'", 'recover', 'revm', sendPreSigned),
	await row("revm engine, 'trusted'", 'trusted', 'revm', sendPreSigned),
];
for (const r of isolated) {
	console.log(`  ${r.label.padEnd(46)} ${ms(r.perTx).padStart(7)} ms/tx`);
}

console.log('\n=== 3) end to end (the CLIENT signs inside the window) ===\n');
const endToEnd = [
	await row("default engine, 'recover'", 'recover', 'default', signAndSend),
	await row("default engine, 'trusted'", 'trusted', 'default', signAndSend),
	await row("revm engine, 'recover'", 'recover', 'revm', signAndSend),
	await row("revm engine, 'trusted'", 'trusted', 'revm', signAndSend),
];
for (const r of endToEnd) {
	console.log(`  ${r.label.padEnd(46)} ${ms(r.perTx).padStart(7)} ms/tx`);
}

const ratio = (rows, a, b) =>
	(rows.find((r) => r.label === a).perTx / rows.find((r) => r.label === b).perTx)
		.toFixed(2);

console.log('\n=== the recover-versus-trusted ratio ===\n');
console.log(
	`  isolated, default engine   ${ratio(isolated, "default engine, 'recover'", "default engine, 'trusted'")}x`,
);
console.log(
	`  isolated, revm engine      ${ratio(isolated, "revm engine, 'recover'", "revm engine, 'trusted'")}x`,
);
console.log(
	`  end to end, default engine ${ratio(endToEnd, "default engine, 'recover'", "default engine, 'trusted'")}x`,
);
console.log(
	`  end to end, revm engine    ${ratio(endToEnd, "revm engine, 'recover'", "revm engine, 'trusted'")}x`,
);
console.log(
	`\n  what THIS task bought on the isolated path: ${ratio(isolated, "revm engine (no engine ecrecover), 'recover'", "revm engine, 'recover'")}x\n`,
);

console.log('=== environment ===');
console.log(`  node ${process.version} on ${process.platform}/${process.arch}`);
console.log(
	`  revm-wasm ${JSON.parse(readFileSync(require.resolve('revm-wasm/package.json'), 'utf8')).version}`,
);

if (failures.length > 0) {
	console.error('\nFAILED:');
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log('\nall correctness checks passed.');
