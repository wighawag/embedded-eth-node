/**
 * revm-trusted-sender.ts — the trusted-sender suite (./trusted-sender.ts) driven
 * with the `webevm/revm` engine installed.
 *
 * The suite is the SAME one `trusted-sender.spec.ts` runs, parameterised by engine
 * rather than copied — the precedent set by ./revm-conformance.ts for the
 * conformance battery. What changes here is WHICH EVM executes the transactions,
 * and for `senderMode:'trusted'` that is exactly what needs proving: the claimed
 * sender is a value the seam carries (`TransactionRequest.sender`), so an engine
 * must execute on behalf of it rather than recovering a sender from the signature.
 * The suite's claimed-sender section is the assertion that can tell the difference,
 * because it signs with one account and claims another.
 *
 * WHICH STATE MODE: the only one this engine serves. It refuses `stateMode:'trie'`
 * at construction (ADR 0005), and the suite runs in the default `'none'` — the same
 * split ./revm-conformance.ts records, and it is re-asserted there rather than a
 * second time here.
 *
 * ONE ENGINE PER NODE, one COMPILATION for all of them: the suite builds two nodes
 * (a `'recover'` one and a `'trusted'` one) and an engine instance binds to exactly
 * one node, so a factory hands each a fresh engine over ONE compiled
 * `WebAssembly.Module`.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runTrustedSenderChecks} from './trusted-sender.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-conformance.ts: the build puts
// the `.wasm` bytes IN the bundle, so the page fetches nothing.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmTrustedSender() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runTrustedSenderChecks({makeEngine: () => createRevmEngine({wasm})});
}
