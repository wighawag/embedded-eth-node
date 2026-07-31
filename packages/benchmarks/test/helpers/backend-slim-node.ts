/**
 * backend-slim-node.ts — the 4th benchmark backend: embedded-eth-node, driven the
 * way a real dapp drives a node: a viem walletClient with a LOCAL account signs
 * txs, hitting `eth_sendRawTransaction` over the node's EIP-1193 `request()`.
 * Reads via `eth_call`. No account methods on the node.
 *
 * This is the apples-to-apples comparison row vs ethereumjs-tuned and tevm: same
 * Counter, same 20 increments, same read + compute scenario.
 */
import {createNode, type SlimNode} from 'embedded-eth-node';
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

function makeBackend(mode: SendMode): EvmBackend {
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

	return {
		name: {
			recover:
				'embedded-eth-node (signed eth_sendRawTransactionSync, auto-mine)',
			trusted: "embedded-eth-node senderMode:'trusted' (signed, no ecrecover)",
			fabricated:
				"embedded-eth-node senderMode:'trusted' (fabricated sig — no secp256k1 at all)",
		}[mode],

		async setup() {
			node = await createNode({
				chainId: CHAIN_ID,
				senderMode,
				miningConfig: {type: 'auto'},
				initialBalances: {[account.address]: 10n ** 24n},
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
