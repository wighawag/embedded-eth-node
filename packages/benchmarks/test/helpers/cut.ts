/**
 * cut.ts — the benchmark code-under-test the playwright-browser-harness loads
 * into a real browser page. It picks an EVM backend by `params.backend`, runs the
 * shared scenario (deploy + N state txs + read + compute), and returns structured
 * `{results, timings, errors, env}`.
 *
 * This is the BENCHMARK package's cut: it compares embedded-eth-node against raw
 * @ethereumjs/* backends and tevm. The library's own correctness/conformance
 * tests live in the embedded-eth-node package, not here.
 */
import type {
	CodeUnderTest,
	RunResult,
	Timing,
} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {runScenario, type EvmBackend} from './scenario.js';
import {makeTevmBackend, reproduceLegacyTxReceiptBite} from './backend-tevm.js';
import {
	makeEthereumjsDefaultBackend,
	makeEthereumjsTunedBackend,
} from './backend-ethereumjs.js';
import {
	makeSlimNodeBackend,
	makeSlimNodeTrustedBackend,
	makeSlimNodeFabricatedBackend,
} from './backend-slim-node.js';
import {makeRevmBackend} from './backend-revm.js';

const BACKENDS: Record<string, () => EvmBackend> = {
	tevm: makeTevmBackend,
	'ethereumjs-default': makeEthereumjsDefaultBackend,
	'ethereumjs-tuned': makeEthereumjsTunedBackend,
	'embedded-eth-node': makeSlimNodeBackend,
	// same node, ecrecover skipped — isolates the fixed ~2ms/tx signature-recovery
	// cost from everything else.
	'embedded-eth-node-trusted': makeSlimNodeTrustedBackend,
	// same again but the client doesn't sign either (dummy signature) — shows the
	// ceiling of the trusted primitive: NO secp256k1 anywhere in the round trip.
	'embedded-eth-node-fabricated': makeSlimNodeFabricatedBackend,
	// revm (Rust) compiled to wasm, driving the READ path only. Hybrid — only its
	// read rows and its gas are meaningful; see backend-revm.ts.
	revm: makeRevmBackend,
};

const cut: CodeUnderTest = {
	name: 'embedded-eth-node-benchmark',

	async run(ctx): Promise<RunResult> {
		const errors: string[] = [];
		const timings: Timing[] = [];
		const results: Record<string, unknown> = {};

		const backendKey = String(ctx.params.backend ?? 'ethereumjs-tuned');
		const make = BACKENDS[backendKey];
		if (!make) {
			return {
				results: {},
				timings: [],
				errors: [`unknown backend: ${backendKey}`],
				env: captureEnv(),
			};
		}

		const repeat = Math.max(1, Number(ctx.params.repeat ?? 1));
		const median = (xs: number[]) => {
			const s = [...xs].sort((a, b) => a - b);
			return s[Math.floor(s.length / 2)];
		};

		try {
			const runs = [] as Array<Awaited<ReturnType<typeof runScenario>>>;
			for (let i = 0; i < repeat; i++) {
				runs.push(
					await runScenario(make, {
						txCount: Number(ctx.params.txCount ?? 20),
						sumTo: Number(ctx.params.sumTo ?? 2000),
						keccakIters: Number(ctx.params.keccakIters ?? 2000),
						frameCalls: Number(ctx.params.frameCalls ?? 100),
						floorCalls: Number(ctx.params.floorCalls ?? 200),
					}),
				);
			}
			const outcome = runs[runs.length - 1];
			results.backend = backendKey;
			results.repeat = repeat;
			results.address = outcome.address;
			results.finalNumber = outcome.finalNumber;
			results.computeResult = outcome.computeResult;
			results.keccakResult = outcome.keccakResult;
			// report MEDIAN of each phase across repeats (robust to JIT warmup / GC)
			timings.push({
				label: 'coldStart',
				ms: median(runs.map((r) => r.timings.coldStartMs)),
			});
			timings.push({
				label: 'deploy',
				ms: median(runs.map((r) => r.timings.deployMs)),
			});
			timings.push({
				label: 'callAvg',
				ms: median(runs.map((r) => r.timings.callAvgMs)),
			});
			timings.push({
				label: 'read',
				ms: median(runs.map((r) => r.timings.readMs)),
			});
			timings.push({
				label: 'compute',
				ms: median(runs.map((r) => r.timings.computeMs)),
			});
			timings.push({
				label: 'keccak',
				ms: median(runs.map((r) => r.timings.keccakMs)),
			});
			// frame: N small view reads back to back — the on-chain-game shape.
			timings.push({
				label: 'frame',
				ms: median(runs.map((r) => r.timings.frameMs)),
			});
			// floor: fixed per-call overhead (codeless target, zero interpretation).
			timings.push({
				label: 'floor',
				ms: median(runs.map((r) => r.timings.floorMs)),
			});

			// EXECUTION GAS + throughput. Gas is a spec quantity: identical across every
			// backend for the same call (asserted in the spec). MGas/s is the only
			// backend-independent speed unit, and it is directly comparable to published
			// evmone/revm/geth figures — unlike ms, which is contract-specific.
			const g = outcome.gas;
			if (g.computeGas !== undefined) {
				const computeMs = median(runs.map((r) => r.timings.computeMs));
				const keccakMs = median(runs.map((r) => r.timings.keccakMs));
				results.computeGas = String(g.computeGas);
				results.keccakGas = String(g.keccakGas);
				results.readGas = String(g.readGas);
				results.computeMGasPerSec =
					Math.round((Number(g.computeGas) / computeMs) * 1000) / 1e6;
				results.keccakMGasPerSec =
					Math.round((Number(g.keccakGas) / keccakMs) * 1000) / 1e6;
			}
			results.frameCalls = Number(ctx.params.frameCalls ?? 100);

			// tevm-only: probe the legacy-tx receipt behaviour on this tevm version.
			if (backendKey === 'tevm') {
				const bite = await reproduceLegacyTxReceiptBite();
				results.legacyTxReceiptBite = bite;
			}
		} catch (e) {
			errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
		}

		return {results, timings, errors, env: captureEnv()};
	},
};

export default cut;
