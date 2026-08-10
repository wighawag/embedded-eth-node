/**
 * cut.ts — the code-under-test the playwright-browser-harness loads into a real
 * browser page for the LIBRARY's own correctness/conformance tests. It dispatches
 * on `params.mode` and returns structured `{results, timings, errors, env}`.
 *
 * Modes (one per library test):
 *   - 'slim-node-checks'   : legacy/1559 receipts, honest -32601 gaps, dump/load,
 *                            state-root mode (none throws / trie real root)
 *   - 'storage-overlay'    : `stateMode:'none'` storage is per-account with a
 *                            per-checkpoint OVERLAY — checkpoint/commit/revert
 *                            semantics against a naive control, a randomised
 *                            differential against the flat layout the node used
 *                            to ship, and the serialised dumpState format
 *   - 'engine-seam'        : the read path runs on an ENGINE — default
 *                            @ethereumjs/evm, injected engine serves all three
 *                            read-path callers, transactions stay on the VM
 *
 * `embedded-eth-node/revm` has its OWN cut (./cut-revm.ts), because its bundle
 * carries the revm `.wasm` asset and no other spec should pay for it.
 *   - 'trusted-sender'     : senderMode:'trusted' (skip ecrecover) is byte-identical
 *                            to 'recover', the cheat is absent by default, and a tx
 *                            claiming a sender its signature does not recover to
 *                            executes as the CLAIMED one. ENGINE-PARAMETERISED: the
 *                            same suite runs on revm through ./cut-revm.ts
 *   - 'conformance'        : differential vs a trie-backed @ethereumjs/vm runTx
 *   - 'statetest'          : real ethereum/tests GeneralStateTests vs trie mode
 *   - 'viem-surface'       : a typical viem/wagmi lifecycle + method-gap report
 *   - 'genesis-cheats-perf': custom genesis + evm_set* cheats + trie-vs-none perf
 *   - 'persist-reload'     : IndexedDB persistence + eth_getLogs across a reload
 *   - 'worker'             : the comlink Worker wrapper (same API, non-blocking)
 *
 * The cross-backend PERFORMANCE benchmark (vs raw @ethereumjs/* and tevm) lives in
 * the separate `embedded-eth-node-benchmarks` package, so this library package's
 * devDependencies stay free of tevm and the benchmark toolchain.
 */
import type {
	CodeUnderTest,
	RunResult,
	Timing,
} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {slimNodeHonestyChecks} from './slim-node-checks.js';
import {runStorageOverlayChecks} from './storage-overlay.js';
import {runEngineSeamChecks} from './engine-seam.js';
import {runTrustedSenderChecks} from './trusted-sender.js';
import {workerRoundtrip} from './worker-roundtrip.js';
import {runConformance} from './conformance.js';
import {viemSurfaceProbe} from './viem-surface.js';
import {runStateTests} from './statetest.js';
import {runGenesisCheatsPerf} from './genesis-cheats-perf.js';
import {persistWrite, persistRead} from './persistence-reload.js';

const cut: CodeUnderTest = {
	name: 'embedded-eth-node',

	async run(ctx): Promise<RunResult> {
		const errors: string[] = [];
		const timings: Timing[] = [];
		const results: Record<string, unknown> = {};

		// slim-node-checks: legacy + 1559 receipts, honest method-not-found gaps,
		// dump/load persistence round-trip, and the state-root mode behaviour.
		if (ctx.params.mode === 'slim-node-checks') {
			try {
				results.slimNodeChecks = await slimNodeHonestyChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// storage-overlay: the `stateMode:'none'` storage representation. Correctness
		// FIRST (semantics + a randomised differential against the layout the node
		// shipped before, with the plausible wrong version kept as a control that must
		// fail them), then the readers, then the serialised dumpState format.
		if (ctx.params.mode === 'storage-overlay') {
			try {
				results.storageOverlay = await runStorageOverlayChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// engine-seam: the node's READ path (eth_call / eth_estimateGas /
		// eth_fillTransaction) runs on an injected engine, defaulting to
		// @ethereumjs/evm with its pure-read checkpoint + EIP-2929 reset intact.
		if (ctx.params.mode === 'engine-seam') {
			try {
				results.engineSeam = await runEngineSeamChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// trusted-sender: prove senderMode:'trusted' (ecrecover skipped) produces
		// receipts + post-state IDENTICAL to the authenticated 'recover' path, that
		// the cheat methods do not exist in the default mode, and that trusted mode
		// really does let a caller impersonate.
		if (ctx.params.mode === 'trusted-sender') {
			try {
				results.trustedSender = await runTrustedSenderChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// persist-reload: prove IndexedDB persistence + eth_getLogs survive a REAL
		// page reload. phase 'write' builds + persists; the test reloads the page
		// (wiping JS state); phase 'read' creates a fresh node that auto-loads from
		// IndexedDB and re-queries everything (incl. eth_getLogs).
		if (ctx.params.mode === 'persist-reload') {
			try {
				if (ctx.phase === 'write') {
					results.write = await persistWrite();
				} else {
					results.read = await persistRead(String(ctx.params.address));
				}
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// genesis/cheats/perf: custom genesis (initialState), runtime evm_set*
		// cheats, and a trie-vs-none perf comparison.
		if (ctx.params.mode === 'genesis-cheats-perf') {
			try {
				results.genesisCheatsPerf = await runGenesisCheatsPerf();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// statetest (track B): real ethereum/tests GeneralStateTests against
		// stateMode:'trie' — assert the post-state root + logs hash match.
		if (ctx.params.mode === 'statetest') {
			try {
				const fixtures = ctx.params.fixtures as {name: string; json: any}[];
				results.stateTests = await runStateTests(fixtures);
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// viem-surface: drive the node through a typical viem/wagmi lifecycle and
		// report which EIP-1193 methods were exercised + which are unsupported.
		if (ctx.params.mode === 'viem-surface') {
			try {
				results.viemSurface = await viemSurfaceProbe();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// conformance: differential test the node's receipt/RPC layer against a
		// trie-backed @ethereumjs/vm runTx reference over a battery of signed txs,
		// for BOTH state modes. Returns per-step mismatch reports.
		if (ctx.params.mode === 'conformance') {
			try {
				const out = await runConformance();
				results.conformance = out;
				results.conformanceTotalMismatches =
					out.none.totalMismatches + out.trie.totalMismatches;
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// worker: prove the comlink Worker wrapper works (same API) and that the
		// main thread stays non-blocking while the Worker computes.
		if (ctx.params.mode === 'worker') {
			try {
				const out = await workerRoundtrip(
					String(ctx.params.workerUrl),
					Number(ctx.params.sumTo ?? 200000),
				);
				results.number = out.number;
				results.engineId = out.engineId;
				// Every plain field the worker-entry proxy must forward, read back
				// through comlink so an omission fails here instead of silently
				// reading `undefined` in a consumer.
				results.senderMode = out.senderMode;
				results.stateMode = out.stateMode;
				results.mainThreadSampleCount = out.mainThreadSampleCount;
				timings.push({label: 'workerRoundtripAvg', ms: out.roundtripAvgMs});
				timings.push({label: 'mainThreadMaxGap', ms: out.mainThreadMaxGapMs});
				timings.push({label: 'workerCompute', ms: out.workerComputeMs});
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		return {
			results: {},
			timings: [],
			errors: [`unknown mode: ${String(ctx.params.mode)}`],
			env: captureEnv(),
		};
	},
};

export default cut;
