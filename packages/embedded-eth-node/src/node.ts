/**
 * node.ts — the execution-only EIP-1193 node.
 *
 * Design: sits BETWEEN bare `EVM.runCall` (no blocks/receipts/logs) and a full
 * node (heavy). Runs on `@ethereumjs/vm` through the engine seam (see ./engine.ts)
 * + a minimal mock blockchain with `SimpleStateManager` (plain Maps, NO trie, NO
 * state-root) and NONE of the node / RPC / mempool / signing bloat.
 *
 * It is EXECUTION-ONLY:
 *   - NO account methods (eth_sendTransaction, eth_accounts, eth_sign,
 *     personal_x, wallet_x). Signing is client-side; node takes signed RAW txs.
 *   - Unsupported methods throw a real JSON-RPC method-not-found (-32601) — it
 *     NEVER fakes a success.
 *
 * BOTH halves of execution run on a swappable ENGINE (see ./engine.ts), defaulting
 * to this VM's own `@ethereumjs/evm`: the READ path (`eth_call`,
 * `eth_estimateGas`, `eth_fillTransaction`'s estimation) through `engine.call`,
 * and the MINING path through `engine.transact`. What stays the node's either way:
 * block construction, `cumulativeGasUsed`, receipt assembly, the RPC layer,
 * transaction parsing and sender recovery.
 *
 * Transport-agnostic: just `request()` (async) + mine/dump/load. Knows nothing
 * about Workers — see ./worker-entry.ts for the optional comlink wrapper.
 */
import {createVM, type VM} from '@ethereumjs/vm';
import {MerkleStateManager} from '@ethereumjs/statemanager';
import {OverlayStorageStateManager} from './state-manager.js';
import {Common, Mainnet, Hardfork} from '@ethereumjs/common';
import {createBlock, type Block} from '@ethereumjs/block';
import {createTxFromRLP, createTx, type TypedTransaction} from '@ethereumjs/tx';
import {
	createAddressFromString,
	createAccountFromRLP,
	type Address,
	Account,
	hexToBytes as hexToBytesStrict,
	bytesToHex,
	bigIntToHex,
	setLengthLeft,
	bigIntToBytes,
} from '@ethereumjs/util';

// `@ethereumjs/util`'s hexToBytes is typed to require a `0x${string}` literal.
// Our hex comes from runtime sources (RPC params, serialized state) typed as
// plain `string`, so wrap it once with a runtime 0x-guard rather than casting at
// every call site. Throws on malformed input (same as the underlying fn).
function hexToBytes(s: string): Uint8Array {
	return hexToBytesStrict((s.startsWith('0x') ? s : '0x' + s) as `0x${string}`);
}
import {keccak_256} from '@noble/hashes/sha3.js';
import {connectEngine, createEthereumjsEngine} from './engine.js';
// The engine reports EXECUTION gas for a read and the node adds intrinsic gas on top;
// an engine that charges intrinsic gas itself (revm) subtracts the SAME formula,
// so it has exactly one home. See ./intrinsic-gas.ts.
import {
	accessListGas,
	intrinsicGas as intrinsicGasOf,
} from './intrinsic-gas.js';
import {
	RpcError,
	type NodeOptions,
	type ReadCallResult,
	type Engine,
	type SenderMode,
	type SlimNode,
	type RequestArguments,
	type SerializedState,
	type SerializedBlock,
	type SerializedReceipt,
	type SerializedLog,
	type SerializedTx,
} from './types.js';

const ZERO_HASH = '0x' + '00'.repeat(32);
const EMPTY_LOGS_BLOOM = '0x' + '00'.repeat(256);

/**
 * How much gas an `eth_call` / `eth_estimateGas` that names none may burn. A
 * node-wide CONSTANT, not the node's `blockGasLimit`: the two are the same
 * number by default and are still decided apart, for the reasons recorded at its
 * one use site in `evmCall`.
 */
const DEFAULT_READ_BUDGET = 30_000_000n;

function hex(b: Uint8Array): string {
	return bytesToHex(b) as string;
}
function numHex(n: number | bigint): string {
	return bigIntToHex(BigInt(n));
}
function txHashOf(tx: TypedTransaction): string {
	return hex(tx.hash());
}

/**
 * Intrinsic gas: 21000 base (+32000 create) + calldata (16/non-zero, 4/zero) +
 * the EIP-3860 initcode word cost (2 gas per 32-byte word) for creates, from
 * Shanghai on. runCall's executionGasUsed omits all of this, so we add it back to
 * get the REAL estimate (verified against runTx totalGasSpent — exact, no fudge).
 *
 * `common` is threaded rather than captured, and it is THE node's `Common` — the
 * same instance the engine is handed at `connect`, so the two callers of the
 * shared formula cannot name different forks. See ./intrinsic-gas.ts.
 */
function intrinsicGas(
	dataHex: string,
	isCreate: boolean,
	common: Common,
): bigint {
	return intrinsicGasOf(
		hexToBytes(dataHex.startsWith('0x') ? dataHex : '0x' + dataHex),
		isCreate,
		common,
	);
}

/**
 * WHAT A SENDER MUST BE ABLE TO PAY BEFORE THE TRANSACTION RUNS: its value plus
 * its WHOLE gas limit at the MAXIMUM fee it offered.
 *
 * THE MAX FEE, NOT THE EFFECTIVE ONE, and that is the protocol's own line rather
 * than a conservative choice: EIP-1559 states it as `assert balance >= gas_limit
 * * max_fee_per_gas`, and both engines enforce exactly that — measured to the
 * wei, on both, in
 * `docs/spikes/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors/measurements.md`.
 * A node checking the EFFECTIVE price instead would admit a window of
 * transactions (`gasLimit * (maxFee - effective)` wide) that both engines then
 * refuse in their own words.
 *
 * THIS IS NOT A SECOND IMPLEMENTATION OF THE FEE ARITHMETIC. What a transaction
 * COSTS is the engine's and has exactly one implementation per engine (the
 * `effectiveGasPrice` on the receipt is the engine's own number, never
 * recomputed here — see ./engine.ts and `test/revm-fees.spec.ts`). This is an
 * ADMISSION rule: what the sender must be able to cover for the transaction to be
 * executable at all, which is the node's question because the node decides what
 * goes into the blocks it builds.
 *
 * A TYPE-3 (BLOB) TRANSACTION IS UNDERSTATED HERE by its blob fee
 * (`blobGas * maxFeePerBlobGas`), which is part of the same assertion in EIP-4844.
 * That is the known type-3 gap this node documents rather than closes (the seam
 * carries no blob fields at all), and the engines' own checks are the backstop:
 * the node admits such a transaction and the engine refuses it in its own words.
 */
function upfrontCost(tx: TypedTransaction): bigint {
	const anyTx = tx as any;
	const perGas: bigint =
		anyTx.maxFeePerGas !== undefined && anyTx.maxFeePerGas !== null
			? anyTx.maxFeePerGas
			: (anyTx.gasPrice as bigint);
	return (anyTx.value ?? 0n) + tx.gasLimit * perGas;
}

interface StoredBlock {
	block: Block;
	header: SerializedBlock;
	logs: SerializedLog[];
}

/**
 * ONE SUBMITTED TRANSACTION, as the node carries it from `eth_sendRawTransaction*`
 * (or the `evm_*As` cheats) to the block it is mined in: the parsed transaction,
 * its wire bytes (`dumpState` and `eth_getTransactionByHash` report them) and
 * WHO SENT IT.
 *
 * The sender is here — rather than being asked of `tx` at each of the three places
 * that need it — because it is only sometimes recoverable FROM the transaction:
 * `senderMode:'trusted'` states it instead (ADR 0002), and it may then differ from
 * whatever the signature recovers to. `parseTx` decides it ONCE per transaction,
 * and that one value becomes the engine's `TransactionRequest.sender`, the
 * receipt's `from`, and the `from` on the stored transaction.
 */
interface SubmittedTx {
	readonly tx: TypedTransaction;
	readonly raw: Uint8Array;
	readonly sender: Address;
}

export async function createNode(options: NodeOptions = {}): Promise<SlimNode> {
	const chainId = options.chainId ?? 31337;
	const stateMode = options.stateMode ?? 'none';
	const senderMode: SenderMode = options.senderMode ?? 'recover';
	const miningConfig = options.miningConfig ?? {type: 'auto'};
	const baseFeePerGas = options.baseFeePerGas ?? 1_000_000_000n;
	const gasPrice = options.gasPrice ?? 1_000_000_000n;
	const maxPriorityFeePerGas = options.maxPriorityFeePerGas ?? 1_000_000_000n;
	const blockGasLimit = options.blockGasLimit ?? 30_000_000n;

	const common = new Common({
		chain: {...Mainnet, chainId, name: 'embedded-eth-node'},
		hardfork: Hardfork.Cancun,
		customCrypto: {keccak256: (m: Uint8Array) => keccak_256(m)},
	});

	// State backing: SimpleStateManager (no trie, fast — default) or
	// MerkleStateManager (real trie + state root — opt-in, slower, conformance-able).
	// The 'none' manager is our SUBCLASS: storage is per-account with per-checkpoint
	// OVERLAYS (upstream copies the whole flat storage map on every message frame),
	// and it implements the `clearStorage(address)` that upstream ships as an empty
	// no-op — without which a contract created at an address that already holds
	// storage inherits it. See ./state-manager.ts.
	const sm =
		stateMode === 'trie'
			? new MerkleStateManager()
			: new OverlayStorageStateManager();

	// Touched-account set for the trie-mode dump (storage is read back via the
	// trie's own dumpStorage). We record the addresses each tx touches at the NODE
	// level (sender / to / created) rather than monkeypatching the state manager —
	// MerkleStateManager's cache/flush path is sensitive to method wrapping.
	const touchedAccounts = new Set<string>();

	const ZERO_ROOT = ZERO_HASH;
	async function currentStateRoot(): Promise<string> {
		if (stateMode !== 'trie') return ZERO_ROOT;
		const msm = sm as MerkleStateManager;
		await msm.flush(); // write cached trie nodes before reading the root
		return hex(await msm.getStateRoot());
	}

	// Flush cache into the trie after a direct state mutation (trie mode only) so
	// the next getStateRoot() reflects it. No-op in 'none' mode (the Map IS state).
	async function commitIfTrie(): Promise<void> {
		if (stateMode !== 'trie') return;
		await sm.checkpoint();
		await sm.commit();
	}

	// Read-modify-write an account (creating an empty one if absent), used by the
	// evm_set* cheat methods. Commits into the trie in trie mode.
	async function mutateAccount(
		addr: ReturnType<typeof createAddressFromString>,
		fn: (acc: Account) => void,
	): Promise<void> {
		const acc = (await sm.getAccount(addr)) ?? new Account();
		fn(acc);
		await sm.putAccount(addr, acc);
		touchedAccounts.add(addr.toString());
		await commitIfTrie();
	}

	// Minimal mock blockchain: `runTx` (inside the default engine) only needs
	// getBlock (for BLOCKHASH) + shallowCopy. In 'none' mode we never compute a
	// canonical state root.
	const blockStore = new Map<number, StoredBlock>();
	const blockByHash = new Map<string, number>();
	const receipts = new Map<string, SerializedReceipt>();
	const transactions = new Map<string, SerializedTx>();
	let allLogs: SerializedLog[] = []; // flat, ordered log index for eth_getLogs

	const mockBlockchain: any = {
		getBlock: async (n: bigint | Uint8Array) => {
			let num: number;
			if (n instanceof Uint8Array) num = blockByHash.get(hex(n)) ?? 0;
			else num = Number(n);
			const sb = blockStore.get(num) ?? blockStore.get(latestNumber);
			return sb!.block;
		},
		putBlock: async () => {},
		shallowCopy() {
			return mockBlockchain;
		},
	};

	const vm: VM = await createVM({
		common,
		stateManager: sm,
		blockchain: mockBlockchain,
	});

	// THE ENGINE: what `eth_call` / `eth_estimateGas` / `eth_fillTransaction` read
	// on AND what the mining path executes transactions on. Default = this VM's own
	// `@ethereumjs/evm`, on both halves. An injected engine is connected HERE, during
	// construction, so an engine that cannot serve this node's configuration throws
	// now rather than at the first opcode.
	//
	// `??` is the ONLY place the default is chosen, and it reads an ABSENT option,
	// never a failure: an engine that was supplied and cannot come up fails the
	// construction (see connectEngine). There is deliberately no path from
	// "your engine did not work" to "here is a node on the default engine".
	//
	// ONE ENGINE, BOTH HALVES. There is no per-operation selection here and no
	// capability check: an `Engine` implements `call` AND `transact`, `connectEngine`
	// refuses one that does not, and `node.engine` therefore names the EVM that
	// answered this node's reads and executed its transactions alike.
	const engine: Engine =
		options.engine ?? createEthereumjsEngine({vm, stateManager: sm});
	await connectEngine(engine, {
		stateManager: sm,
		common,
		stateMode,
		// Block hashes for BLOCKHASH, read LIVE (no block exists yet at this point)
		// and SYNCHRONOUSLY, because an engine answers BLOCKHASH mid-opcode.
		getBlockHash: (blockNumber: bigint) => {
			const sb = blockStore.get(Number(blockNumber));
			return sb ? hexToBytes(sb.header.hash as `0x${string}`) : undefined;
		},
	});

	let latestNumber = 0;
	let parentHash = hexToBytes(ZERO_HASH);

	// Initial balances FIRST (so the genesis state root, in trie mode, reflects them).
	if (options.initialBalances) {
		for (const [addr, bal] of Object.entries(options.initialBalances)) {
			await sm.putAccount(createAddressFromString(addr), new Account(0n, bal));
			touchedAccounts.add(createAddressFromString(addr).toString());
		}
	}
	// Full genesis pre-state (balance/nonce/code/storage) — e.g. a GeneralStateTest
	// `pre` section. Applied before block 0 so the trie-mode genesis root reflects
	// it and a post-tx getStateRoot() can be compared to the fixture's hash.
	if (options.initialState) {
		for (const [addr, acc] of Object.entries(options.initialState)) {
			const address = createAddressFromString(addr);
			await sm.putAccount(
				address,
				new Account(acc.nonce ?? 0n, acc.balance ?? 0n),
			);
			if (acc.code && acc.code !== '0x')
				await sm.putCode(address, hexToBytes(acc.code));
			for (const [slot, val] of Object.entries(acc.storage ?? {})) {
				await sm.putStorage(
					address,
					setLengthLeft(bigIntToBytes(BigInt(slot)), 32),
					hexToBytes(val),
				);
			}
			touchedAccounts.add(address.toString());
		}
		// Commit the cache into the trie so the genesis root is correct in trie mode.
		if (stateMode === 'trie') {
			await sm.checkpoint();
			await sm.commit();
		}
	}

	const blockEnv = options.blockEnv;

	/**
	 * THE GAS LIMIT OF EVERY BLOCK THIS NODE BUILDS, named once so that the block
	 * builder and the check that refuses a transaction too large for it cannot
	 * drift apart. `blockEnv.gasLimit` is the explicit per-block statement and
	 * `blockGasLimit` the node-wide one, in that order, which is the precedence the
	 * header below uses, because they are the same number.
	 *
	 * IT IS A REAL LIMIT, NOT A FORMALITY. The node used to hand `@ethereumjs/vm`
	 * a `skipBlockGasLimitValidation`, so a transaction asking for more gas than
	 * the block had was mined anyway, against a limit the block did not have, and
	 * only on that engine (revm expresses the same relaxation as a simulation
	 * switch and refuses to combine any of them with committing, so it rejected the
	 * very same transaction with `CallerGasLimitMoreThanBlock`). The flag is gone.
	 * A consumer who wants enormous gas limits raises `blockGasLimit`, which makes
	 * the permissiveness a VISIBLE property of the block that both engines honour
	 * by construction, and an honest one, since `GASLIMIT` then reports that same
	 * number to a contract.
	 */
	const minedBlockGasLimit = blockEnv?.gasLimit ?? blockGasLimit;

	// Genesis block.
	const genesis = createBlock(
		{
			header: {
				number: 0n,
				gasLimit: blockGasLimit,
				baseFeePerGas,
				timestamp: BigInt(Math.floor(Date.now() / 1000)),
			},
		},
		{common},
	);
	storeBlock(genesis, [], [], await currentStateRoot());

	// Pending raw txs awaiting the next mined block (manual/interval modes). Each
	// carries its SENDER, decided once at parse time by `parseTx`: the node derives
	// the sender (or is told it), never the engine.
	const pending: SubmittedTx[] = [];

	// newHeads subscribers.
	const headSubs = new Set<(h: {number: number; hash: string}) => void>();

	let intervalTimer: ReturnType<typeof setInterval> | undefined;
	if (miningConfig.type === 'interval') {
		intervalTimer = setInterval(() => {
			void mineBlock();
		}, miningConfig.intervalMs);
	}

	function storeBlock(
		block: Block,
		txHashes: string[],
		logs: SerializedLog[],
		stateRoot: string,
	) {
		const number = Number(block.header.number);
		const hash = hex(block.hash());
		const header: SerializedBlock = {
			number,
			hash,
			parentHash: hex(block.header.parentHash),
			timestamp: Number(block.header.timestamp),
			gasUsed: numHex(block.header.gasUsed),
			gasLimit: numHex(block.header.gasLimit),
			baseFeePerGas: numHex(block.header.baseFeePerGas ?? baseFeePerGas),
			stateRoot,
			transactions: txHashes,
			logsCount: logs.length,
		};
		blockStore.set(number, {block, header, logs});
		blockByHash.set(hash, number);
		latestNumber = number;
		parentHash = block.hash();
	}

	async function executeAndMine(
		txs: SubmittedTx[],
	): Promise<{blockNumber: number; blockHash: string; txHashes: string[]}> {
		const number = blockEnv?.number ?? BigInt(latestNumber + 1);
		const blockBaseFee = blockEnv?.baseFeePerGas ?? baseFeePerGas;
		const block = createBlock(
			{
				header: {
					number,
					gasLimit: minedBlockGasLimit,
					baseFeePerGas: blockBaseFee,
					parentHash,
					timestamp:
						blockEnv?.timestamp ?? BigInt(Math.floor(Date.now() / 1000)),
					...(blockEnv?.coinbase
						? {coinbase: createAddressFromString(blockEnv.coinbase)}
						: {}),
					// post-Merge: difficulty must be 0; prevRandao lives in mixHash.
					difficulty: 0n,
					...(blockEnv?.prevRandao
						? {mixHash: hexToBytes(blockEnv.prevRandao)}
						: {}),
				},
			},
			{common},
		);
		const blockHash = hex(block.hash());
		const blockNumber = Number(number);

		const txHashes: string[] = [];
		const blockLogs: SerializedLog[] = [];
		let cumulativeGasUsed = 0n;
		let txIndex = 0;

		for (const {tx, raw, sender} of txs) {
			// THE MINING PATH GOES THROUGH THE ENGINE. What comes back is the neutral
			// `TransactionResult` — everything a receipt needs from an EVM and nothing
			// else — so every line below is the NODE's own half: the block it landed in,
			// the running `cumulativeGasUsed`, log positions, and the receipt itself.
			// THE SENDER IS PASSED, NOT LEFT TO BE FOUND. It is the node's own value
			// (recovered, or claimed in `senderMode:'trusted'`), and the receipt's `from`
			// below is the SAME value — so "who the engine executed as" and "who the
			// receipt names" cannot drift apart by engine.
			//
			// ...AND WHETHER IT MAY SEND IT AT ALL IS ANSWERED FIRST, HERE, against the
			// state this transaction is about to run on and in the node's own words, so
			// that a replayed, unaffordable or unreachable-nonce transaction is refused
			// identically on every engine instead of in whichever vocabulary the
			// installed one happens to speak. Nothing has been committed for this
			// transaction when it throws: no receipt is built, no log is recorded, and
			// the block below is never stored.
			await refuseIfSenderCannotSend(tx, sender);
			const res = await engine.transact({tx, sender, block});
			cumulativeGasUsed += res.gasUsed;
			const h = txHashOf(tx);
			const from = sender.toString();
			const to = (tx as any).to ? (tx as any).to.toString() : null;
			const created = res.createdAddress ? hex(res.createdAddress) : null;
			// Track touched accounts for the trie-mode dump (sender, recipient, created,
			// and any account that emitted a log — that set covers what changed).
			touchedAccounts.add(from);
			if (to) touchedAccounts.add(to);
			if (created) touchedAccounts.add(created);
			for (const log of res.logs) touchedAccounts.add(hex(log.address));

			const rcptLogs: SerializedLog[] = res.logs.map((log, i) => {
				const sl: SerializedLog = {
					address: hex(log.address),
					topics: log.topics.map((t) => hex(t)),
					data: hex(log.data),
					blockNumber,
					blockHash,
					transactionHash: h,
					transactionIndex: txIndex,
					logIndex: blockLogs.length + i,
				};
				return sl;
			});
			blockLogs.push(...rcptLogs);

			const receipt: SerializedReceipt = {
				transactionHash: h,
				transactionIndex: txIndex,
				blockNumber,
				blockHash,
				from,
				to,
				contractAddress: created,
				cumulativeGasUsed: numHex(cumulativeGasUsed),
				gasUsed: numHex(res.gasUsed),
				effectiveGasPrice: numHex(res.effectiveGasPrice),
				status: res.status,
				type: (tx as any).type ?? 0,
				logs: rcptLogs,
				logsBloom: hex(res.logsBloom),
			};
			receipts.set(h, receipt);

			const stx: SerializedTx = {
				hash: h,
				raw: hex(raw),
				from,
				to,
				nonce: Number((tx as any).nonce),
				value: numHex((tx as any).value ?? 0n),
				input: hex((tx as any).data ?? new Uint8Array()),
				type: (tx as any).type ?? 0,
				blockNumber,
				blockHash,
				transactionIndex: txIndex,
				gas: numHex((tx as any).gasLimit),
				gasPrice:
					(tx as any).gasPrice !== undefined
						? numHex((tx as any).gasPrice)
						: null,
				maxFeePerGas:
					(tx as any).maxFeePerGas !== undefined
						? numHex((tx as any).maxFeePerGas)
						: null,
				maxPriorityFeePerGas:
					(tx as any).maxPriorityFeePerGas !== undefined
						? numHex((tx as any).maxPriorityFeePerGas)
						: null,
			};
			transactions.set(h, stx);
			txHashes.push(h);
			txIndex++;
		}

		allLogs.push(...blockLogs);
		storeBlock(block, txHashes, blockLogs, await currentStateRoot());
		// emit newHeads
		for (const cb of headSubs) cb({number: blockNumber, hash: blockHash});

		return {blockNumber, blockHash, txHashes};
	}

	async function mineBlock() {
		const batch = pending.splice(0, pending.length);
		return executeAndMine(batch);
	}

	/**
	 * Decode a raw tx AND DECIDE ITS SENDER, once. When `claimedFrom` is supplied
	 * (the `evm_*As` methods, `senderMode:'trusted'` only) we SKIP ecrecover and take
	 * the caller-supplied address as the sender; otherwise we recover it, as a real
	 * node does.
	 *
	 * THE SENDER IS A VALUE FROM HERE ON. It travels with the transaction (see
	 * {@link SubmittedTx}) to the receipt's `from` and across the engine seam as
	 * `TransactionRequest.sender`, so exactly ONE place in the node answers "who sent
	 * this" and no engine is trusted to answer it again. Recovery is therefore EAGER
	 * (at submit, not at mine): a transaction whose signature cannot be recovered is
	 * rejected by the `eth_sendRawTransaction*` call that submitted it rather than by
	 * a later `mine()`, which is where a `'recover'` node would have failed anyway.
	 *
	 * WHAT THIS PRIMITIVE IS: "execute this tx as this sender, do not recover".
	 * That is all. It is deliberately NOT an impersonation feature — impersonation
	 * (an address registry + unsigned `eth_sendTransaction`, anvil/hardhat style) is
	 * account POLICY, and this package has no accounts by design. Two DIFFERENT
	 * callers want this one primitive:
	 *
	 *   (a) A NORMAL, genuinely-signed tx that just wants to bypass a redundant
	 *       ecrecover. The client signed it, so it already knows the sender;
	 *       re-deriving it on a local chain is pure waste. The signature is REAL,
	 *       merely unverified.
	 *   (b) A HIGHER LAYER implementing impersonation on top: it has no key, so it
	 *       FABRICATES a signature, serialises the tx, and passes the claimed
	 *       sender. Nothing here needs to know that happened.
	 *
	 * WHY it is worth a cheat method: ecrecover is a FIXED ~2ms per tx and it is the
	 * single dominant cost of a small tx (~80% of a 21k-gas transfer; the crossover
	 * where EVM execution overtakes it is ~33k gas). Measured ~13x on `runTx` in
	 * isolation (2.52ms -> 0.19ms) and ~2.3x end-to-end through a viem-style client
	 * (2.23ms -> 0.97ms/tx; the residual is the CLIENT's own signing, which only
	 * case (b) avoids). Gas and status are byte-identical either way.
	 *
	 * HOW: the claimed address becomes this transaction's sender, full stop — nothing
	 * on the transaction is touched. Everything else about it stays REAL — same wire
	 * bytes, same `tx.hash()`, same signature on the wire — so receipts, block
	 * contents and `eth_getTransactionByHash` are unchanged. The ONLY thing dropped is
	 * the proof that the signer authorised this sender.
	 *
	 * IT USED TO SHADOW `tx.getSenderAddress()` on the parsed instance, because
	 * `runTx` reads the sender through exactly that one call. That worked only while
	 * the node itself ran `runTx`: once transactions cross the engine seam, a pinned
	 * method is an undocumented convention an engine has to interrogate the same way,
	 * and an engine recovering its own sender would silently execute as the SIGNER —
	 * charging that account, advancing its nonce, returning a plausible receipt. So
	 * the sender is data now, and the shadowing is gone rather than kept as a second
	 * mechanism saying the same thing.
	 *
	 * ---- CALLER CONTRACT, case (b) / fabricated signatures ONLY ----
	 *
	 * 1. TX BYTES MUST BE UNIQUE PER SENDER. `from` is NOT part of a transaction —
	 *    it is the OUTPUT of recovery — so the hash is computed from the bytes
	 *    alone. Two fabricated txs with the same dummy signature, nonce, `to` and
	 *    data produce the SAME hash even for different claimed senders, and would
	 *    silently overwrite each other in the receipt/tx maps. Derive the dummy `r`
	 *    from the sender address (or otherwise vary the bytes per sender). anvil hit
	 *    exactly this and fixed it by folding the sender into hash computation
	 *    (foundry #4210). Genuinely-signed txs — case (a) — are unaffected: real
	 *    signatures already differ per signer.
	 *
	 * 2. FABRICATED TXS ARE NOT PORTABLE TO A `'recover'` NODE. `dumpState` stores
	 *    each tx's raw bytes, so a dump containing fabricated signatures carries txs
	 *    no authenticated node could ever validate. Fine for a local chain; do not
	 *    treat such a dump as a replayable chain history. Again, case (a) dumps are
	 *    unaffected — those signatures are real.
	 *
	 * SAFETY: gated on `senderMode:'trusted'`. In the default `'recover'` mode these
	 * methods do not exist and we throw -32601 rather than silently trusting input.
	 */
	function parseTx(rawHex: unknown, claimedFrom?: unknown): SubmittedTx {
		const raw = hexToBytes(String(rawHex));
		if (claimedFrom === undefined) {
			const tx = createTxFromRLP(raw, {common});
			return {tx, raw, sender: tx.getSenderAddress()};
		}
		if (senderMode !== 'trusted') {
			throw new RpcError(
				-32601,
				"method not available: trusted-sender sends require senderMode:'trusted' " +
					'(create the node with {senderMode:"trusted"} to skip ecrecover). That mode ' +
					'TRUSTS the caller-supplied sender, so ANY caller can impersonate ANY ' +
					'address — never enable it where untrusted callers can reach the node.',
			);
		}
		// Throws on a malformed address rather than executing as someone unexpected.
		const from = createAddressFromString(String(claimedFrom));
		// The transaction is parsed FROZEN, like every other one: nothing about it is
		// rewritten to carry the claimed sender, because the sender does not live on it.
		const tx = createTxFromRLP(raw, {common});
		return {tx, raw, sender: from};
	}

	/**
	 * REFUSE A TRANSACTION NO BLOCK THIS NODE BUILDS COULD CONTAIN, in the node's
	 * own words, before any engine sees it.
	 *
	 * WHY THE NODE SAYS IT AND NOT THE ENGINE. Both engines enforce this rule
	 * themselves now that the default engine no longer skips it (see ./engine.ts),
	 * and NEITHER can say it legibly: `@ethereumjs/vm` says "tx has a higher gas
	 * limit than the block" and revm says `Transaction(CallerGasLimitMoreThanBlock)`.
	 * Neither carries a number, and above all neither mentions `blockGasLimit`, the
	 * knob that lifts it, which only the node knows about. The block is the NODE's
	 * half of the seam on every engine (it builds it, it configures its gas limit),
	 * so "does this transaction fit in a block I will build" is the node's question
	 * to answer, and answering it here is what makes the refusal IDENTICAL on both
	 * engines rather than merely present on both. The engines' own checks stay as
	 * the backstop underneath: this is the same rule (`tx.gasLimit >
	 * block.header.gasLimit`, per transaction, not cumulative), so a transaction
	 * that passes here passes there.
	 *
	 * WHY AT SUBMIT rather than at mine: the same reason sender recovery is eager
	 * (see {@link parseTx}). The transaction is rejected by the
	 * `eth_sendRawTransaction*` call that submitted it, rather than sitting in
	 * `pending` and taking a whole later `mine()` batch down with it. Nothing about
	 * the answer changes with time: every block this node builds has the same
	 * {@link minedBlockGasLimit}.
	 */
	function refuseIfOverBlockGasLimit(tx: TypedTransaction): void {
		const gasLimit = (tx as any).gasLimit as bigint;
		if (gasLimit <= minedBlockGasLimit) return;
		// -32000 (the JSON-RPC server-error range geth uses for a transaction its
		// pool refuses) rather than 3 `execution reverted`: nothing executed, and a
		// client that reads a revert here would look for return data that does not
		// exist.
		throw new RpcError(
			-32000,
			`transaction gas limit ${gasLimit} exceeds the block gas limit ${minedBlockGasLimit}, so no block this node builds could contain it. ` +
				`It is REFUSED rather than mined against a limit the block does not have (a real node refuses it too, and this node's other EVM engine always did). ` +
				`To allow it, raise the limit: createNode({blockGasLimit: ${gasLimit}n}). The default is 30000000n, or blockEnv.gasLimit if you set the block environment explicitly. ` +
				`The block then really is that large: GASLIMIT reports the configured value to a contract, and eth_getBlockByNumber reports it too.`,
		);
	}

	/**
	 * REFUSE A TRANSACTION THE SENDER'S OWN ACCOUNT FORBIDS — a replay, a nonce this
	 * node will never reach, or a bill the sender cannot cover — in the node's own
	 * words, before the engine sees it.
	 *
	 * WHY THE NODE SAYS IT AND NOT THE ENGINE, which is the same argument
	 * {@link refuseIfOverBlockGasLimit} makes and the reason this sits beside it.
	 * Both engines enforce these three rules already, and neither can say them in a
	 * way a client can use: `@ethereumjs/vm` answers a replay with `the tx doesn't
	 * have the correct nonce. account has nonce of: 1 tx has nonce of: 0` followed
	 * by a dump of the whole block and transaction, and revm answers it with
	 * `Transaction(NonceTooLow { tx: 0, state: 1 })`. Same node, same transaction,
	 * two unrelated sentences — and the revm one is a wasm-shaped string arriving
	 * where a client expects prose, the transaction-path twin of the mistake
	 * recorded in the `rejectionMessage` JSDoc of ./revm.ts. The node owns the
	 * STATE on every engine (ADR 0010) and it owns the transaction's parsing, so
	 * "may this sender send this transaction now" is the node's question, and
	 * answering it here is what makes the refusal IDENTICAL across engines rather
	 * than merely present on both. The engines' own checks stay as the backstop
	 * underneath: these are the same three rules, so a transaction that passes here
	 * passes there.
	 *
	 * IT ALSO FIXES THE ORDER, which no engine agrees about: a transaction that is
	 * both replayed and unaffordable is reported as a nonce failure by geth and by
	 * this node, and could be reported as either by an engine. One order here means
	 * one answer whatever is installed.
	 *
	 * WHY AT MINE-TIME rather than at submit, unlike its two siblings: these answers
	 * CHANGE WITH TIME. In `manual`/`interval` mining a consumer submits nonce 0 and
	 * nonce 1 back to back, and at submit the second is a nonce this node has not
	 * reached; by the time the batch is mined, the first has advanced it. The same
	 * goes for the money. So the reading is taken at the last possible moment —
	 * immediately before the engine would execute it — against the state the
	 * transaction is actually about to run on.
	 *
	 * THE VOCABULARY IS geth's leading clause (`nonce too low` / `nonce too high` /
	 * `insufficient funds for gas * price + value`), because a client already knows
	 * it: viem maps those phrases onto typed errors. Inventing a private dialect for
	 * rules the whole ecosystem already names would cost every consumer a
	 * translation and buy nothing. What follows the clause is this node's own
	 * honest-edge half — what happened and what to do about it — including the one
	 * thing a real node would NOT say: that there is no mempool here, so a
	 * too-high nonce is refused rather than queued.
	 */
	async function refuseIfSenderCannotSend(
		tx: TypedTransaction,
		sender: Address,
	): Promise<void> {
		// ONE READ of the sender's account, for both rules: a missing account is a
		// sender at nonce 0 holding nothing, which is exactly how every other read on
		// this node reports it (`eth_getTransactionCount`, `eth_getBalance`).
		const account = await sm.getAccount(sender);
		const stateNonce = account?.nonce ?? 0n;
		const txNonce = tx.nonce;
		const address = sender.toString();
		if (txNonce < stateNonce) {
			throw new RpcError(
				-32000,
				`nonce too low: address ${address}, tx: ${txNonce}, state: ${stateNonce}. ` +
					`The sender has already used that nonce, so this transaction is a REPLAY ` +
					`and is REFUSED rather than mined a second time. Sign it again with nonce ` +
					`${stateNonce} — eth_getTransactionCount reports the sender's next nonce.`,
			);
		}
		if (txNonce > stateNonce) {
			throw new RpcError(
				-32000,
				`nonce too high: address ${address}, tx: ${txNonce}, state: ${stateNonce}. ` +
					`This node has NO MEMPOOL, so a transaction that is not executable NOW is ` +
					`refused rather than queued until the gap is filled: waiting will not mine ` +
					`it. Send the missing transactions first, or sign this one with nonce ` +
					`${stateNonce} — eth_getTransactionCount reports the sender's next nonce.`,
			);
		}
		const balance = account?.balance ?? 0n;
		const upfront = upfrontCost(tx);
		if (balance < upfront) {
			throw new RpcError(
				-32000,
				`insufficient funds for gas * price + value: address ${address} have ` +
					`${balance} want ${upfront}. The sender must be able to pay for its WHOLE ` +
					`gas limit at the maximum fee it offered, plus the value it sends, BEFORE ` +
					`the transaction runs — even though it is charged less than that once the ` +
					`gas it really used is known. Lower the value, the gas limit or ` +
					`maxFeePerGas, or fund the sender.`,
			);
		}
	}

	/**
	 * REFUSE A TRANSACTION THAT COULD NOT REACH ITS FIRST OPCODE, in the node's own
	 * words, before any engine sees it.
	 *
	 * The second of the two refusals a transaction earns ON ITS OWN, which is why it
	 * sits beside {@link refuseIfOverBlockGasLimit} and at the same moment: both
	 * read the transaction and nothing else, so neither answer can change while the
	 * transaction waits in `pending`, and refusing eagerly means the
	 * `eth_sendRawTransaction*` call that submitted it is the one that fails. The
	 * two that DO depend on the chain's state — the nonce and the money — are
	 * checked at the last possible moment instead, in {@link refuseIfSenderCannotSend}.
	 *
	 * THE FLOOR IS THE TRANSACTION'S OWN `getIntrinsicGas()`, NOT the shared
	 * `intrinsicGas()` of ./intrinsic-gas.ts, and the difference is load-bearing:
	 * the shared formula has no ACCESS-LIST term, because an `eth_call` carries no
	 * access list, so it is 6,200 gas short for a type-1 transaction naming one
	 * address and two keys. Both engines charge the access list, so a check built on
	 * the shared formula would wave such a transaction through and let the engine
	 * refuse it in its own vocabulary — the exact divergence this refusal exists to
	 * remove. Measured, on four transaction shapes and against BOTH engines' actual
	 * floors, in
	 * `docs/spikes/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors/measurements.md`.
	 * The two figures answer two different questions and both are the node's: what a
	 * READ must be budgeted (and an engine's execution gas topped up by), versus what
	 * a TRANSACTION must be able to pay before it starts.
	 */
	function refuseIfBelowIntrinsicGas(tx: TypedTransaction): void {
		const gasLimit = tx.gasLimit;
		const minimum = tx.getIntrinsicGas();
		if (gasLimit >= minimum) return;
		throw new RpcError(
			-32000,
			`intrinsic gas too low: have ${gasLimit}, want ${minimum}. ` +
				`A transaction pays a 21000 base plus its calldata (and its access list, and ` +
				`32000 more to create a contract) before its first opcode runs, so this gas ` +
				`limit could not start it and no block this node builds could contain it. ` +
				`Raise the gas limit to at least ${minimum} — eth_estimateGas reports what a ` +
				`transaction needs, given the same calldata AND the same access list, which ` +
				`it charges too.`,
		);
	}

	/** Queue-or-execute a submitted tx; returns the hash, or the receipt if `sync`. */
	async function submit(
		submitted: SubmittedTx,
		sync: boolean,
	): Promise<unknown> {
		refuseIfOverBlockGasLimit(submitted.tx);
		refuseIfBelowIntrinsicGas(submitted.tx);
		const h = txHashOf(submitted.tx);
		if (miningConfig.type === 'auto') {
			await executeAndMine([submitted]);
		} else {
			pending.push(submitted);
			if (sync) await mineBlock();
		}
		if (!sync) return h;
		const r = receipts.get(h);
		return r ? receiptToRpc(r) : null;
	}

	// ---------- block lookup helpers ----------
	function resolveBlockTag(tag: unknown): number {
		if (
			tag === 'latest' ||
			tag === 'pending' ||
			tag === 'safe' ||
			tag === 'finalized' ||
			tag == null
		)
			return latestNumber;
		if (tag === 'earliest') return 0;
		if (typeof tag === 'string') return Number(BigInt(tag));
		if (typeof tag === 'number') return tag;
		return latestNumber;
	}

	function blockToRpc(sb: StoredBlock, fullTx: boolean) {
		const h = sb.header;
		return {
			number: numHex(h.number),
			hash: h.hash,
			parentHash: h.parentHash,
			nonce: '0x0000000000000000',
			sha3Uncles: ZERO_HASH,
			logsBloom: EMPTY_LOGS_BLOOM,
			transactionsRoot: ZERO_HASH,
			stateRoot: h.stateRoot,
			receiptsRoot: ZERO_HASH,
			miner: '0x0000000000000000000000000000000000000000',
			difficulty: '0x0',
			totalDifficulty: '0x0',
			extraData: '0x',
			size: '0x0',
			gasLimit: h.gasLimit,
			gasUsed: h.gasUsed,
			timestamp: numHex(h.timestamp),
			baseFeePerGas: h.baseFeePerGas,
			uncles: [],
			transactions: fullTx
				? h.transactions.map((th) => txToRpc(transactions.get(th)!))
				: h.transactions,
		};
	}

	function txToRpc(t: SerializedTx) {
		return {
			hash: t.hash,
			nonce: numHex(t.nonce),
			blockHash: t.blockHash,
			blockNumber: numHex(t.blockNumber),
			transactionIndex: numHex(t.transactionIndex),
			from: t.from,
			to: t.to,
			value: t.value,
			gas: t.gas,
			gasPrice: t.gasPrice,
			maxFeePerGas: t.maxFeePerGas,
			maxPriorityFeePerGas: t.maxPriorityFeePerGas,
			input: t.input,
			type: numHex(t.type),
			chainId: numHex(chainId),
		};
	}

	function receiptToRpc(r: SerializedReceipt) {
		return {
			transactionHash: r.transactionHash,
			transactionIndex: numHex(r.transactionIndex),
			blockHash: r.blockHash,
			blockNumber: numHex(r.blockNumber),
			from: r.from,
			to: r.to,
			contractAddress: r.contractAddress,
			cumulativeGasUsed: r.cumulativeGasUsed,
			gasUsed: r.gasUsed,
			effectiveGasPrice: r.effectiveGasPrice,
			status: r.status ? '0x1' : '0x0',
			type: numHex(r.type),
			logs: r.logs.map(logToRpc),
			logsBloom: r.logsBloom,
		};
	}

	function logToRpc(l: SerializedLog) {
		return {
			address: l.address,
			topics: l.topics,
			data: l.data,
			blockNumber: numHex(l.blockNumber),
			blockHash: l.blockHash,
			transactionHash: l.transactionHash,
			transactionIndex: numHex(l.transactionIndex),
			logIndex: numHex(l.logIndex),
			removed: false,
		};
	}

	// ---------- eth_call / estimateGas through the ENGINE's READ half (no signing) ----
	/**
	 * The node's single pure-read helper, and the read half of the engine seam: it
	 * normalises RPC params into a {@link ReadCallRequest} and hands them to the
	 * engine's `call`.
	 * Three dispatcher cases use it (`eth_call`, `eth_estimateGas` and
	 * `eth_fillTransaction`'s estimation).
	 *
	 * Keeping a read PURE is the engine's job, not this function's — the default
	 * `@ethereumjs/evm` engine checkpoints/reverts and resets EIP-2929 warmth
	 * because that EVM requires it; an engine that cannot commit pays for neither.
	 * See ./engine.ts.
	 */
	async function evmCall(params: any): Promise<ReadCallResult> {
		const from = params.from
			? createAddressFromString(params.from)
			: createAddressFromString('0x0000000000000000000000000000000000000000');
		const to = params.to ? createAddressFromString(params.to) : undefined;
		const data = params.data
			? hexToBytes(params.data)
			: params.input
				? hexToBytes(params.input)
				: new Uint8Array();
		const value = params.value ? BigInt(params.value) : 0n;
		// THE DEFAULT READ BUDGET IS A CONSTANT, DELIBERATELY NOT `blockGasLimit`.
		// They are the same number by default (30,000,000) and it would be easy to
		// read the second off the first, but they answer different questions and are
		// DECIDED APART. That is recorded here because a `blockGasLimit` a consumer
		// may now have to raise (it is what buys back the block-gas-limit relaxation
		// the engines used to disagree about; see `refuseIfOverBlockGasLimit` above)
		// makes the link actively harmful:
		//  - A BLOCK GAS LIMIT is a property of the chain a transaction is mined into,
		//    visible to a contract as `GASLIMIT`. A READ BUDGET is how long an
		//    `eth_call` with no `gas` may run before it halts. Linking them means
		//    `createNode({blockGasLimit: 10_000_000_000n})` silently buys every
		//    unbudgeted `eth_call` a 300x longer runaway, and the browser tab that
		//    locks up is nowhere near the option that caused it.
		//  - The constant is also QUOTED as a fixed number by the revm engine's
		//    hardfork refusals (`REVM_REFUSED_HARDFORKS.osaka` compares it against
		//    EIP-7825's 16,777,216 cap in src/revm.ts), which a per-node value would
		//    make wrong for some nodes and right for others.
		// A caller who wants a bigger budget passes `gas` on the call itself, which is
		// the standard `eth_call` field for exactly this and needs no configuration.
		const gasLimit = params.gas ? BigInt(params.gas) : DEFAULT_READ_BUDGET;
		return engine.call({
			from,
			to,
			data,
			value,
			gasLimit,
			block: blockStore.get(latestNumber)!.block,
		});
	}

	// ---------- the EIP-1193 dispatcher ----------
	async function request(args: RequestArguments): Promise<unknown> {
		const params = (args.params ?? []) as any[];
		switch (args.method) {
			case 'eth_chainId':
				return numHex(chainId);
			case 'net_version':
				return String(chainId);
			case 'eth_blockNumber':
				return numHex(latestNumber);

			case 'eth_getBlockByNumber': {
				const sb = blockStore.get(resolveBlockTag(params[0]));
				return sb ? blockToRpc(sb, Boolean(params[1])) : null;
			}
			case 'eth_getBlockByHash': {
				const num = blockByHash.get(String(params[0]).toLowerCase());
				const sb = num != null ? blockStore.get(num) : undefined;
				return sb ? blockToRpc(sb, Boolean(params[1])) : null;
			}

			case 'eth_call': {
				const r = await evmCall(params[0] ?? {});
				if (r.error)
					throw new RpcError(3, 'execution reverted', hex(r.returnValue));
				return hex(r.returnValue);
			}
			case 'eth_estimateGas': {
				// Run and measure, NO fudge. We compute the REAL number =
				// executionGasUsed (from a pure, reverted runCall) + the intrinsic gas
				// (21000 base, +32000 for creation, + per-byte calldata cost). This
				// matches what the tx actually pays in runTx (verified against
				// totalGasSpent) without mutating state.
				//
				// PLUS THE REQUEST'S ACCESS LIST, which the engine never saw: a read is
				// executed with no access list on either engine (`ReadCallRequest` carries
				// none), so EIP-2930's 2,400 per address and 1,900 per storage key are
				// charged HERE, above the seam, by the one caller that has a request to
				// read them off. Without it this method answers 21,000 for a type-1
				// transaction whose intrinsic floor is 27,200, and
				// `refuseIfBelowIntrinsicGas` above sends the caller to THIS method for the
				// number a transaction needs, so the node would refuse the figure it had
				// just recommended. Why it is a separate term rather than one more line in
				// the shared formula, and why it deliberately over-estimates a list whose
				// entries are touched: `accessListGas` in ./intrinsic-gas.ts.
				const p = params[0] ?? {};
				const r = await evmCall(p);
				if (r.error)
					throw new RpcError(3, 'execution reverted', hex(r.returnValue));
				const dataHex: string = p.data ?? p.input ?? '0x';
				const isCreate = !p.to;
				return numHex(
					r.executionGasUsed +
						intrinsicGas(dataHex, isCreate, common) +
						accessListGas(p.accessList),
				);
			}

			case 'eth_fillTransaction': {
				// Fill the missing fields of a tx request and return {tx, raw} like geth
				// does (the `raw` is the UNSIGNED serialization — the node has no keys; a
				// client signs client-side). viem's prepareTransactionRequest probes this
				// to fill nonce/gas/fees in one round-trip; it reads the filled fields off
				// `tx` and re-signs itself, so an unsigned `raw` is correct here.
				const p = params[0] ?? {};
				const from = p.from
					? createAddressFromString(p.from)
					: createAddressFromString(
							'0x0000000000000000000000000000000000000000',
						);
				const acc = await sm.getAccount(from);
				const nonce = p.nonce != null ? BigInt(p.nonce) : (acc?.nonce ?? 0n);
				const value = p.value != null ? BigInt(p.value) : 0n;
				const dataHex: string = p.data ?? p.input ?? '0x';
				const isCreate = !p.to;
				// Gas: estimate (executionGasUsed + intrinsic) unless caller fixed it.
				let gas: bigint;
				if (p.gas != null) {
					gas = BigInt(p.gas);
				} else {
					const r = await evmCall(p);
					if (r.error)
						throw new RpcError(3, 'execution reverted', hex(r.returnValue));
					gas = r.executionGasUsed + intrinsicGas(dataHex, isCreate, common);
				}
				// Fee fields: legacy iff caller passed gasPrice (and no 1559 fields),
				// otherwise EIP-1559 with the node's constant fee market.
				const isLegacy =
					p.gasPrice != null &&
					p.maxFeePerGas == null &&
					p.maxPriorityFeePerGas == null;
				const type = isLegacy ? 0 : 2;
				const txData: any = {
					nonce,
					gasLimit: gas,
					value,
					data: hexToBytes(dataHex.startsWith('0x') ? dataHex : '0x' + dataHex),
					to: p.to ?? undefined,
					type,
				};
				if (isLegacy) {
					txData.gasPrice = p.gasPrice != null ? BigInt(p.gasPrice) : gasPrice;
				} else {
					txData.maxFeePerGas =
						p.maxFeePerGas != null
							? BigInt(p.maxFeePerGas)
							: baseFeePerGas + maxPriorityFeePerGas;
					txData.maxPriorityFeePerGas =
						p.maxPriorityFeePerGas != null
							? BigInt(p.maxPriorityFeePerGas)
							: maxPriorityFeePerGas;
					txData.chainId = chainId;
				}
				const unsigned = createTx(txData, {common});
				// Build the RPC transaction object viem reads its filled fields off of.
				const tx = {
					from: from.toString(),
					to: p.to ?? null,
					nonce: numHex(nonce),
					gas: numHex(gas),
					value: numHex(value),
					input: hex(txData.data),
					type: numHex(type),
					chainId: numHex(chainId),
					gasPrice: isLegacy ? numHex(txData.gasPrice) : null,
					maxFeePerGas: isLegacy ? null : numHex(txData.maxFeePerGas),
					maxPriorityFeePerGas: isLegacy
						? null
						: numHex(txData.maxPriorityFeePerGas),
					// placeholders viem deletes from the formatted tx (blockHash etc.)
					hash: ZERO_HASH,
					blockHash: null,
					blockNumber: null,
					transactionIndex: null,
					v: '0x0',
					r: ZERO_HASH,
					s: ZERO_HASH,
				};
				return {raw: hex(unsigned.serialize()), tx};
			}

			case 'eth_getBalance': {
				const acc = await sm.getAccount(createAddressFromString(params[0]));
				return numHex(acc?.balance ?? 0n);
			}
			case 'eth_getTransactionCount': {
				const acc = await sm.getAccount(createAddressFromString(params[0]));
				return numHex(acc?.nonce ?? 0n);
			}
			case 'eth_getCode': {
				const code = await sm.getCode(createAddressFromString(params[0]));
				return hex(code);
			}
			case 'eth_getStorageAt': {
				const addr = createAddressFromString(params[0]);
				const slot = setLengthLeft(bigIntToBytes(BigInt(params[1])), 32);
				const val = await sm.getStorage(addr, slot);
				return hex(setLengthLeft(val, 32));
			}

			// ---- Runtime state cheats (anvil/hardhat-style; for tests/local tooling) ----
			// These MUTATE state directly (no tx). Honest about being non-standard: they
			// are `evm_*`-namespaced. In trie mode each commits into the trie so the next
			// getStateRoot() reflects the change.
			case 'evm_setBalance': {
				// params: [address, valueHex]
				const addr = createAddressFromString(params[0]);
				await mutateAccount(addr, (acc) => {
					acc.balance = BigInt(params[1]);
				});
				return true;
			}
			case 'evm_setNonce': {
				// params: [address, nonceHex]
				const addr = createAddressFromString(params[0]);
				await mutateAccount(addr, (acc) => {
					acc.nonce = BigInt(params[1]);
				});
				return true;
			}
			case 'evm_setCode': {
				// params: [address, codeHex]
				const addr = createAddressFromString(params[0]);
				await sm.putCode(addr, hexToBytes(params[1]));
				touchedAccounts.add(addr.toString());
				await commitIfTrie();
				return true;
			}
			case 'evm_setStorageAt': {
				// params: [address, slotHex, valueHex(32-byte)]
				const addr = createAddressFromString(params[0]);
				const slot = setLengthLeft(bigIntToBytes(BigInt(params[1])), 32);
				await sm.putStorage(
					addr,
					slot,
					setLengthLeft(hexToBytes(params[2]), 32),
				);
				touchedAccounts.add(addr.toString());
				await commitIfTrie();
				return true;
			}
			case 'evm_setAccount': {
				// params: [address, {balance?, nonce?, code?, storage?}] — set all at once.
				const addr = createAddressFromString(params[0]);
				const a = params[1] ?? {};
				await mutateAccount(addr, (acc) => {
					if (a.balance != null) acc.balance = BigInt(a.balance);
					if (a.nonce != null) acc.nonce = BigInt(a.nonce);
				});
				if (a.code != null && a.code !== '0x')
					await sm.putCode(addr, hexToBytes(a.code));
				for (const [slot, val] of Object.entries(a.storage ?? {})) {
					await sm.putStorage(
						addr,
						setLengthLeft(bigIntToBytes(BigInt(slot)), 32),
						setLengthLeft(hexToBytes(val as string), 32),
					);
				}
				await commitIfTrie();
				return true;
			}

			case 'eth_gasPrice':
				return numHex(gasPrice);
			case 'eth_maxPriorityFeePerGas':
				return numHex(maxPriorityFeePerGas);
			case 'eth_feeHistory': {
				const count = Number(BigInt(params[0] ?? '0x1'));
				return {
					oldestBlock: numHex(Math.max(0, latestNumber - count + 1)),
					baseFeePerGas: Array.from({length: count + 1}, () =>
						numHex(baseFeePerGas),
					),
					gasUsedRatio: Array.from({length: count}, () => 0.5),
					reward: Array.from({length: count}, () => [
						numHex(maxPriorityFeePerGas),
					]),
				};
			}

			case 'eth_sendRawTransaction': {
				return submit(parseTx(params[0]), false);
			}
			case 'eth_sendRawTransactionSync': {
				// The fast path: send + mine + return receipt in ONE call. Default
				// behaviour pairs with auto mining (no receipt polling = the latency win).
				return submit(parseTx(params[0]), true);
			}

			// ---- Trusted-sender variants (senderMode:'trusted' ONLY) ----
			// Same as the eth_* pair above but take an explicit `from` and SKIP
			// ecrecover. `evm_`-namespaced because they are a cheat, not a standard
			// method: the signature on the wire is never verified.
			case 'evm_sendRawTransactionAs': {
				return submit(parseTx(params[0], params[1]), false);
			}
			case 'evm_sendRawTransactionSyncAs': {
				return submit(parseTx(params[0], params[1]), true);
			}

			case 'eth_getTransactionReceipt': {
				const r = receipts.get(String(params[0]).toLowerCase());
				return r ? receiptToRpc(r) : null;
			}
			case 'eth_getTransactionByHash': {
				const t = transactions.get(String(params[0]).toLowerCase());
				return t ? txToRpc(t) : null;
			}

			case 'eth_getLogs': {
				// PERF NOTE: this does a full linear scan + filter over `allLogs` (every
				// log ever emitted) on EVERY call — O(total_logs) per query, recomputed
				// each time, no index/cache. `allLogs` is appended in block order. For a
				// local chain this is fine (in-memory, sub-ms for thousands of logs); it
				// only matters for a long-lived session with huge log counts + frequent
				// polling. An optional index (block-range pre-slice / address / topic0)
				// is deferred — see tasks/slim-node-eth-getlogs-index.md. Keep this scan as
				// the authoritative semantics if/when an index is added.
				const f = params[0] ?? {};
				const from = f.fromBlock != null ? resolveBlockTag(f.fromBlock) : 0;
				const to =
					f.toBlock != null ? resolveBlockTag(f.toBlock) : latestNumber;
				const addrFilter = f.address
					? (Array.isArray(f.address) ? f.address : [f.address]).map(
							(a: string) => a.toLowerCase(),
						)
					: null;
				const topics: (string | string[] | null)[] = f.topics ?? [];
				const out = allLogs.filter((l) => {
					if (l.blockNumber < from || l.blockNumber > to) return false;
					if (addrFilter && !addrFilter.includes(l.address.toLowerCase()))
						return false;
					for (let i = 0; i < topics.length; i++) {
						const want = topics[i];
						if (want == null) continue;
						const have = l.topics[i];
						if (have == null) return false;
						if (Array.isArray(want)) {
							if (
								!want.map((w) => w.toLowerCase()).includes(have.toLowerCase())
							)
								return false;
						} else if (want.toLowerCase() !== have.toLowerCase()) return false;
					}
					return true;
				});
				return out.map(logToRpc);
			}

			case 'eth_subscribe': {
				if (params[0] !== 'newHeads')
					throw new RpcError(
						-32601,
						`subscription type not supported: ${params[0]}`,
					);
				// Return an id; consumers using comlink should prefer onNewHead callback.
				const id = '0x' + Math.floor(Math.random() * 2 ** 48).toString(16);
				return id;
			}
			case 'eth_unsubscribe':
				return true;

			// ---- account/signing methods are intentionally NOT here ----
			case 'eth_sendTransaction':
			case 'eth_accounts':
			case 'eth_sign':
			case 'eth_signTransaction':
			case 'personal_sign':
			case 'personal_unlockAccount':
			case 'wallet_addEthereumChain':
			case 'wallet_switchEthereumChain':
				throw new RpcError(
					-32601,
					`method not supported (execution-only node — sign client-side and use eth_sendRawTransaction): ${args.method}`,
				);

			default:
				throw new RpcError(-32601, `method not found: ${args.method}`);
		}
	}

	// ---------- dump / load ----------
	async function dumpState(): Promise<SerializedState> {
		const accounts: Record<string, string> = {};
		const code: Record<string, string> = {};
		const storage: Record<string, Record<string, string>> = {};

		if (stateMode === 'trie') {
			// Trie mode dumps accounts + code via the touched-account set. NOTE: it does
			// NOT dump contract STORAGE — the EVM journals storage on an internal
			// shallowCopy of the state manager that bypasses any interception, and the
			// trie's own dumpStorage exposes only keccak-HASHED slot keys (not the raw
			// slots loadState needs). Full-storage persistence is a 'none'-mode feature
			// (where the live Map IS the committed state). Trie mode is for the REAL
			// state root (conformance block roots), not for IndexedDB persist.
			for (const addr of touchedAccounts) {
				const address = createAddressFromString(addr);
				const acc = await sm.getAccount(address);
				if (acc === undefined) continue;
				accounts[addr] = hex(acc.serialize());
				const c = await sm.getCode(address);
				if (c.length > 0) code[addr] = hex(c);
			}
		} else {
			// 'none' mode: the account and code stacks are still plain Maps whose TOP
			// frame is the live set, and storage is per-account with per-checkpoint
			// OVERLAYS, flattened by liveStorage(). Dump both directly (no trie walk).
			//
			// THE SERIALISED FORMAT IS NOT THE INTERNAL LAYOUT and must not follow it:
			// this output is persisted data (IndexedDB, loadState fixtures) with existing
			// state behind it. It stays `{address: {slot: value}}` in 0x-hex, and
			// `test/storage-overlay.spec.ts` asserts it byte-identical to a dump taken
			// from the pre-overlay flat layout.
			const live = sm as OverlayStorageStateManager;
			const accMap = live.accountStack[live.accountStack.length - 1];
			const codeMap = live.codeStack[live.codeStack.length - 1];
			for (const [addr, acc] of accMap) {
				if (acc !== undefined) accounts[addr] = hex(acc.serialize());
			}
			for (const [addr, c] of codeMap) code[addr] = hex(c);
			for (const [addr, slots] of live.liveStorage()) {
				for (const [slot, val] of slots)
					(storage[addr] ??= {})[slot] = hex(val);
			}
		}

		const blocks: SerializedBlock[] = [];
		for (let i = 0; i <= latestNumber; i++) {
			const sb = blockStore.get(i);
			if (sb) blocks.push(sb.header);
		}

		return {
			version: 1,
			chainId,
			stateMode,
			accounts,
			code,
			storage,
			blocks,
			receipts: Object.fromEntries(receipts),
			transactions: Object.fromEntries(transactions),
		};
	}

	async function loadState(state: SerializedState): Promise<void> {
		// Rehydrate accounts/code/storage directly into SimpleStateManager.
		for (const [addr, accHex] of Object.entries(state.accounts)) {
			const acc = createAccountFromRLP(hexToBytes(accHex));
			await sm.putAccount(createAddressFromString(addr), acc);
		}
		for (const [addr, c] of Object.entries(state.code)) {
			await sm.putCode(createAddressFromString(addr), hexToBytes(c));
		}
		for (const [addr, slots] of Object.entries(state.storage)) {
			for (const [slot, val] of Object.entries(slots)) {
				await sm.putStorage(
					createAddressFromString(addr),
					hexToBytes(slot),
					hexToBytes(val),
				);
			}
		}

		// Rebuild block list / receipts / tx / logs index.
		receipts.clear();
		transactions.clear();
		blockStore.clear();
		blockByHash.clear();
		allLogs = [];
		for (const [h, r] of Object.entries(state.receipts)) receipts.set(h, r);
		for (const [h, t] of Object.entries(state.transactions))
			transactions.set(h, t);

		for (const sh of state.blocks) {
			const block = createBlock(
				{
					header: {
						number: BigInt(sh.number),
						gasLimit: BigInt(sh.gasLimit),
						gasUsed: BigInt(sh.gasUsed),
						baseFeePerGas: BigInt(sh.baseFeePerGas),
						parentHash: hexToBytes(sh.parentHash),
						timestamp: BigInt(sh.timestamp),
					},
				},
				{common},
			);
			// Collect this block's logs from receipts (preserves order).
			const logs: SerializedLog[] = [];
			for (const th of sh.transactions) {
				const r = receipts.get(th);
				if (r) logs.push(...r.logs);
			}
			blockStore.set(sh.number, {block, header: sh, logs});
			blockByHash.set(sh.hash, sh.number);
			allLogs.push(...logs);
			latestNumber = sh.number;
			parentHash = block.hash();
		}
	}

	// ---------- persistence auto-load on creation ----------
	if (options.persistence) {
		const saved = await options.persistence.load();
		if (saved && saved.chainId === chainId) await loadState(saved);
	}

	async function persistIfNeeded() {
		if (options.persistence) await options.persistence.save(await dumpState());
	}

	// wrap mine() to persist
	async function mine() {
		const r = await mineBlock();
		await persistIfNeeded();
		return r;
	}

	// wrap request so state-changing methods persist after mining
	const baseRequest = request;
	async function persistingRequest(args: RequestArguments): Promise<unknown> {
		const out = await baseRequest(args);
		if (
			(args.method === 'eth_sendRawTransaction' ||
				args.method === 'eth_sendRawTransactionSync' ||
				args.method === 'evm_sendRawTransactionAs' ||
				args.method === 'evm_sendRawTransactionSyncAs') &&
			miningConfig.type === 'auto'
		) {
			await persistIfNeeded();
		}
		return out;
	}

	return {
		request: persistingRequest,
		mine,
		dumpState,
		loadState,
		stateMode,
		senderMode,
		// Identity only: the engine object itself stays internal, so the reading is a
		// plain value that survives a Worker/comlink boundary unchanged.
		engine: {id: engine.id},
		async getStateRoot() {
			if (stateMode !== 'trie') {
				throw new RpcError(
					-32004,
					"no state root in 'none' mode — create the node with stateMode:'trie' for a real Merkle-Patricia root",
				);
			}
			return currentStateRoot();
		},
		onNewHead(cb) {
			headSubs.add(cb);
			return () => headSubs.delete(cb);
		},
		async dispose() {
			if (intervalTimer) clearInterval(intervalTimer);
			headSubs.clear();
		},
	};
}
