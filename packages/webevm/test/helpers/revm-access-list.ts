/**
 * revm-access-list.ts: the EIP-2930 battery (./access-list.ts) with the
 * `webevm/revm` engine as the engine UNDER TEST.
 *
 * The battery is engine-parameterised, the precedent set by ./revm-conformance.ts,
 * ./revm-post-state.ts and ./revm-fees.ts: the same signed transactions, the same
 * gas readings, the same `@ethereumjs/vm` reference node built inside it. What
 * changes here is which EVM charged and warmed the list.
 *
 * A FACTORY, NOT AN ENGINE, for the same reason as ./revm-fees.ts: an engine
 * instance binds to exactly one node and the battery builds two. The wasm is
 * compiled ONCE and every engine is instantiated from that same
 * `WebAssembly.Module`.
 *
 * WHICH STATE MODE: `'none'`, the only one this engine serves. That refusal is
 * asserted where the mode split is decided (`revm-conformance.spec.ts`), not
 * restated here.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runAccessListChecks} from './access-list.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-fees.ts: the build puts the
// `.wasm` bytes IN the bundle, so the page fetches nothing.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmAccessList() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runAccessListChecks({makeEngine: () => createRevmEngine({wasm})});
}
