/**
 * harness.ts — the spike. Answers: can revm-wasm's SYNCHRONOUS StateStore read
 * embedded-eth-node's own state, with nothing copied across?
 *
 * Run it from a scratch tree OUTSIDE this repo: see README.md in this folder for
 * the four commands. Exits non-zero if any check fails.
 */
import {createRevm} from 'revm-wasm';
import {MemoryStore, KECCAK_EMPTY} from 'revm-wasm';
import {wasmUrl} from 'revm-wasm/wasm-url';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {keccak_256} from '@noble/hashes/sha3.js';
import {createTx} from '@ethereumjs/tx';
import {Common, Mainnet, Hardfork} from '@ethereumjs/common';
import {
	privateToAddress,
	hexToBytes,
	bytesToHex,
	setLengthLeft,
	bigIntToBytes,
	createAddressFromString,
} from '@ethereumjs/util';
import {SimpleStateManager, MerkleStateManager} from '@ethereumjs/statemanager';
import {createNode} from './node-src/index.js';
import {SimpleStateManagerStore} from './simple-state-store.js';
import {counterBytecode} from './counter.js';

/**
 * Capture the state manager the node builds.
 *
 * The node closes over it and exposes nothing, and this spike lives OUTSIDE the
 * package, so it hooks the two state-manager classes to record the instance. An
 * engine shipped as `embedded-eth-node/revm` would simply be handed the
 * reference at construction; this detour is a property of the spike's vantage
 * point, not of the technique being measured.
 */
let captured: any;
for (const [K, m] of [
	[SimpleStateManager, 'checkpointSync'],
	[MerkleStateManager, 'getAccount'],
] as [any, string][]) {
	const orig = K.prototype[m];
	K.prototype[m] = function (this: any, ...args: unknown[]) {
		captured = this;
		return orig.apply(this, args);
	};
}

const wasm = readFileSync(fileURLToPath(wasmUrl));

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
	const ok = String(actual) === String(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`,
	);
}
function note(s: string) {
	console.log(`      ${s}`);
}
function section(s: string) {
	console.log(`\n=== ${s} ===`);
}

const selector = (sig: string) =>
	keccak_256(new TextEncoder().encode(sig)).slice(0, 4);
const u256 = (n: bigint) => setLengthLeft(bigIntToBytes(n), 32);
const cat = (...xs: Uint8Array[]) => {
	const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
	let o = 0;
	for (const x of xs) {
		out.set(x, o);
		o += x.length;
	}
	return out;
};
const NUMBER = selector('number()');
const INCREMENT = selector('increment()');
const SUM_TO = (n: bigint) => cat(selector('sumTo(uint256)'), u256(n));
const KECCAK_LOOP = (n: bigint) =>
	cat(selector('keccakLoop(uint256)'), u256(n));

/** 21000 + 16/non-zero + 4/zero calldata byte. Mirrors the node's own formula. */
function intrinsic(data: Uint8Array): bigint {
	let gas = 21_000n;
	for (const b of data) gas += b === 0 ? 4n : 16n;
	return gas;
}

const PRIVATE_KEY = hexToBytes(
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const DEPLOYER = bytesToHex(privateToAddress(PRIVATE_KEY));
const GAS_LIMIT = 30_000_000n;

// Reference numbers from the task / the cross-backend gate.
const REF = {
	numberGas: 2446n,
	sumToGas: 498689n,
	keccakGas: 1107052n,
	keccakResult:
		'0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a',
};

// ---------------------------------------------------------------------------
// 1. CONTROL — MemoryStore, to prove the harness itself is right before it is
//    pointed at the node's state.
// ---------------------------------------------------------------------------
async function control(): Promise<void> {
	section('1. control: revm-wasm + its own MemoryStore');
	const store = new MemoryStore();
	const evm = await createRevm({wasm, state: store, chainId: 31337n});
	note(
		`revm ${evm.revmVersion} rev ${evm.revmRevision} abi=${evm.abiVersion} outcome=v${evm.outcomeFormatVersion}`,
	);

	const from = hexToBytes(DEPLOYER);
	store.setAccount(from, {
		balance: 10n ** 24n,
		nonce: 0n,
		codeHash: KECCAK_EMPTY,
	});
	const created = evm.create({
		from,
		data: hexToBytes(counterBytecode),
		gasLimit: GAS_LIMIT,
	});
	check('control deploy status', created.status, 'success');
	const to = created.stateChanges!.find((c) => c.created)!.address;

	const n = evm.call({from, to, data: NUMBER, gasLimit: GAS_LIMIT});
	check(
		'control number() execution gas',
		n.gasUsed - intrinsic(NUMBER),
		REF.numberGas,
	);
	const s = evm.call({from, to, data: SUM_TO(2000n), gasLimit: GAS_LIMIT});
	check(
		'control sumTo(2000) execution gas',
		s.gasUsed - intrinsic(SUM_TO(2000n)),
		REF.sumToGas,
	);
	const k = evm.call({from, to, data: KECCAK_LOOP(2000n), gasLimit: GAS_LIMIT});
	check(
		'control keccakLoop(2000) execution gas',
		k.gasUsed - intrinsic(KECCAK_LOOP(2000n)),
		REF.keccakGas,
	);
	check(
		'control keccakLoop(2000) result',
		bytesToHex(k.returnData),
		REF.keccakResult,
	);
}

// ---------------------------------------------------------------------------
// 2. THE QUESTION — revm reading the node's OWN state, nothing copied.
// ---------------------------------------------------------------------------
async function againstTheNode(): Promise<void> {
	section("2. stateMode:'none' — revm over the node's live SimpleStateManager");

	const node = await createNode({
		chainId: 31337,
		senderMode: 'recover',
		initialBalances: {[DEPLOYER]: 10n ** 24n},
	});
	// The node does not expose its state manager. The spike reaches it the same
	// way a subpath engine inside the package would: it is a local, in-package
	// handle in the real thing. Here we re-derive it from the VM the node built.
	const sm = captured as SimpleStateManager;
	check('node state manager', sm.constructor.name, 'SimpleStateManager');

	// Deploy the Counter through the NODE's normal signed-transaction path, so
	// every byte of state revm reads was written by @ethereumjs/vm.
	const common = new Common({
		chain: {...Mainnet, chainId: 31337, name: 'embedded-eth-node'},
		hardfork: Hardfork.Cancun,
	});
	const deployTx = createTx(
		{
			type: 2,
			chainId: 31337,
			nonce: 0n,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			gasLimit: 5_000_000n,
			data: hexToBytes(counterBytecode),
		},
		{common},
	).sign(PRIVATE_KEY);
	const receipt: any = await node.request({
		method: 'eth_sendRawTransactionSync',
		params: [bytesToHex(deployTx.serialize())],
	});
	const counter = receipt.contractAddress as string;
	check('deployed through the node', receipt.status, '0x1');
	note(`counter at ${counter}`);

	// --- the adapter, over the LIVE state manager, nothing copied -----------
	const store = new SimpleStateManagerStore(sm);
	const evm = await createRevm({wasm, state: store, chainId: 31337n});
	const from = hexToBytes(DEPLOYER);
	const to = hexToBytes(counter);

	const n = evm.call({from, to, data: NUMBER, gasLimit: GAS_LIMIT});
	check('revm number() status', n.status, 'success');
	check(
		'revm number() execution gas',
		n.gasUsed - intrinsic(NUMBER),
		REF.numberGas,
	);
	check('revm number() return', BigInt(bytesToHex(n.returnData)), 0n);

	const s = evm.call({from, to, data: SUM_TO(2000n), gasLimit: GAS_LIMIT});
	check(
		'revm sumTo(2000) execution gas',
		s.gasUsed - intrinsic(SUM_TO(2000n)),
		REF.sumToGas,
	);
	const k = evm.call({from, to, data: KECCAK_LOOP(2000n), gasLimit: GAS_LIMIT});
	check(
		'revm keccakLoop(2000) execution gas',
		k.gasUsed - intrinsic(KECCAK_LOOP(2000n)),
		REF.keccakGas,
	);
	check(
		'revm keccakLoop(2000) result',
		bytesToHex(k.returnData),
		REF.keccakResult,
	);

	// --- nothing is copied in ahead of the call ----------------------------
	// Count what the store is actually asked for. A pre-load would show as a
	// sweep before execution; on-demand reads show as a handful per call.
	const counted = countingStore(sm);
	const evmCounted = await createRevm({
		wasm,
		state: counted.store,
		chainId: 31337n,
	});
	counted.reset();
	evmCounted.call({from, to, data: NUMBER, gasLimit: GAS_LIMIT});
	note(
		`number() asked the store for ${counted.counts.account} account(s), ` +
			`${counted.counts.code} code blob(s), ${counted.counts.storage} slot(s)`,
	);
	counted.reset();
	evmCounted.call({from, to, data: SUM_TO(2000n), gasLimit: GAS_LIMIT});
	note(
		`sumTo(2000) asked for ${counted.counts.account} account(s), ` +
			`${counted.counts.code} code blob(s), ${counted.counts.storage} slot(s)`,
	);
	const codeless = evm.call({
		from,
		to: hexToBytes('0x000000000000000000000000000000000000dEaD'),
		data: NUMBER,
		gasLimit: GAS_LIMIT,
	});
	check(
		'a call to an account that does not exist is fine',
		codeless.status,
		'success',
	);

	// The node's own engine, for the same call, on the same state.
	const ejsGas = BigInt(
		(await node.request({
			method: 'eth_estimateGas',
			params: [{from: DEPLOYER, to: counter, data: bytesToHex(NUMBER)}],
		})) as string,
	);
	check(
		'ethereumjs number() execution gas',
		ejsGas - intrinsic(NUMBER),
		REF.numberGas,
	);

	// --- a tx through the node is visible to revm with NO sync step ---------
	section('3. state coherence: a transaction, then a revm read');
	const incTx = createTx(
		{
			type: 2,
			chainId: 31337,
			nonce: 1n,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			gasLimit: 200_000n,
			to: counter,
			data: INCREMENT,
		},
		{common},
	).sign(PRIVATE_KEY);
	await node.request({
		method: 'eth_sendRawTransactionSync',
		params: [bytesToHex(incTx.serialize())],
	});
	const after = evm.call({from, to, data: NUMBER, gasLimit: GAS_LIMIT});
	check(
		'revm sees the tx with no sync step',
		BigInt(bytesToHex(after.returnData)),
		1n,
	);
	note(
		'warm-slot read now costs ' +
			(after.gasUsed - intrinsic(NUMBER)) +
			' execution gas',
	);

	// --- checkpoint / revert: the view must read the TOP of the stack -------
	section('4. checkpoint/revert: top-of-stack vs a cached frame');
	const addr = createAddressFromString(counter);
	const slot0 = setLengthLeft(bigIntToBytes(0n), 32);
	// A store that caches the top frame ONCE, i.e. the obvious wrong adapter.
	const cached = cachingStore(sm);
	const evmCached = await createRevm({wasm, state: cached, chainId: 31337n});

	await sm.checkpoint(); // exactly what the node's evmCall does per pure call
	await sm.putStorage(addr, slot0, bigIntToBytes(42n));
	const live = evm.call({from, to, data: NUMBER, gasLimit: GAS_LIMIT});
	const stale = evmCached.call({from, to, data: NUMBER, gasLimit: GAS_LIMIT});
	check(
		'top-of-stack view sees the checkpointed write',
		BigInt(bytesToHex(live.returnData)),
		42n,
	);
	check('cached-frame view is STALE', BigInt(bytesToHex(stale.returnData)), 1n);
	await sm.revert();
	const reverted = evm.call({from, to, data: NUMBER, gasLimit: GAS_LIMIT});
	check(
		'top-of-stack view follows the revert',
		BigInt(bytesToHex(reverted.returnData)),
		1n,
	);

	// --- a call that WRITES: the store must never see a write ---------------
	section('5. a mid-call write never reaches the store (call cannot commit)');
	const inc = evm.call({from, to, data: INCREMENT, gasLimit: GAS_LIMIT});
	check('revm increment() as a CALL succeeds', inc.status, 'success');
	check(
		'its log carries the post-write value',
		BigInt(bytesToHex(inc.logs![0].data)),
		2n,
	);
	const stillOne = evm.call({from, to, data: NUMBER, gasLimit: GAS_LIMIT});
	check(
		"node's state is unchanged by it",
		BigInt(bytesToHex(stillOne.returnData)),
		1n,
	);
	const nodeStill = (await node.request({
		method: 'eth_getStorageAt',
		params: [counter, '0x0'],
	})) as string;
	check('node agrees', BigInt(nodeStill), 1n);
	note('every write method on the store throws; none was called');

	// --- codeHash -> code index ---------------------------------------------
	section('6. the codeHash -> code index');
	note(
		`index holds ${store.indexedSize} entr(ies), derived from the live code map`,
	);
	// Put NEW code on chain after the index was built: its codeHash is a MISS,
	// which is what forces the rebuild. Without a rebuild-on-miss the call would
	// run EMPTY code and succeed with empty return data — silently wrong.
	const second = '0x00000000000000000000000000000000000000c0';
	await node.request({
		method: 'evm_setCode',
		params: [second, '0x602a5f5260205ff3'], // returns uint256(42)
	});
	const n2 = evm.call({
		from,
		to: hexToBytes(second),
		data: NUMBER,
		gasLimit: GAS_LIMIT,
	});
	check(
		'code written AFTER the index was built is readable',
		n2.status,
		'success',
	);
	check('  and returns real data', BigInt(bytesToHex(n2.returnData)), 42n);
	note(`index now holds ${store.indexedSize} entr(ies)`);

	// What a stale index does when it does NOT rebuild: silent success, no code.
	const frozen = frozenIndexStore(sm);
	const evmFrozen = await createRevm({wasm, state: frozen, chainId: 31337n});
	const bad = evmFrozen.call({from, to, data: NUMBER, gasLimit: GAS_LIMIT});
	check('a stale index fails SILENTLY (status)', bad.status, 'success');
	check('  with empty return data', bad.returnData.length, 0);

	// --- what it costs, roughly (Node, not a browser) -----------------------
	section(
		'7. rough cost, Node 24 (indicative only; the real budget is a browser)',
	);
	const callData = {from: DEPLOYER, to: counter, data: bytesToHex(NUMBER)};
	const timeAsync = async (n: number, f: () => Promise<unknown>) => {
		for (let i = 0; i < 20; i++) await f();
		const t0 = performance.now();
		for (let i = 0; i < n; i++) await f();
		return (performance.now() - t0) / n;
	};
	const timeSync = (n: number, f: () => unknown) => {
		for (let i = 0; i < 20; i++) f();
		const t0 = performance.now();
		for (let i = 0; i < n; i++) f();
		return (performance.now() - t0) / n;
	};
	const ejs = () => node.request({method: 'eth_call', params: [callData]});
	const rvm = () => evm.call({from, to, data: NUMBER, gasLimit: GAS_LIMIT});
	note(
		`ethereumjs eth_call, 2 accounts in state: ${(await timeAsync(500, ejs)).toFixed(3)} ms`,
	);
	note(
		`revm + adapter,      2 accounts in state: ${timeSync(500, rvm).toFixed(3)} ms`,
	);

	// Load 2000 accounts and repeat. The node checkpoints the state manager around
	// every pure call, and SimpleStateManager's checkpoint COPIES all three maps
	// (cloning every account object), so the ethereumjs read path is O(state) per
	// call. A revm `call` cannot commit, so it needs no checkpoint at all.
	for (let i = 0; i < 2000; i++) {
		const a = '0x' + (0x100000n + BigInt(i)).toString(16).padStart(40, '0');
		await node.request({method: 'evm_setBalance', params: [a, '0x1']});
	}
	note(
		`ethereumjs eth_call, 2002 accounts:       ${(await timeAsync(200, ejs)).toFixed(3)} ms`,
	);
	note(
		`revm + adapter,      2002 accounts:       ${timeSync(200, rvm).toFixed(3)} ms`,
	);
	const cp = await timeAsync(200, async () => {
		await sm.checkpoint();
		await sm.revert();
	});
	note(
		`one checkpoint+revert alone, 2002 accounts: ${cp.toFixed(3)} ms (the O(state) copy)`,
	);

	await node.dispose();
}

// ---------------------------------------------------------------------------
// 3. stateMode:'trie'
// ---------------------------------------------------------------------------
async function trieMode(): Promise<void> {
	section("8. stateMode:'trie' — is there a synchronous view?");
	captured = undefined;
	const node = await createNode({chainId: 31337, stateMode: 'trie'});
	await node.request({method: 'eth_getBalance', params: [DEPLOYER]});
	const sm: any = captured;
	note(`state manager is ${sm.constructor.name}`);
	check(
		'has accountStack (the sync view)',
		sm.accountStack !== undefined,
		false,
	);
	check('has a trie instead', sm._trie !== undefined, true);
	check(
		'its account cache is configured',
		sm._caches?.account !== undefined,
		false,
	);
	const got = sm.getAccount(createAddressFromString(DEPLOYER));
	check('getAccount returns a Promise', got instanceof Promise, true);
	await got;
	note(
		'MerkleStateManager reads go through @ethereumjs/mpt: trie.get() is async',
	);
	note(
		'and the optional caches are (a) off here and (b) miss to the trie anyway.',
	);
	await node.dispose();
}

// --- helpers ---------------------------------------------------------------

function countingStore(sm: any) {
	const inner = new SimpleStateManagerStore(sm);
	const counts = {account: 0, code: 0, storage: 0};
	const store = {
		getAccount(a: Uint8Array) {
			counts.account++;
			return inner.getAccount(a);
		},
		getStorage(a: Uint8Array, s: Uint8Array) {
			counts.storage++;
			return inner.getStorage(a, s);
		},
		getCode(h: Uint8Array) {
			counts.code++;
			return inner.getCode(h);
		},
		getBlockHash: () => undefined,
		setAccount() {
			throw new Error('read-only');
		},
		setCode() {
			throw new Error('read-only');
		},
		setStorage() {
			throw new Error('read-only');
		},
		clearStorage() {
			throw new Error('read-only');
		},
		removeAccount() {
			throw new Error('read-only');
		},
	};
	return {
		store,
		counts,
		reset() {
			counts.account = 0;
			counts.code = 0;
			counts.storage = 0;
		},
	};
}

function cachingStore(sm: any) {
	const acc = sm.accountStack[sm.accountStack.length - 1];
	const code = sm.codeStack[sm.codeStack.length - 1];
	const st = sm.storageStack[sm.storageStack.length - 1];
	const frozen = {
		accountStack: [acc],
		codeStack: [code],
		storageStack: [st],
	};
	return new SimpleStateManagerStore(frozen as any);
}

function frozenIndexStore(sm: any) {
	// A store whose code index is built once and never rebuilt on a miss.
	const inner = new SimpleStateManagerStore(sm);
	return {
		getAccount: (a: Uint8Array) => inner.getAccount(a),
		getStorage: (a: Uint8Array, s: Uint8Array) => inner.getStorage(a, s),
		getCode: () => undefined,
		getBlockHash: () => undefined,
		setAccount() {
			throw new Error('read-only');
		},
		setCode() {
			throw new Error('read-only');
		},
		setStorage() {
			throw new Error('read-only');
		},
		clearStorage() {
			throw new Error('read-only');
		},
		removeAccount() {
			throw new Error('read-only');
		},
	};
}

await control();
await againstTheNode();
await trieMode();

console.log(
	`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
