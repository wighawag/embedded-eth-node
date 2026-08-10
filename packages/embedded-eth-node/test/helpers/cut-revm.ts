/**
 * cut-revm.ts — a SECOND code-under-test, for `embedded-eth-node/revm` only.
 *
 * Why not a mode in ./cut.ts like every other library test: this bundle carries
 * the revm `.wasm` as a bundler-resolved asset, which needs its own esbuild
 * asset loader and adds ~1.2 MB to the page. Every other spec shares ./cut.ts
 * and must keep paying nothing for an engine it does not use — the same property
 * the revm subpath itself exists to preserve for consumers.
 *
 * Modes (one per revm spec):
 *   - 'revm-engine'  : the engine itself — same results + same gas as the
 *                      default engine, the node's own state, purity, BLOCKHASH,
 *                      both wasm delivery shapes, the refused state mode
 *   - 'conformance'  : the SHARED differential battery (helpers/conformance.ts)
 *                      run with the revm engine installed, in the one state mode
 *                      it serves
 *   - 'trusted-sender': the SHARED trusted-sender suite (helpers/trusted-sender.ts)
 *                      run with the revm engine installed — a tx submitted through
 *                      the `evm_*As` cheats executes as the CLAIMED sender, even
 *                      when the signature recovers to somebody else
 */
import type {
	CodeUnderTest,
	RunResult,
	Timing,
} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {runRevmEngineChecks} from './revm-engine.js';
import {runRevmConformance} from './revm-conformance.js';
import {runRevmTrustedSender} from './revm-trusted-sender.js';

const cut: CodeUnderTest = {
	name: 'embedded-eth-node/revm',

	async run(ctx): Promise<RunResult> {
		const errors: string[] = [];
		const timings: Timing[] = [];
		const results: Record<string, unknown> = {};

		// The engine itself: results + gas against the default engine, the node's
		// own state, purity, BLOCKHASH, both delivery shapes, the refused mode.
		if (ctx.params.mode === 'revm-engine') {
			try {
				results.revmEngine = await runRevmEngineChecks({
					runtimeWasmUrl: String(ctx.params.runtimeWasmUrl),
				});
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED differential battery, with the revm engine installed. Same
		// steps, same reference, same assertions as `conformance.spec.ts` — only the
		// EVM behind the read path differs.
		if (ctx.params.mode === 'conformance') {
			try {
				results.revmConformance = await runRevmConformance();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED trusted-sender suite, with the revm engine installed. Same
		// differential, same gating, same claimed-sender assertions — only the EVM that
		// executes the transactions differs.
		if (ctx.params.mode === 'trusted-sender') {
			try {
				results.revmTrustedSender = await runRevmTrustedSender();
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
