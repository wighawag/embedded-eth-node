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
	type WalletClient,
	type PublicClient,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import type {EvmBackend} from './scenario.js';
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

export function makeSlimNodeBackend(): EvmBackend {
	let node: SlimNode;
	let wallet: WalletClient;
	let pub: PublicClient;

	return {
		name: 'embedded-eth-node (signed eth_sendRawTransactionSync, auto-mine)',

		async setup() {
			node = await createNode({
				chainId: CHAIN_ID,
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
			const hash = await wallet.deployContract({
				abi: counterAbi,
				bytecode,
				args: [],
			});
			const receipt = await pub.getTransactionReceipt({hash});
			return receipt.contractAddress as `0x${string}`;
		},

		async sendCall(to, data) {
			// The fast path: sign locally, send raw + mine + receipt in ONE call.
			const raw = await account.signTransaction({
				chainId: CHAIN_ID,
				nonce: await pub.getTransactionCount({address: account.address}),
				to,
				data,
				gas: 200_000n,
				maxFeePerGas: 2_000_000_000n,
				maxPriorityFeePerGas: 1_000_000_000n,
				type: 'eip1559',
			});
			await node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
		},

		async staticCall(to, data) {
			return (await node.request({
				method: 'eth_call',
				params: [{to, data}, 'latest'],
			})) as `0x${string}`;
		},

		async dumpState() {
			return await node.dumpState();
		},
	};
}
