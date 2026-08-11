/**
 * storage-keys.ts: THE TWO ROUTES INTO ONE SLOT AGREE ABOUT THE KEY, asserted on
 * the VALUE a real engine reads back, in both directions, on two engines.
 *
 * The node owns its storage key format (ADR 0009) and it is PACKED — two bytes
 * per UTF-16 code unit — because 83-84% of a cold revm storage access was JS-side
 * hex key building and this recovers half of the access
 * (`docs/spikes/revm-state-store-packed-storage-keys/measurements.md`). Moving a
 * key format brings one specific hazard with it, and it is the reason this
 * battery exists:
 *
 * **TWO KEY FORMATS THAT BOTH WORK ARE INVISIBLE TO EVERY OTHER TEST IN THIS
 * REPO.** `@ethereumjs/evm`, genesis, `loadState` and the `evm_set*` cheats write
 * storage through the ASYNC `putStorage`; revm reads it through the SYNCHRONOUS
 * `storageAt` (ADR 0005 — the interpreter is a synchronous loop inside wasm and
 * cannot await). If those two disagreed about the key, each half would still be
 * perfectly self-consistent and every cross-route read would MISS. A miss is not
 * an error: `SLOAD` on an absent slot is ZERO, and it costs the same gas as one
 * that found a value — so the cross-backend gas gate, the conformance
 * differential's receipts and every `dumpState` diff would stay green while the
 * node quietly read zeroes.
 *
 * So the assertions are ABSOLUTE VALUES, per route, per engine:
 *
 *  1. **ASYNC WRITE -> SYNCHRONOUS READ.** Storage seeded at GENESIS, then set by
 *     the `evm_setStorageAt` cheat BETWEEN transactions, then rehydrated by
 *     `loadState` — three separate arrivals through `putStorage` — read back by an
 *     `eth_call` whose `SLOAD` runs on the engine under test.
 *  2. **SYNCHRONOUS WRITE -> ASYNC READ.** A transaction whose `SSTORE` the engine
 *     under test commits, read back through `eth_getStorageAt` and through
 *     `dumpState`, neither of which goes anywhere near the engine.
 *  3. **THE SAME SLOT, NOT A SECOND ONE.** A transaction OVERWRITES a slot that
 *     genesis had already written. Two key formats would leave the account holding
 *     TWO entries for one slot, so the dump's slot COUNT is pinned as well as its
 *     values.
 *  4. **NEIGHBOURING KEYS ARE DISTINCT.** A packed key is fixed-width for a
 *     reason: a length-agnostic encoding aliases keys that differ by a trailing
 *     zero. Two slots differing only in their FIRST byte, two differing only in
 *     their LAST, one whose 32 bytes are all high and all distinct, and two
 *     CONTRACTS whose addresses differ only in the first/last byte, each holding a
 *     different value at the same slot number. An aliasing encoder makes one of
 *     these pairs answer with the other's value.
 *
 * Every reading is taken on the engine under test AND on a reference node running
 * the DEFAULT `@ethereumjs/evm` engine, which never touches the synchronous store
 * at all — so the reference is what the values MEAN, and the pinned literals in
 * the spec are what stops both engines agreeing on a zero.
 */
import {
	createNode,
	type GenesisAccount,
	type SerializedState,
	type SlimNode,
} from '../../src/index.js';
import type {EngineFactory} from './conformance.js';
import {privateKeyToAccount} from 'viem/accounts';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
const GENESIS_BALANCE = 10n ** 18n;
const BASE_FEE = 1_000_000_000n;
/** Pinned, so the two chains cannot drift on `Date.now()`. */
const TIMESTAMP = 1_700_000_000n;

/**
 * `SLOT_IO`: one contract that READS a slot or WRITES one, chosen by calldata
 * size, so both routes reach the same storage through the same address.
 *
 *   CALLDATASIZE, PUSH1 20, LT, PUSH1 13, JUMPI   ; > 32 bytes of calldata: write
 *   PUSH1 00, CALLDATALOAD, SLOAD, PUSH1 00, MSTORE, PUSH1 20, PUSH1 00, RETURN
 *   JUMPDEST (0x13)
 *   PUSH1 20, CALLDATALOAD, PUSH1 00, CALLDATALOAD, SSTORE, STOP
 *
 * Hand-written rather than compiled for the reason ./access-list.ts gives: it must
 * reach exactly one `SLOAD` or one `SSTORE`, with no dispatcher in the way.
 */
const SLOT_IO_CODE =
	'0x366020106013576000355460005260206000f35b6020356000355500';

/**
 * TWO addresses holding the SAME slot numbers with DIFFERENT values, differing
 * only in their FIRST and LAST byte. The address half of a storage key is packed
 * too, and an encoder that dropped or aliased a byte would let one of these read
 * the other's storage.
 */
const IO_A = '0x00000000000000000000000000000000000000e0';
const IO_B = '0xe000000000000000000000000000000000000000';

const b32 = (hex: string): `0x${string}` =>
	`0x${hex.padStart(64, '0')}` as `0x${string}`;

/** Slot 0. */
const S_ZERO = b32('0');
/** Differs from {@link S_ZERO} in its LAST byte only. */
const S_LAST_BYTE = b32('1');
/** Differs from {@link S_ZERO} in its FIRST byte only. */
const S_FIRST_BYTE =
	'0x0100000000000000000000000000000000000000000000000000000000000000';
/** All 32 bytes non-zero, all distinct, all above 0x7f. */
const S_WIDE =
	'0x808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f';
/** Written by the `evm_setStorageAt` cheat, between two transactions. */
const S_CHEAT = b32('7');
/** Written by a transaction, i.e. by the engine under test. */
const S_WRITTEN = b32('c0de');

const V_ZERO = b32('2a');
const V_LAST_BYTE = b32('bb');
const V_FIRST_BYTE = b32('cc');
const V_WIDE =
	'0xf0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';
const V_B_ZERO = b32('dd');
const V_CHEAT = b32('99');
const V_WRITTEN =
	'0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
/** What the transaction OVERWRITES {@link S_ZERO} with, on top of genesis's. */
const V_OVERWRITTEN = b32('2b');

const GENESIS_STATE: Record<string, GenesisAccount> = {
	[IO_A]: {
		code: SLOT_IO_CODE,
		storage: {
			[S_ZERO]: V_ZERO,
			[S_LAST_BYTE]: V_LAST_BYTE,
			[S_FIRST_BYTE]: V_FIRST_BYTE,
			[S_WIDE]: V_WIDE,
		},
	},
	[IO_B]: {code: SLOT_IO_CODE, storage: {[S_ZERO]: V_B_ZERO}},
};

/** address + slot, per reading, so a label names a real pair. */
const PROBES: [label: string, address: string, slot: string][] = [
	['A.zero', IO_A, S_ZERO],
	['A.lastByte', IO_A, S_LAST_BYTE],
	['A.firstByte', IO_A, S_FIRST_BYTE],
	['A.wide', IO_A, S_WIDE],
	['B.zero', IO_B, S_ZERO],
	['A.cheated', IO_A, S_CHEAT],
	['A.written', IO_A, S_WRITTEN],
];

export interface StorageKeyReport {
	referenceEngineId: string;
	engineId: string;
	/**
	 * `label.call` = read by an `SLOAD` on that node's ENGINE (the synchronous
	 * store, on the engine under test); `label.rpc` = read by `eth_getStorageAt`,
	 * i.e. the ASYNC state manager. Taken twice: `genesis` before any transaction,
	 * `final` after the cheat and the writing transactions.
	 */
	reads: {
		genesis: {
			reference: Record<string, string>;
			underTest: Record<string, string>;
		};
		final: {
			reference: Record<string, string>;
			underTest: Record<string, string>;
		};
	};
	/** Every `phase.label.route` the two engines disagreed about. */
	mismatches: string[];
	/** `dumpState().storage`, JSON, per engine: the SERIALISED format, unmoved. */
	dumpStorage: {reference: string; underTest: string};
	/**
	 * Slots per account in the dump. A transaction that overwrote a genesis slot
	 * through a DIFFERENT key would leave two entries where there is one.
	 */
	slotCounts: {
		reference: Record<string, number>;
		underTest: Record<string, number>;
	};
	/**
	 * The reference node's dump, loaded into a FRESH node on the engine under
	 * test, then read by an `SLOAD` on that engine: the `loadState` arrival of the
	 * async route, seen by the synchronous one.
	 */
	afterLoadState: Record<string, string>;
}

async function buildNode(makeEngine?: EngineFactory): Promise<SlimNode> {
	return createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: GENESIS_BALANCE},
		initialState: GENESIS_STATE,
		baseFeePerGas: BASE_FEE,
		blockEnv: {timestamp: TIMESTAMP},
		engine: makeEngine ? await makeEngine() : undefined,
	});
}

/** An `SLOAD` executed BY THE NODE'S ENGINE, returned as a 32-byte word. */
async function readViaEngine(
	node: SlimNode,
	address: string,
	slot: string,
): Promise<string> {
	return String(
		await node.request({
			method: 'eth_call',
			params: [{from: account.address, to: address, data: slot}, 'latest'],
		}),
	);
}

/** The same slot through `eth_getStorageAt`, i.e. the ASYNC state manager. */
async function readViaRpc(
	node: SlimNode,
	address: string,
	slot: string,
): Promise<string> {
	return String(
		await node.request({
			method: 'eth_getStorageAt',
			params: [address, slot, 'latest'],
		}),
	);
}

async function readAll(node: SlimNode): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const [label, address, slot] of PROBES) {
		out[`${label}.call`] = await readViaEngine(node, address, slot);
		out[`${label}.rpc`] = await readViaRpc(node, address, slot);
	}
	return out;
}

/** One transaction, signed ONCE and sent to both nodes as the SAME BYTES. */
async function sendToBoth(
	nodes: {label: 'reference' | 'underTest'; node: SlimNode}[],
	nonce: number,
	to: string,
	data: string,
): Promise<Record<string, string>> {
	const raw = await account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		nonce,
		gas: 200_000n,
		maxFeePerGas: BASE_FEE,
		maxPriorityFeePerGas: 0n,
		to,
		data,
	} as any);
	const status: Record<string, string> = {};
	for (const {label, node} of nodes) {
		const receipt = (await node.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		})) as {status: string};
		status[label] = String(receipt.status);
	}
	return status;
}

function slotCountsOf(storage: Record<string, Record<string, string>>) {
	const out: Record<string, number> = {};
	for (const [address, slots] of Object.entries(storage))
		out[address] = Object.keys(slots).length;
	return out;
}

export async function runStorageKeyChecks(params: {
	makeEngine: EngineFactory;
}): Promise<StorageKeyReport> {
	const reference = await buildNode();
	const underTest = await buildNode(params.makeEngine);
	const both = [
		{label: 'reference' as const, node: reference},
		{label: 'underTest' as const, node: underTest},
	];

	// ---- 1. genesis storage (an ASYNC write) read by both routes -------------
	const genesis = {
		reference: await readAll(reference),
		underTest: await readAll(underTest),
	};

	// ---- 2. a transaction WRITES a new slot and OVERWRITES a genesis one -----
	// On the engine under test both `SSTORE`s land through the SYNCHRONOUS store,
	// which is the direction `eth_getStorageAt` and `dumpState` then have to read.
	const write = (slot: string, value: string) => slot + value.slice(2);
	const sent: Record<string, string> = {};
	sent.written = JSON.stringify(
		await sendToBoth(both, 0, IO_A, write(S_WRITTEN, V_WRITTEN)),
	);
	sent.overwritten = JSON.stringify(
		await sendToBoth(both, 1, IO_A, write(S_ZERO, V_OVERWRITTEN)),
	);

	// ---- 3. the cheat: an ASYNC write arriving BETWEEN transactions ----------
	for (const {node} of both) {
		await node.request({
			method: 'evm_setStorageAt',
			params: [IO_A, S_CHEAT, V_CHEAT],
		});
	}

	const final = {
		reference: await readAll(reference),
		underTest: await readAll(underTest),
	};

	const mismatches: string[] = [];
	for (const [phase, readings] of [
		['genesis', genesis],
		['final', final],
	] as const) {
		for (const key of Object.keys(readings.reference)) {
			if (readings.reference[key] !== readings.underTest[key])
				mismatches.push(
					`${phase}.${key}: reference ${readings.reference[key]} vs underTest ${readings.underTest[key]}`,
				);
		}
	}

	// ---- 4. the SERIALISED format, and the slot COUNT ------------------------
	const referenceDump = await reference.dumpState();
	const underTestDump = await underTest.dumpState();

	// ---- 5. loadState: an ASYNC arrival, read by the SYNCHRONOUS store -------
	const fresh = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		engine: await params.makeEngine(),
	});
	await fresh.loadState(referenceDump as SerializedState);
	const afterLoadState: Record<string, string> = {};
	for (const [label, address, slot] of PROBES)
		afterLoadState[`${label}.call`] = await readViaEngine(fresh, address, slot);

	const report: StorageKeyReport = {
		referenceEngineId: String(reference.engine?.id),
		engineId: String(underTest.engine?.id),
		reads: {genesis, final},
		mismatches,
		dumpStorage: {
			reference: JSON.stringify(referenceDump.storage),
			underTest: JSON.stringify(underTestDump.storage),
		},
		slotCounts: {
			reference: slotCountsOf(referenceDump.storage),
			underTest: slotCountsOf(underTestDump.storage),
		},
		afterLoadState,
	};

	await reference.dispose?.();
	await underTest.dispose?.();
	await fresh.dispose?.();
	return report;
}
