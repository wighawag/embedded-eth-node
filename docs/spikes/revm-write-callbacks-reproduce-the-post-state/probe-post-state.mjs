/**
 * probe-post-state.mjs — what a `SELFDESTRUCT` leaves behind, measured through
 * the node's own public surface, in all three combinations that have an opinion
 * about it: `stateMode:'trie'` (a real Merkle-Patricia trie), `stateMode:'none'`
 * on the default `@ethereumjs/vm` engine, and `stateMode:'none'` on
 * `embedded-eth-node/revm`.
 *
 * WHY IT EXISTS. `revm-write-callbacks-reproduce-the-post-state` asks for a
 * revm-executed transaction to leave post-state `@ethereumjs/vm` cannot be told
 * apart from, for a selfdestruct among other shapes. It did not, and the engine
 * that was right was revm: `revm-wasm` hands its host `clearStorage` then
 * `removeAccount` for a destroyed account (its own commit semantics, already
 * applied), while `SimpleStateManager.deleteAccount` tombstones the account and
 * never touches storage — it has no per-account index to clear with. So
 * `stateMode:'none'` on the default engine answered a dead contract's slot with
 * its LAST VALUE, and `dumpState` kept serialising it.
 *
 * A trie has no such option: deleting the account takes its storage trie with it.
 * That is what makes `'trie'` the tie-breaker here rather than a third opinion,
 * and it is why the fix went into `src/state-manager.ts` (the node's `'none'`
 * mode) rather than into the revm host. See
 * `docs/adr/0007-we-override-simplestatemanagers-no-op-clearstorage.md`, whose
 * 2026-08-10 amendment records the decision, and ./measurements.md next to this
 * file for the numbers this run produced.
 *
 * Run it against the repo's own build (`pnpm build` first, which `pnpm install`
 * already does):
 *
 *   node docs/spikes/revm-write-callbacks-reproduce-the-post-state/probe-post-state.mjs
 *
 * It exits non-zero if any of its own checks fail, so a stale number in
 * `measurements.md` is a red run rather than a wrong document. Spike code:
 * nothing under `packages/` imports it.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const pkg = new URL('../../../packages/embedded-eth-node/', import.meta.url);
const require = createRequire(new URL('package.json', pkg));
const {createNode} = await import(new URL('dist/index.js', pkg).href);
const {createRevmEngine} = await import(new URL('dist/revm.js', pkg).href);
const {wasmUrl} = await import(require.resolve('revm-wasm/wasm-url'));
const wasm = readFileSync(fileURLToPath(wasmUrl));
const {privateKeyToAccount} = await import(require.resolve('viem/accounts'));

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
const BENEFICIARY = '0x0000000000000000000000000000000000004444';

/**
 * Init code that writes storage and then DESTROYS ITSELF, in the transaction
 * that created it — which is what EIP-6780 (Cancun) requires for a
 * `SELFDESTRUCT` to remove anything at all:
 *
 *   PUSH1 2a, PUSH1 00, SSTORE      slot 0 = 42
 *   PUSH20 <beneficiary>, SELFDESTRUCT
 *
 * It deploys no code, so the only thing left to observe is the account and the
 * slot it wrote.
 */
const SELFDESTRUCT_INIT = `0x602a60005573${BENEFICIARY.slice(2)}ff`;

async function measure(label, {stateMode, engine}) {
	const node = await createNode({
		chainId: CHAIN_ID,
		stateMode,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
		engine,
	});
	// An EXPLICIT gas limit, not an estimate: an `eth_estimateGas` figure is exact
	// for the top frame and EIP-150's 63/64 rule then starves anything below it.
	const raw = await account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		nonce: 0,
		gas: 200_000n,
		maxFeePerGas: 1_000_000_000n,
		maxPriorityFeePerGas: 0n,
		value: 1000n,
		data: SELFDESTRUCT_INIT,
	});
	const receipt = await node.request({
		method: 'eth_sendRawTransactionSync',
		params: [raw],
	});
	const address = receipt.contractAddress;
	const read = async (method, ...params) =>
		String(await node.request({method, params: [...params, 'latest']}));
	const row = {
		label,
		stateMode,
		engineId: node.engine.id,
		status: receipt.status,
		address,
		code: await read('eth_getCode', address),
		balance: await read('eth_getBalance', address),
		beneficiary: await read('eth_getBalance', BENEFICIARY),
		slot0: await read('eth_getStorageAt', address, '0x0'),
	};
	// `dumpState` carries storage in `'none'` only (trie mode dumps accounts and
	// code, never storage — see the README's state-mode section), so this column is
	// only meaningful for the two `'none'` rows.
	if (stateMode === 'none') {
		const dump = await node.dumpState();
		row.inDumpAccounts = dump.accounts[address.toLowerCase()] !== undefined;
		row.inDumpStorage = dump.storage[address.toLowerCase()] !== undefined;
	}
	await node.dispose();
	return row;
}

const rows = [
	await measure('trie / @ethereumjs/vm', {stateMode: 'trie'}),
	await measure('none / @ethereumjs/vm', {stateMode: 'none'}),
	await measure('none / revm-wasm', {
		stateMode: 'none',
		engine: await createRevmEngine({wasm}),
	}),
];

for (const row of rows) console.log(JSON.stringify(row));

// --- the probe's own checks ------------------------------------------------
const failures = [];
const check = (what, actual, expected) => {
	if (actual !== expected)
		failures.push(`${what}: expected ${expected}, got ${actual}`);
};
const ZERO32 = `0x${'0'.repeat(64)}`;
for (const row of rows) {
	check(`${row.label}: status`, row.status, '0x1');
	// Destroyed, not merely emptied: no code, no balance, and the beneficiary holds
	// the 1000 wei it was funded with.
	check(`${row.label}: code`, row.code, '0x');
	check(`${row.label}: balance`, BigInt(row.balance), 0n);
	check(`${row.label}: beneficiary`, BigInt(row.beneficiary), 1000n);
	// THE MEASUREMENT: the slot the dead contract wrote must read ZERO everywhere.
	check(`${row.label}: slot0`, row.slot0, ZERO32);
	if (row.stateMode === 'none') {
		check(`${row.label}: account in dumpState`, row.inDumpAccounts, false);
		check(`${row.label}: storage in dumpState`, row.inDumpStorage, false);
	}
}
// ...and the three rows agree with each other, which is the property the fix
// bought: before it, `none / @ethereumjs/vm` alone answered `0x...2a`.
const distinct = new Set(rows.map((r) => r.slot0));
if (distinct.size !== 1)
	failures.push(
		`the three configurations disagree about the destroyed contract's slot 0: ` +
			JSON.stringify(rows.map((r) => `${r.label}=${r.slot0}`)),
	);

if (failures.length > 0) {
	console.error('\nFAILED:');
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log('\nOK: all three configurations agree.');
