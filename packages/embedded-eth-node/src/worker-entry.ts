/**
 * worker-entry.ts — the OPTIONAL Worker side. This is the ONLY file in the package
 * that imports comlink. The core (./node.ts) stays 100% transport-agnostic; this
 * entry just `expose()`s a factory that creates the node and proxies it back.
 *
 * Consumers point a `new Worker(new URL('.../worker-entry.js', import.meta.url))`
 * at this file (or re-export it from their own worker module) and pair it with
 * `createWorkerNode()` (see ./worker-client.ts) on the main thread.
 *
 * Why this split: heavy pure-JS EVM compute can hang the browser main thread.
 * Moving the node into a Worker fixes that — but it's the consumer's CHOICE. The
 * same `createNode()` runs fine on the main thread too.
 */
import {expose, proxy} from 'comlink';
import {createNode} from './node.js';
import type {NodeOptions} from './types.js';

export const workerApi = {
	async createNode(options: NodeOptions) {
		const node = await createNode(options);
		return proxy({
			request: (args: any) => node.request(args),
			mine: () => node.mine(),
			dumpState: () => node.dumpState(),
			loadState: (s: any) => node.loadState(s),
			getStateRoot: () => node.getStateRoot(),
			stateMode: node.stateMode,
			// Plain values, so they clone across the boundary as-is. EVERY plain
			// field of SlimNode belongs here: worker-client reads them off the
			// remote, so one omitted here reads as `undefined` on a typed property
			// (senderMode was missing until 2026-08-01 and nothing caught it,
			// because worker-client's read is behind an `as any`).
			senderMode: node.senderMode,
			readEngine: node.readEngine,
			// newHeads over comlink: the callback must be a comlink-proxied function.
			onNewHead: (cb: (h: {number: number; hash: string}) => void) =>
				proxy(node.onNewHead(cb)),
			dispose: () => node.dispose(),
		});
	},
};

export type WorkerApi = typeof workerApi;

// Auto-expose when loaded as a Worker module.
expose(workerApi);
