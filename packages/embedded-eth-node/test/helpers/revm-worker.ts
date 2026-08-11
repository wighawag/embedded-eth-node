/**
 * revm-worker.ts: THE CONSUMER'S OWN WORKER MODULE, and the file the README
 * points a reader at. It is test-suite code only in that it lives here and is
 * executed on every run; nothing in it is test-shaped, and it is meant to be
 * copied verbatim into an application.
 *
 * WHY A CONSUMER WRITES THIS FILE AT ALL. `createWorkerNode({engine})` is
 * refused: the node's options are structured-cloned into the Worker and an
 * `Engine` is a function-bearing object holding thread-bound live state (a wasm
 * instance, a binding to that thread's state manager), so cloning one could not
 * work even in principle. And the package's own `embedded-eth-node/worker-entry`
 * deliberately does NOT build engines for you. That would mean the core naming
 * engines by string and importing them, which
 * `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md` refuses,
 * and a JS-only consumer would then pay for revm they never asked for. So the
 * engine is built HERE, on the thread that will use it, by the code that wants
 * it.
 *
 * WHAT THE MAIN THREAD DOES WITH IT: nothing special. This module exposes the
 * same `{createNode(options)}` API `worker-entry` does, so the ordinary client
 * drives it unchanged and the consumer never hand-rolls comlink on their side:
 *
 *   const worker = new Worker(new URL('./revm-worker.ts', import.meta.url),
 *                             {type: 'module'});
 *   const node = await createWorkerNode({worker, chainId: 31337, ...});
 *   node.engine.id;  // 'revm-wasm'
 *
 * IMPORTED BY PACKAGE NAME (`embedded-eth-node`, `embedded-eth-node/revm`) and
 * not by relative `src/` path, unlike every other helper here, because a
 * consumer resolves them that way: this module therefore also exercises the
 * published export map, as `packages/benchmarks` already does.
 *
 * THE WASM, delivered as a BUNDLER-RESOLVED asset: the build resolves it out of
 * the `revm-wasm` package and puts the bytes IN the worker bundle, so the Worker
 * fetches nothing and no path is hard-coded (esbuild's `binary` loader here;
 * Vite's `?arraybuffer`, webpack's `asset/inline`). The runtime-fetched-URL shape
 * works here too (pass `{wasm: new URL(...)}`) and is what a consumer who does
 * not want 1.17 MB inside their worker chunk reaches for; `revm-engine.spec.ts`
 * covers both shapes on the main thread, and this module deliberately covers the
 * one that has to survive being bundled a SECOND time, as a Worker entry point.
 *
 * `stateMode` is left to the caller and revm serves `'none'` only (the default),
 * refusing anything else at `createNode()`. That constraint crosses the thread
 * boundary unchanged: the refusal simply happens in here, and comlink reports it
 * to the caller of `createWorkerNode()`.
 */
import {expose, proxy} from 'comlink';
import {createNode, type NodeOptions} from 'embedded-eth-node';
import {createRevmEngine} from 'embedded-eth-node/revm';
import revmWasm from 'revm-wasm/revm.wasm';

export const revmWorkerApi = {
	async createNode(options: NodeOptions) {
		const node = await createNode({
			...options,
			// The whole point: the engine is CONSTRUCTED on this thread, so nothing
			// about it ever has to cross the boundary.
			engine: await createRevmEngine({wasm: revmWasm}),
		});
		return proxy({
			request: (args: any) => node.request(args),
			mine: () => node.mine(),
			dumpState: () => node.dumpState(),
			loadState: (s: any) => node.loadState(s),
			getStateRoot: () => node.getStateRoot(),
			// Plain values clone across the boundary as-is. EVERY plain field of
			// `SlimNode` belongs here, because the client reads them off the remote
			// and one omitted reads as `undefined` on a typed property. `engine` is
			// the one that makes this recipe checkable from the main thread: it is
			// how a caller (or a bug report) says which EVM answered.
			stateMode: node.stateMode,
			senderMode: node.senderMode,
			engine: node.engine,
			// newHeads over comlink: the callback must be a comlink-proxied function.
			onNewHead: (cb: (h: {number: number; hash: string}) => void) =>
				proxy(node.onNewHead(cb)),
			dispose: () => node.dispose(),
		});
	},
};

expose(revmWorkerApi);
