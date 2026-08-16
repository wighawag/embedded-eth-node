/**
 * revm-sender-recovery.ts — the sender-recovery differential (./sender-recovery.ts)
 * driven with the `webevm/revm` engine installed.
 *
 * Engine-parameterised like every other shared battery here (the precedent
 * ./revm-conformance.ts set), but with one difference worth naming: this suite
 * needs BOTH implementations in the SAME run, so it builds a node WITHOUT the
 * engine as well and diffs the two. The factory below therefore supplies the
 * engine half only.
 *
 * ONE COMPILATION for every engine instance the suite builds: an engine binds to
 * exactly one node, and this suite builds several, so the factory hands each a
 * fresh engine over ONE compiled `WebAssembly.Module`.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runSenderRecoveryChecks} from './sender-recovery.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-conformance.ts: the build
// puts the `.wasm` bytes IN the bundle, so the page fetches nothing.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmSenderRecovery() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runSenderRecoveryChecks({
		makeEngine: () => createRevmEngine({wasm}),
	});
}
