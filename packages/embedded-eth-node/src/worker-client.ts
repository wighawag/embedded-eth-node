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
}

export async function createWorkerNode(
	opts: WorkerNodeOptions,
): Promise<SlimNode> {
	const {worker, ...nodeOptions} = opts;
	const api = wrap<WorkerApi>(worker);
	const remote = await api.createNode(nodeOptions);
	// stateMode is a plain value on the node; over comlink it reads as a promise.
	const stateMode = (await (remote as any).stateMode) as 'none' | 'trie';

	return {
		request: (args: RequestArguments) =>
			remote.request(args as any) as Promise<unknown>,
		mine: () => remote.mine() as any,
		dumpState: () => remote.dumpState() as Promise<SerializedState>,
		loadState: (s: SerializedState) => remote.loadState(s as any),
		stateMode,
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
