/**
 * worker-client.ts — the OPTIONAL main-thread side. Wraps a Worker (running
 * ./worker-entry.ts) over comlink and returns the SAME `{ request, mine,
 * dumpState, loadState, ... }` shape as `createNode()`. So `createNode()` (main
 * thread) and `createWorkerNode()` (Worker) are interchangeable one-liners and
 * the consumer never hand-rolls the comlink plumbing.
 */
import {wrap, proxy} from 'comlink';
import type {WorkerApi} from './worker-entry.js';
import type {
	NodeOptions,
	EngineInfo,
	SenderMode,
	SlimNode,
	RequestArguments,
	SerializedState,
} from './types.js';

export interface WorkerNodeOptions extends NodeOptions {
	/**
	 * A Worker already pointing at this package's worker-entry (or a re-export of
	 * it). Consumers create it themselves so the bundler controls chunking:
	 *   new Worker(new URL('embedded-eth-node/worker-entry', import.meta.url),
	 *              {type: 'module'})
	 */
	worker: Worker;
	/**
	 * NOT AVAILABLE ON THIS PATH, and typed `never` so it is a compile error
	 * rather than a runtime surprise (it is also refused at runtime, for JS
	 * consumers). See the refusal in {@link createWorkerNode} for why, and for the
	 * supported way to run a non-default engine inside a Worker.
	 */
	engine?: never;
}

export async function createWorkerNode(
	opts: WorkerNodeOptions,
): Promise<SlimNode> {
	const {worker, ...nodeOptions} = opts;
	// AN ENGINE CANNOT CROSS THIS BOUNDARY, and says so. `WorkerNodeOptions`
	// extends `NodeOptions`, so `engine` is structurally in scope here, but these
	// options are STRUCTURED-CLONED into the Worker and an `Engine` is a
	// function-bearing object: comlink would throw an opaque `DataCloneError` from
	// deep inside its own postMessage, which is exactly the plausible-looking
	// failure this package's honest-edge convention exists to prevent. Cloning
	// could not work in principle either — an engine holds live state (a wasm
	// instance, a binding to the node's state manager) that belongs to the thread
	// that built it.
	//
	// The supported shape is to build the engine INSIDE the worker, in your own
	// worker module, and expose the node from there:
	//
	//   // my-worker.ts
	//   import {expose, proxy} from 'comlink';
	//   import {createNode} from 'embedded-eth-node';
	//   import {createRevmEngine} from 'embedded-eth-node/revm';
	//   const node = await createNode({engine: await createRevmEngine({wasm})});
	//   expose({request: (a: any) => node.request(a), /* ... */});
	//
	// This package's own `worker-entry` deliberately does not do that for you: it
	// would mean the core naming engines by string and importing them, which is
	// precisely what ADR 0006 refuses (a JS-only consumer would pay for revm).
	if ((nodeOptions as NodeOptions).engine !== undefined) {
		throw new Error(
			"embedded-eth-node/worker-client: `engine` is not supported by createWorkerNode(). The node's options are structured-cloned into the Worker and an Engine is a function-bearing object, so it cannot be cloned across the thread boundary (comlink would report only a DataCloneError). " +
				'Build the engine INSIDE the Worker instead: write your own worker module that calls createNode({engine: await createRevmEngine({wasm})}) and comlink-exposes the node, then drive it with the same client code. ' +
				'Or run the engine on the main thread with createNode().',
		);
	}
	const api = wrap<WorkerApi>(worker);
	const remote = await api.createNode(nodeOptions);
	// stateMode/senderMode/engine are plain values on the node; over comlink
	// they read as promises.
	const stateMode = (await (remote as any).stateMode) as 'none' | 'trie';
	const senderMode = (await (remote as any).senderMode) as SenderMode;
	const engineInfo = (await (remote as any).engine) as EngineInfo;

	return {
		request: (args: RequestArguments) =>
			remote.request(args as any) as Promise<unknown>,
		mine: () => remote.mine() as any,
		dumpState: () => remote.dumpState() as Promise<SerializedState>,
		loadState: (s: SerializedState) => remote.loadState(s as any),
		stateMode,
		senderMode,
		engine: engineInfo,
		getStateRoot: () => (remote as any).getStateRoot() as Promise<string>,
		onNewHead(cb) {
			// The callback must cross the thread boundary as a comlink proxy.
			let unsub: (() => void) | undefined;
			void (remote.onNewHead(proxy(cb)) as Promise<() => void>).then((u) => {
				unsub = u;
			});
			return () => {
				void unsub?.();
			};
		},
		async dispose() {
			await remote.dispose();
			worker.terminate();
		},
	};
}
