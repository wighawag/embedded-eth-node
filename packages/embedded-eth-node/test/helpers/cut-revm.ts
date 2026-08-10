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
 *   - 'post-state'   : the SHARED post-state differential (helpers/post-state.ts)
 *                      — five state-shaped transactions (creation, nested
 *                      creation, nested-frame storage, an EIP-161 emptying, a
 *                      selfdestruct) leaving state the default engine's cannot be
 *                      told apart from, read through the node's public surface
 *   - 'fees'         : the SHARED money differential (helpers/fees.ts) — what a
 *                      legacy, EIP-2930, EIP-1559 and storage-clearing-refund
 *                      transaction COSTS, measured on BALANCES (sender charged,
 *                      coinbase credited, base fee burnt) rather than on the
 *                      receipt's `effectiveGasPrice`
 *   - 'invalid-transactions': the SHARED refusal battery
 *                      (helpers/invalid-transactions.ts) — a replayed nonce, a
 *                      far-future nonce, an unaffordable transaction and a gas
 *                      limit below intrinsic gas, refused in the NODE's own words
 *                      on both engines, with every state reading unmoved
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
import {runRevmPostState} from './revm-post-state.js';
import {runRevmFees} from './revm-fees.js';
import {runRevmInvalidTransactions} from './revm-invalid-transactions.js';

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

		// The SHARED post-state differential, with the revm engine installed. Gas
		// equality says nothing about balances, code or storage, so this is the half of
		// the correctness bar the cross-backend gate structurally cannot see.
		if (ctx.params.mode === 'post-state') {
			try {
				results.revmPostState = await runRevmPostState();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED money differential, with the revm engine installed. A receipt can
		// carry the right `effectiveGasPrice` while the wrong amount left the sender,
		// so this one reads BALANCES: what the sender was charged, what the coinbase was
		// credited, and what was burnt.
		if (ctx.params.mode === 'fees') {
			try {
				results.revmFees = await runRevmFees();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED refusal battery, with the revm engine installed. What a node
		// REFUSES must be the same on both engines, and so must what it leaves behind
		// when it refuses: a half-committed rejection is the worst outcome available
		// on this path and only a state reading catches it.
		if (ctx.params.mode === 'invalid-transactions') {
			try {
				results.revmInvalidTransactions = await runRevmInvalidTransactions();
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
