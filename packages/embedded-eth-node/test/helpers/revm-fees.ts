/**
 * revm-fees.ts — the money differential (./fees.ts) with the
 * `embedded-eth-node/revm` engine as the engine UNDER TEST.
 *
 * The battery is engine-parameterised, the precedent set by ./revm-conformance.ts,
 * ./revm-trusted-sender.ts and ./revm-post-state.ts: the same signed
 * transactions, the same balance readings, the same `@ethereumjs/vm` reference
 * node built inside it. What changes here is which EVM charged them.
 *
 * A FACTORY, NOT AN ENGINE: the battery builds a fresh pair of nodes PER CASE (so
 * one case's money is the whole of what one transaction did), and an engine
 * instance binds to exactly one node. The wasm is compiled ONCE and every engine
 * is instantiated from that same `WebAssembly.Module`.
 *
 * WHICH STATE MODE: `'none'`, the only one this engine serves. That refusal is
 * asserted where the mode split is decided (`revm-conformance.spec.ts`), not
 * restated here.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runFeesChecks} from './fees.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-post-state.ts: the build puts
// the `.wasm` bytes IN the bundle, so the page fetches nothing.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmFees() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runFeesChecks({makeEngine: () => createRevmEngine({wasm})});
}
