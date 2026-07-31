/**
 * backend-tevm.ts — a tevm (`@tevm/memory-client`) backend, used ONLY as a
 * benchmark/comparison baseline in the perf suite. It is driven the realistic
 * way: a viem walletClient with a LOCAL account signs txs and hits
 * `eth_sendRawTransaction` over tevm's EIP-1193 provider. We stay on the JSON-RPC
 * surface (not tevm-specific actions) so we exercise what a real app sees.
 *
 * Observed behaviour (tevm 1.0.0-next.148/151 line, 2026-06) — informational,
 * for the comparison:
 *   - `eth_sendTransaction` (UNSIGNED; expects the node to sign for an unlocked
 *     account): the memory client has no unlocked signer, so it returns a
 *     constant placeholder tx hash and does not land the tx (receipt is `null`).
 *     The working path is sign-locally + `eth_sendRawTransaction`.
 *   - `eth_sendRawTransaction` (SIGNED) works: tx lands, receipt OK.
 *   - A legacy-tx `eth_getTransactionReceipt` `effectiveGasPrice` issue on this
 *     version line is probed separately in `reproduceLegacyTxReceiptBite()`.
 */
import {createMemoryClient} from 'tevm/memory-client';
import {
	parseEther,
	createWalletClient,
	createPublicClient,
	custom,
	type WalletClient,
	type PublicClient,
} from 'viem';
import {mnemonicToAccount} from 'viem/accounts';
import type {EvmBackend} from './scenario.js';
import {DEPLOYER, intrinsicGasForCall} from './scenario.js';
import {counterAbi} from './counter.js';

// The standard hardhat/anvil test mnemonic — acct 0 == DEPLOYER.
const TEST_MNEMONIC =
	'test test test test test test test test test test test junk';

export function makeTevmBackend(): EvmBackend {
	let client: ReturnType<typeof createMemoryClient>;
	let wallet: WalletClient;
	let pub: PublicClient;
	const account = mnemonicToAccount(TEST_MNEMONIC);

	return {
		name: 'tevm @tevm/memory-client (signed eth_sendRawTransaction)',

		async setup() {
			client = createMemoryClient({miningConfig: {type: 'manual'}});
			await client.tevmReady();
			await client.tevmSetAccount({
				address: DEPLOYER,
				balance: parseEther('1000'),
			});
			wallet = createWalletClient({
				account,
				transport: custom(client.transport),
			});
			pub = createPublicClient({transport: custom(client.transport)});
		},

		async deploy(bytecode) {
			const hash = await wallet.sendTransaction({
				account,
				chain: null,
				data: bytecode,
				gas: 3_000_000n,
				maxFeePerGas: 1_000_000_000n,
				maxPriorityFeePerGas: 1_000_000_000n,
			});
			await client.tevmMine();
			const receipt = await pub.getTransactionReceipt({hash});
			return receipt.contractAddress as `0x${string}`;
		},

		async sendCall(to, data) {
			await wallet.sendTransaction({
				account,
				chain: null,
				to,
				data,
				gas: 200_000n,
				maxFeePerGas: 1_000_000_000n,
				maxPriorityFeePerGas: 1_000_000_000n,
			});
			await client.tevmMine();
		},

		async staticCall(to, data) {
			return (await client.request({
				method: 'eth_call',
				params: [{to, data} as any, 'latest'],
			})) as `0x${string}`;
		},

		// Same RPC-surface derivation as the slim node: estimate minus intrinsic.
		async staticCallGas(to, data) {
			const est = (await client.request({
				method: 'eth_estimateGas',
				params: [{to, data} as any, 'latest'],
			})) as string;
			return BigInt(est) - intrinsicGasForCall(data);
		},

		async dumpState() {
			return await client.tevmDumpState();
		},
	};
}

/**
 * reproduceLegacyTxReceiptBite — isolates a concrete legacy-receipt issue on this
 * tevm version line: `eth_getTransactionReceipt` computed `effectiveGasPrice` by
 * unconditionally reading `tx.maxFeePerGas` — `undefined` on a *legacy* (type-0,
 * gasPrice) tx — so the receipt handler threw. We send a *signed legacy* tx and
 * try to read its receipt, returning a structured outcome (never throwing) so the
 * benchmark can record exactly how it behaves on this version. (embedded-eth-node
 * itself handles this correctly — see slim-node-checks.ts.)
 */
export async function reproduceLegacyTxReceiptBite(): Promise<{
	sent: boolean;
	receiptOk: boolean;
	error?: string;
	effectiveGasPrice?: string;
}> {
	const account = mnemonicToAccount(TEST_MNEMONIC);
	const client = createMemoryClient({miningConfig: {type: 'manual'}});
	await client.tevmReady();
	await client.tevmSetAccount({
		address: account.address,
		balance: parseEther('10'),
	});
	const wallet = createWalletClient({
		account,
		transport: custom(client.transport),
	});
	const pub = createPublicClient({transport: custom(client.transport)});
	try {
		// Signed LEGACY tx: gasPrice set, NO 1559 fields → type-0.
		const hash = await wallet.sendTransaction({
			account,
			chain: null,
			to: '0x0000000000000000000000000000000000000001',
			value: 1n,
			gas: 21_000n,
			gasPrice: 1_000_000_000n,
		});
		await client.tevmMine();
		try {
			const receipt = await pub.getTransactionReceipt({hash});
			return {
				sent: true,
				receiptOk: true,
				effectiveGasPrice: receipt?.effectiveGasPrice?.toString(),
			};
		} catch (e) {
			return {
				sent: true,
				receiptOk: false,
				error: String((e as Error)?.message ?? e),
			};
		}
	} catch (e) {
		return {
			sent: false,
			receiptOk: false,
			error: String((e as Error)?.message ?? e),
		};
	}
}
