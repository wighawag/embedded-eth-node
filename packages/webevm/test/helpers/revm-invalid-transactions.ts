/**
 * revm-invalid-transactions.ts — the refusal battery (./invalid-transactions.ts)
 * with the `webevm/revm` engine as the engine UNDER TEST.
 *
 * The battery is engine-parameterised, the precedent set by ./revm-conformance.ts,
 * ./revm-trusted-sender.ts, ./revm-post-state.ts and ./revm-fees.ts: the same
 * invalid transactions, the same state readings, the same `@ethereumjs/vm`
 * reference node built inside it. What changes here is which EVM would have
 * executed them — and the point of the battery is that the answer does not
 * depend on that.
 *
 * A FACTORY, NOT AN ENGINE: the battery builds a fresh pair of nodes PER CASE (so
 * one case's readings are the whole of what one transaction did), and an engine
 * instance binds to exactly one node. The wasm is compiled ONCE and every engine
 * is instantiated from that same `WebAssembly.Module`.
 *
 * WHICH STATE MODE: `'none'`, the only one this engine serves. That refusal is
 * asserted where the mode split is decided (`revm-conformance.spec.ts`), not
 * restated here.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runInvalidTransactionChecks} from './invalid-transactions.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-fees.ts: the build puts the
// `.wasm` bytes IN the bundle, so the page fetches nothing.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmInvalidTransactions() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runInvalidTransactionChecks({
		makeEngine: () => createRevmEngine({wasm}),
	});
}
