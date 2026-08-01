/**
 * revm-conformance.ts — the differential conformance battery (./conformance.ts)
 * driven with the `embedded-eth-node/revm` engine installed.
 *
 * This is the strongest correctness bar in the repo pointed at the engine a
 * consumer actually ships: the same signed transactions, the same trie-backed
 * `@ethereumjs/vm` `runTx` reference, the same field-by-field diff — with revm
 * answering `eth_call` and `eth_estimateGas`.
 *
 * WHICH MODES, and why it is not a choice. The engine serves `stateMode:'none'`
 * and REFUSES `'trie'` at construction (`MerkleStateManager` has no synchronous
 * view for revm to read through — ADR 0005), so the battery runs in `'none'` here
 * and `'trie'` keeps its existing default-engine coverage in `conformance.spec.ts`.
 * The refusal is recorded by `runConformanceOnEngine` rather than assumed, so the
 * split stays honest if the engine's shape ever changes.
 *
 * ONE ENGINE PER NODE, one COMPILATION for all of them. The battery builds two
 * nodes and the refusal probe builds another, and an engine instance binds to
 * exactly one node (a second `createNode()` is refused). So a factory hands each
 * node a fresh engine, all sharing ONE compiled `WebAssembly.Module` — which is
 * precisely what `createRevmEngine`'s `wasm` option accepting a compiled module
 * is for.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runConformanceOnEngine} from './conformance.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-engine.ts: the build puts
// the `.wasm` bytes IN the bundle, so the page fetches nothing.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmConformance() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runConformanceOnEngine({
		makeEngine: () => createRevmEngine({wasm}),
		serves: 'none',
		refuses: ['trie'],
	});
}
