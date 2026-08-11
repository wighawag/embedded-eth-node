/**
 * revm-storage-keys.ts — the storage-key agreement battery (./storage-keys.ts)
 * with the `embedded-eth-node/revm` engine as the engine UNDER TEST.
 *
 * This is the battery the packed key encoding is answerable to, and revm is the
 * only engine that can fail it: the DEFAULT engine reaches storage through the
 * async `putStorage` / `getStorage` in both directions, so it agrees with itself
 * whatever the key format is. The synchronous store (`src/revm-state-store.ts`)
 * is the second reader of the same representation, and a second reader is what
 * makes two key formats possible at all.
 *
 * A FACTORY, NOT AN ENGINE, for the reason ./revm-fees.ts gives: an engine
 * instance binds to exactly one node and this battery builds two (the node under
 * test, and a fresh one to `loadState` into). The wasm is compiled ONCE and every
 * engine is instantiated from that same `WebAssembly.Module`.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runStorageKeyChecks} from './storage-keys.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-post-state.ts.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmStorageKeys() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runStorageKeyChecks({makeEngine: () => createRevmEngine({wasm})});
}
