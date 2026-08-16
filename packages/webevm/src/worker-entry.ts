/**
 * worker-entry.ts: the OPTIONAL Worker side, AS A WORKER ENTRY POINT. The
 * package's node api, exposed the moment this module is imported. That import-time
 * `expose()` is the whole of what this file adds, and it is what makes the common
 * case a one-liner:
 *
 *   new Worker(new URL('webevm/worker-entry', import.meta.url),
 *              {type: 'module'});
 *
 * Pair it with `createWorkerNode()` (see ./worker-client.ts) on the main thread.
 *
 * THE NODE API ITSELF LIVES IN ./worker-host.ts, with no side effect, because a
 * side effect cannot be imported: a consumer whose worker must build something
 * first (an ENGINE, which cannot cross the boundary) used to hand-copy the
 * `SlimNode` proxy, since importing THIS module would have exposed the default api
 * on their thread. They call `exposeNode()` from `webevm/worker-host`
 * instead, and the proxy exists in exactly one place.
 *
 * Why the split exists at all: heavy pure-JS EVM compute can hang the browser main
 * thread. Moving the node into a Worker fixes that, but it's the consumer's
 * CHOICE. The same `createNode()` runs fine on the main thread too.
 */
import {exposeNode, type NodeWorkerApi} from './worker-host.js';

/**
 * The exposed api. Kept exported (and exposed at import time) because consumers
 * import this module for exactly that: nothing here changed when the proxy moved.
 */
export const workerApi = exposeNode();

export type WorkerApi = NodeWorkerApi;
