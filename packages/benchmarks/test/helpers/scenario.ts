/**
 * scenario.ts — the backend-agnostic benchmark scenario, plus the small shape
 * each EVM backend must implement. Keeping the scenario here (not in each cut)
 * makes the three backends apples-to-apples: same deploy, same calls, same
 * counts, same measured phases.
 */
import {encodeFunctionData, decodeFunctionResult} from 'viem';
import {counterAbi, counterBytecode} from './counter.js';

export const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const; // anvil acct 0

/**
 * An address that is guaranteed to hold NO code. Calling it exercises the
 * engine's fixed per-call overhead (decode params, set up a frame, tear it down)
 * with ZERO interpretation, which is the floor every other measurement sits on.
 */
export const CODELESS = '0x000000000000000000000000000000000000dEaD' as const;

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
	/**
	 * OPTIONAL: the EXECUTION gas the EVM charged for `staticCall(to, data)` — i.e.
	 * excluding the intrinsic 21000 + calldata cost, which is transaction-level
	 * bookkeeping rather than interpretation.
	 *
	 * Why it matters twice over:
	 *   1. THROUGHPUT. gas/second (MGas/s) is the only backend-independent speed
	 *      unit. Wall-clock ms is contract-specific and not comparable to published
	 *      EVM figures; MGas/s is directly comparable to evmone/revm/geth numbers.
	 *   2. EQUIVALENCE. Every backend implements the SAME spec, so for the same call
	 *      they MUST charge the same gas. Cross-backend gas equality is the gate for
	 *      ever swapping the interpreter (for a Rust/Zig wasm EVM, say): two engines
	 *      that disagree on gas will disagree on where an op runs OUT OF gas, and a
	 *      client replaying the chain would fork. Results matching is not enough.
	 *
	 * Optional because not every engine exposes it over the surface we drive it on.
	 */
	staticCallGas?(to: `0x${string}`, data: `0x${string}`): Promise<bigint>;
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
	/** how many small view calls make up one simulated "frame" (see frameMs) */
	frameCalls?: number;
	/** how many codeless calls to average for the fixed per-call floor */
	floorCalls?: number;
}

export interface ScenarioTimings {
	coldStartMs: number;
	deployMs: number;
	callAvgMs: number; // avg of `increment()` state-transition txs
	readMs: number; // single `number()` view call
	computeMs: number; // single `sumTo(n)` ADD-loop heavy call
	keccakMs: number; // single `keccakLoop(n)` KECCAK256-heavy call (real EVM hotspot)
	/**
	 * ONE SIMULATED FRAME: `frameCalls` small `number()` view reads back to back.
	 * This is the shape an on-chain game actually has (many tiny reads per tick),
	 * which neither `read` (a single call) nor `compute` (one huge call) captures.
	 * Compare against a 16.6ms budget for 60fps.
	 */
	frameMs: number;
	/**
	 * Fixed per-call overhead: a call to a CODELESS address, so zero interpretation.
	 * Everything else is measured on top of this. It is also the row that will
	 * detect boundary-crossing cost if the interpreter is ever moved into wasm.
	 */
	floorMs: number;
}

/** Execution gas charged for the two compute calls (undefined if unsupported). */
export interface ScenarioGas {
	computeGas?: bigint;
	keccakGas?: bigint;
	readGas?: bigint;
}

export interface ScenarioOutcome {
	address: `0x${string}`;
	finalNumber: string; // decimal string of `number()` after txCount increments
	computeResult: string; // decimal string of sumTo(n)
	keccakResult: string; // hex string of keccakLoop(n)
	timings: ScenarioTimings;
	gas: ScenarioGas;
}

/**
 * Intrinsic gas of a NON-CREATE call: the flat 21000 plus per-calldata-byte cost
 * (16/non-zero, 4/zero). Mirrors the same formula the node uses, so subtracting
 * it from an `eth_estimateGas` result recovers the pure EXECUTION gas that
 * engines exposing `executionGasUsed` report directly.
 *
 * Deliberately create-free: every gas probe in this scenario is a call to an
 * existing contract, so the EIP-3860 initcode terms never apply.
 */
export function intrinsicGasForCall(data: `0x${string}`): bigint {
	const hex = data.startsWith('0x') ? data.slice(2) : data;
	let gas = 21_000n;
	for (let i = 0; i + 1 < hex.length; i += 2) {
		gas += hex.slice(i, i + 2) === '00' ? 4n : 16n;
	}
	return gas;
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
	const frameCalls = params.frameCalls ?? 100;
	const floorCalls = params.floorCalls ?? 200;

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

	// FRAME SHAPE: many small reads back to back — an on-chain game tick, not one
	// big loop. Measured separately because per-call overhead and interpreter
	// throughput trade off differently here than in the single-huge-call rows.
	const tFrame = performance.now();
	for (let i = 0; i < frameCalls; i++) {
		await backend.staticCall(address, numberData());
	}
	const frameMs = performance.now() - tFrame;

	// FLOOR: calls to a codeless address — fixed overhead with zero interpretation.
	const tFloor = performance.now();
	for (let i = 0; i < floorCalls; i++) {
		await backend.staticCall(CODELESS, '0x');
	}
	const floorMs = (performance.now() - tFloor) / floorCalls;

	// Gas is measured OUTSIDE the timed windows (it may cost an extra call) and is
	// used for MGas/s + the cross-backend equality gate.
	const gas: ScenarioGas = {};
	if (backend.staticCallGas) {
		gas.computeGas = await backend.staticCallGas(address, sumToData(sumN));
		gas.keccakGas = await backend.staticCallGas(
			address,
			keccakLoopData(keccakN),
		);
		gas.readGas = await backend.staticCallGas(address, numberData());
	}

	return {
		address,
		finalNumber: decodeNumber(numRet).toString(),
		computeResult: decodeSumTo(sumRet).toString(),
		keccakResult: decodeKeccakLoop(keccakRet),
		timings: {
			coldStartMs,
			deployMs,
			callAvgMs,
			readMs,
			computeMs,
			keccakMs,
			frameMs,
			floorMs,
		},
		gas,
	};
}
