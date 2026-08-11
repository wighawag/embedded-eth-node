/**
 * misused-engine-worker.ts: A WORKER MODULE THAT GETS IT WRONG, on purpose. It
 * hands `exposeNode()` an ENGINE-shaped object where the FACTORY belongs. It is
 * the one plausible mistake at this seam for a consumer holding an engine, and
 * the counterpart of ./revm-worker.ts, which gets it right.
 *
 * This module must still be a WORKING worker as far as the boundary is concerned:
 * the whole point of the refusal being a VALUE rather than a throw is that
 * `exposeNode()` still registers comlink's message listener, so the main thread's
 * `createNode()` call is ANSWERED, with a rejection carrying the reason. A
 * module that threw here would answer nothing at all, which is the hang this
 * exists to keep fixed.
 *
 * Written in TypeScript with the cast a JS consumer does not need: the type
 * already refuses this, so the mistake being reachable at all is a JS consumer's,
 * which is exactly who the runtime message is for.
 */
import {exposeNode} from '../../src/worker-host.js';
import type {Engine} from '../../src/types.js';

/**
 * An engine-shaped VALUE. It never runs: what it is made of does not matter, only
 * that it is not a function.
 */
const alreadyBuiltEngine = {
	id: 'pretend-engine',
	call: async () => ({returnData: '0x', executionGasUsed: 0n, failed: false}),
	transact: async () => {
		throw new Error('never reached');
	},
} as unknown as Engine;

export const misusedApi = exposeNode({
	// THE MISTAKE: `createEngine` takes a function that BUILDS one, because one
	// engine instance serves one node.
	createEngine: alreadyBuiltEngine as never,
});
