/**
 * revm-post-state.ts — the post-state differential (./post-state.ts) with the
 * `webevm/revm` engine as the engine UNDER TEST.
 *
 * The battery itself is engine-parameterised, the precedent set by
 * ./revm-conformance.ts and ./revm-trusted-sender.ts: the same signed
 * transactions, the same public-surface readings, the same `@ethereumjs/vm`
 * reference node built inside it. What changes here is which EVM executed and
 * COMMITTED them.
 *
 * WHICH STATE MODE: `'none'`, the only one this engine serves (it refuses
 * `'trie'` at construction — ADR 0005). That refusal is asserted in
 * `revm-conformance.spec.ts`, where the mode split is decided; it is not restated
 * here.
 *
 * ONE ENGINE PER NODE: the battery builds a reference node on the default engine
 * and ONE node on this engine, so a single `createRevmEngine()` is enough — but
 * it still comes through a factory, because an engine instance binds to exactly
 * one node and the battery is the thing that decides how many it needs.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runPostStateChecks} from './post-state.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-conformance.ts: the build puts
// the `.wasm` bytes IN the bundle, so the page fetches nothing.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmPostState() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runPostStateChecks({makeEngine: () => createRevmEngine({wasm})});
}
