/**
 * revm-misused-engine-worker.ts: the SAME mistake as ./misused-engine-worker.ts
 * in the shape a revm consumer actually makes it: `createEngine` is handed the
 * PROMISE `createRevmEngine()` returned, because the parentheses are already
 * there and dropping the arrow reads harmless.
 *
 * THE PROMISE FORM, NOT THE `await` FORM, and that is a measured constraint
 * rather than a preference. `createEngine: await createRevmEngine({wasm})` puts a
 * top-level `await` in the worker module, and a worker module that awaits
 * anything slower than a microtask before `exposeNode()` LOSES the main thread's
 * first message, so `createWorkerNode()` hangs no matter what the refusal says
 * (measured on Chromium and WebKit:
 * `work/notes/observations/a-top-level-await-in-a-worker-module-loses-the-first-message.md`).
 * Nothing in `worker-host` can fix that (there is no listener to register before
 * the consumer's module gets that far), so this module exercises the half that IS
 * fixable, and the hazard is documented on `exposeNode` and in the README instead.
 *
 * ./revm-worker.ts (the recipe that is right) is safe from the same hazard for a
 * reason worth naming: `() => createRevmEngine({wasm})` is SYNCHRONOUS at module
 * scope precisely because the factory defers the await into `createNode()`.
 *
 * Imported by PACKAGE NAME like its correct sibling, so this exercises the
 * published export map too.
 */
import {exposeNode} from 'embedded-eth-node/worker-host';
import {createRevmEngine} from 'embedded-eth-node/revm';
import revmWasm from 'revm-wasm/revm.wasm';

export const misusedRevmApi = exposeNode({
	// THE MISTAKE: the engine is being BUILT here (a promise of one), where a
	// function that builds one per node belongs. No `await`, deliberately: see
	// above.
	createEngine: createRevmEngine({wasm: revmWasm}) as never,
});
