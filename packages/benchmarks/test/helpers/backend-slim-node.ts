/**
 * backend-slim-node.ts — the 4th benchmark backend: embedded-eth-node, driven the
 * way a real dapp drives a node: a viem walletClient with a LOCAL account signs
 * txs, hitting `eth_sendRawTransaction` over the node's EIP-1193 `request()`.
 * Reads via `eth_call`. No account methods on the node.
 *
 * This is the apples-to-apples comparison row vs ethereumjs-tuned and tevm: same
 * Counter, same 20 increments, same read + compute scenario.
 *
 * It also owns the row for the node with the REVM READ ENGINE installed — the
 * configuration this feature recommends and the one nobody was measuring. Same
 * file because it is the same backend: same package, same send path, same
 * scenario, one option different (`createNode({engine})`). See
 * {@link ReadEngineChoice} below.
 */
import {createNode, type ReadEngine, type SlimNode} from 'embedded-eth-node';
import {createRevmEngine} from 'embedded-eth-node/revm';
import {
	createWalletClient,
	createPublicClient,
	custom,
	pad,
	serializeTransaction,
	type WalletClient,
	type PublicClient,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import type {EvmBackend} from './scenario.js';
import {intrinsicGasForCall} from './scenario.js';
import {counterAbi} from './counter.js';
import {compiledRevmModule} from './revm-wasm-module.js';

// anvil/hardhat acct 0 private key (== DEPLOYER address in scenario.ts)
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;

const account = privateKeyToAccount(PK);
const chain = {
	id: CHAIN_ID,
	name: 'slim',
	nativeCurrency: {name: 'E', symbol: 'E', decimals: 18},
	rpcUrls: {default: {http: []}},
} as const;

/**
 * Which of the three send paths this row measures. They differ ONLY in how the
 * sender is established, so the deltas isolate secp256k1 cost precisely:
 *
 *   'recover'    sign on the client (~1.3ms) + ecrecover on the node (~2ms).
 *                What a real node does, and the honest default.
 *   'trusted'    sign on the client, but hand the node the sender so it SKIPS
 *                ecrecover. Removes the node half only.
 *   'fabricated' NO signing at all: synthesise a dummy signature and hand over
 *                the sender. Removes BOTH halves. This is the shape a higher
 *                layer would use to implement anvil-style impersonation on top
 *                of `evm_sendRawTransactionSyncAs` — it holds no private key.
 *
 * Signing stays INSIDE the measured window for every mode (as it does for every
 * other backend, which all sign inside `sendCall`), so the rows are comparable
 * and the gaps between them mean exactly what they look like.
 */
type SendMode = 'recover' | 'trusted' | 'fabricated';

/**
 * Which EVM answers this row's READ path (`eth_call` / `eth_estimateGas`).
 *
 *   'default'  the node's own `@ethereumjs/evm`, i.e. `createNode()` untouched.
 *   'revm'     `createRevmEngine()` from the optional `embedded-eth-node/revm`
 *              subpath — the configuration a consumer opts into.
 *
 * ONLY reads move. Transactions run on `@ethereumjs/vm` whatever engine is
 * installed, so the write rows (`deploy`, `callAvg`) are unaffected by design and
 * any difference there is noise, not the engine. The rows that mean something
 * are `read`, `compute`, `keccak`, `frame` and `floor`.
 *
 * The DISTINCTION FROM THE `revm` ROW matters when reading the table: that row is
 * RAW revm owning its own state and driving everything, which is the engine's
 * ceiling. This row is the node ON revm — the same interpreter behind the node's
 * own dispatch, state adapter and RPC layer, which is what a consumer actually
 * ships and therefore what the README should cite.
 */
type ReadEngineChoice = 'default' | 'revm';

/**
 * A dummy signature for the 'fabricated' path.
 *
 * `r` CARRIES THE SENDER ON PURPOSE. `from` is not part of a transaction (it is
 * the output of recovery), so the tx hash comes from the bytes alone. With a
 * constant dummy signature, two different senders sending the same nonce/to/data
 * would produce the SAME hash and silently overwrite each other in the node's
 * receipt/tx maps. Varying `r` by sender makes the bytes, and therefore the hash,
 * unique. This is the documented caller contract (see the `parseTx` docblock in
 * the library, and foundry #4210 where anvil hit the same thing).
 */
const dummySignature = (from: `0x${string}`) =>
	({
		r: pad(from, {size: 32}),
		s: pad('0x1', {size: 32}),
		yParity: 0,
	}) as const;

function makeBackend(
	mode: SendMode,
	readEngine: ReadEngineChoice = 'default',
): EvmBackend {
	let node: SlimNode;
	let wallet: WalletClient;
	let pub: PublicClient;
	const trusted = mode !== 'recover';
	const senderMode = mode === 'recover' ? 'recover' : 'trusted';

	/** Build the raw tx, then send it down whichever path this row measures. */
	async function buildAndSend(
		to: `0x${string}` | undefined,
		data: `0x${string}`,
		gas: bigint,
	): Promise<any> {
		const tx = {
			chainId: CHAIN_ID,
			nonce: await pub.getTransactionCount({address: account.address}),
			...(to ? {to} : {}),
			data,
			gas,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			type: 'eip1559',
		} as const;
		// 'fabricated' never touches secp256k1: it stamps on a dummy signature.
		const raw =
			mode === 'fabricated'
				? serializeTransaction(tx as any, dummySignature(account.address))
				: await account.signTransaction(tx as any);
		return trusted
			? node.request({
					method: 'evm_sendRawTransactionSyncAs',
					params: [raw, account.address],
				})
			: node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
	}

	/**
	 * A fresh engine per node. An engine instance binds to exactly ONE node (a
	 * second `createNode()` on the same engine is refused, deliberately — it would
	 * re-point the first node's reads at the second node's state), and the
	 * scenario builds a new node per repeat. The compiled `WebAssembly.Module` is
	 * shared across all of them, which is what the `wasm` option accepting a
	 * compiled module is for: the wasm is compiled once per page, not per run.
	 */
	async function makeReadEngine(): Promise<ReadEngine | undefined> {
		if (readEngine === 'default') return undefined;
		return createRevmEngine({wasm: await compiledRevmModule()});
	}

	return {
		name:
			readEngine === 'revm'
				? 'embedded-eth-node + revm read engine (signed eth_sendRawTransactionSync, auto-mine)'
				: {
						recover:
							'embedded-eth-node (signed eth_sendRawTransactionSync, auto-mine)',
						trusted:
							"embedded-eth-node senderMode:'trusted' (signed, no ecrecover)",
						fabricated:
							"embedded-eth-node senderMode:'trusted' (fabricated sig — no secp256k1 at all)",
					}[mode],

		async setup() {
			node = await createNode({
				chainId: CHAIN_ID,
				senderMode,
				miningConfig: {type: 'auto'},
				initialBalances: {[account.address]: 10n ** 24n},
				// `undefined` on the default rows, so they construct exactly as before.
				engine: await makeReadEngine(),
			});
			const transport = custom(
				{request: ({method, params}) => node.request({method, params})},
				{retryCount: 0},
			);
			wallet = createWalletClient({account, chain, transport});
			pub = createPublicClient({chain, transport});
		},

		async deploy(bytecode) {
			if (trusted) {
				const rcpt = await buildAndSend(undefined, bytecode, 1_000_000n);
				return rcpt.contractAddress as `0x${string}`;
			}
			const hash = await wallet.deployContract({
				account,
				chain,
				abi: counterAbi,
				bytecode,
			});
			const receipt = await pub.getTransactionReceipt({hash});
			return receipt.contractAddress as `0x${string}`;
		},

		async sendCall(to, data) {
			// The fast path: build raw, send + mine + receipt in ONE call.
			await buildAndSend(to, data, 200_000n);
		},

		async staticCall(to, data) {
			return (await node.request({
				method: 'eth_call',
				params: [{to, data}, 'latest'],
			})) as `0x${string}`;
		},

		// Node surface: eth_estimateGas is (execution + intrinsic), so subtract the
		// intrinsic back out to get the same EXECUTION gas the raw-EVM backends
		// report. Stays on the RPC surface (no reaching into internals), so this is
		// exactly the number a consumer could compute.
		async staticCallGas(to, data) {
			const est = (await node.request({
				method: 'eth_estimateGas',
				params: [{to, data}, 'latest'],
			})) as string;
			return BigInt(est) - intrinsicGasForCall(data);
		},

		async dumpState() {
			return await node.dumpState();
		},
	};
}

export const makeSlimNodeBackend = () => makeBackend('recover');
export const makeSlimNodeTrustedBackend = () => makeBackend('trusted');
export const makeSlimNodeFabricatedBackend = () => makeBackend('fabricated');
/**
 * The node a consumer opts into: the DEFAULT send path (signed, ecrecover — no
 * cheats) with reads on revm. It differs from `makeSlimNodeBackend` by exactly
 * one `createNode` option, so the delta between the two rows IS the engine swap.
 */
export const makeSlimNodeRevmEngineBackend = () =>
	makeBackend('recover', 'revm');
