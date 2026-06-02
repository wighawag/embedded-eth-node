/**
 * scenario.ts — the backend-agnostic benchmark scenario, plus the small shape
 * each EVM backend must implement. Keeping the scenario here (not in each cut)
 * makes the three backends apples-to-apples: same deploy, same calls, same
 * counts, same measured phases.
 */
import {encodeFunctionData, decodeFunctionResult} from 'viem';
import {counterAbi, counterBytecode} from './counter.js';

export const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const; // anvil acct 0

/** A minimal EVM backend the scenario can drive. All async to fit any engine. */
export interface EvmBackend {
	readonly name: string;
	/** One-time setup: create the client/VM, fund DEPLOYER. */
	setup(): Promise<void>;
	/** Deploy `counterBytecode`, return the deployed address. */
	deploy(bytecode: `0x${string}`): Promise<`0x${string}`>;
	/** Send a state-changing tx (increment/add). Mines if the engine needs it. */
	sendCall(to: `0x${string}`, data: `0x${string}`): Promise<void>;
	/** Read-only call (eth_call style). Returns return-data hex. */
	staticCall(to: `0x${string}`, data: `0x${string}`): Promise<`0x${string}`>;
	/** Optional: serialise persistent state so we can prove it survives reload. */
	dumpState?(): Promise<unknown>;
}

export interface ScenarioParams {
	/** how many increment() txs to send */
	txCount?: number;
	/** argument to sumTo() compute call */
	sumTo?: number;
	/** iterations for the keccak256-heavy compute call */
	keccakIters?: number;
}

export interface ScenarioTimings {
	coldStartMs: number;
	deployMs: number;
	callAvgMs: number; // avg of `increment()` state-transition txs
	readMs: number; // single `number()` view call
	computeMs: number; // single `sumTo(n)` ADD-loop heavy call
	keccakMs: number; // single `keccakLoop(n)` KECCAK256-heavy call (real EVM hotspot)
}

export interface ScenarioOutcome {
	address: `0x${string}`;
	finalNumber: string; // decimal string of `number()` after txCount increments
	computeResult: string; // decimal string of sumTo(n)
	keccakResult: string; // hex string of keccakLoop(n)
	timings: ScenarioTimings;
}

export const incrementData = () =>
	encodeFunctionData({abi: counterAbi, functionName: 'increment'});

export const numberData = () =>
	encodeFunctionData({abi: counterAbi, functionName: 'number'});

export const sumToData = (n: number) =>
	encodeFunctionData({
		abi: counterAbi,
		functionName: 'sumTo',
		args: [BigInt(n)],
	});

export const keccakLoopData = (n: number) =>
	encodeFunctionData({
		abi: counterAbi,
		functionName: 'keccakLoop',
		args: [BigInt(n)],
	});

export function decodeNumber(ret: `0x${string}`): bigint {
	return decodeFunctionResult({
		abi: counterAbi,
		functionName: 'number',
		data: ret,
	}) as bigint;
}

export function decodeSumTo(ret: `0x${string}`): bigint {
	return decodeFunctionResult({
		abi: counterAbi,
		functionName: 'sumTo',
		data: ret,
	}) as bigint;
}

export function decodeKeccakLoop(ret: `0x${string}`): `0x${string}` {
	return decodeFunctionResult({
		abi: counterAbi,
		functionName: 'keccakLoop',
		data: ret,
	}) as `0x${string}`;
}

/** Run the full scenario against a backend, measuring each phase. */
export async function runScenario(
	makeBackend: () => EvmBackend,
	params: ScenarioParams,
): Promise<ScenarioOutcome> {
	const txCount = params.txCount ?? 20;
	const sumN = params.sumTo ?? 2000;
	const keccakN = params.keccakIters ?? 2000;

	const t0 = performance.now();
	const backend = makeBackend();
	await backend.setup();
	const coldStartMs = performance.now() - t0;

	const tDeploy = performance.now();
	const address = await backend.deploy(counterBytecode);
	const deployMs = performance.now() - tDeploy;

	const tCalls = performance.now();
	for (let i = 0; i < txCount; i++) {
		await backend.sendCall(address, incrementData());
	}
	const callAvgMs = (performance.now() - tCalls) / txCount;

	const tRead = performance.now();
	const numRet = await backend.staticCall(address, numberData());
	const readMs = performance.now() - tRead;

	const tCompute = performance.now();
	const sumRet = await backend.staticCall(address, sumToData(sumN));
	const computeMs = performance.now() - tCompute;

	// KECCAK256-heavy compute: the real EVM hotspot (#3227), not just an ADD loop.
	const tKeccak = performance.now();
	const keccakRet = await backend.staticCall(address, keccakLoopData(keccakN));
	const keccakMs = performance.now() - tKeccak;

	return {
		address,
		finalNumber: decodeNumber(numRet).toString(),
		computeResult: decodeSumTo(sumRet).toString(),
		keccakResult: decodeKeccakLoop(keccakRet),
		timings: {coldStartMs, deployMs, callAvgMs, readMs, computeMs, keccakMs},
	};
}
