/**
 * worker-host.ts: THE WORKER SIDE OF THE NODE, minus the side effect: the ONE
 * `SlimNode` proxy that crosses a comlink boundary, and the two ways to put it on
 * a thread. `./worker-entry.ts` is this module plus an import-time `expose()`;
 * a consumer whose Worker must build something first (an ENGINE) calls
 * {@link exposeNode} from their own worker module instead.
 *
 * WHY IT IS A SEPARATE MODULE. `worker-entry` calls `expose()` at MODULE SCOPE,
 * which is what makes `new Worker(new URL('embedded-eth-node/worker-entry', ...))`
 * a one-liner, and also what makes it unusable as a library: importing it to
 * reuse the proxy would expose the DEFAULT api on the importing thread, so
 * consumers hand-copied the proxy block instead. There were three copies of it
 * (this package's, this repo's example, and every consumer's), each able to drop a
 * field independently. That is not hypothetical: `senderMode` was missing from
 * one of them for a month, reading as `undefined` on a property typed
 * `'recover' | 'trusted'`. Now there is one copy, here.
 *
 * AND IT IS THE COMPILER THAT KEEPS IT COMPLETE. {@link nodeProxy}'s literal is
 * typed `SlimNode`, so a field ADDED to `SlimNode` later fails to build here
 * rather than reading as `undefined` on the far side of a thread boundary; the
 * client (`./worker-client.ts`) reads those fields off the remote with no `as any`
 * in the way, so the type is load-bearing on both ends. That covers a future field
 * structurally, which is the property enumerating today's fields cannot have.
 *
 * WHAT THIS MODULE DOES NOT DO: name an engine. The core imports no engine and
 * resolves no engine name (`docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md`),
 * so an engine reaches a node here exactly as it does on the main thread, as an
 * object the CONSUMER built, on the thread that will use it. This module never
 * mentions `embedded-eth-node/revm`, and a JS-only consumer's bundle is unmoved by
 * its existence.
 */
import {expose, proxy} from 'comlink';
import {createNode} from './node.js';
import type {Engine, NodeOptions, SlimNode} from './types.js';

/**
 * Builds the {@link Engine} for ONE node, on the thread that will run it.
 *
 * A FUNCTION, not a built engine, for two reasons that are both structural.
 * Building an engine is ASYNC (`createRevmEngine()` compiles wasm), and this way
 * the await belongs to `createNode()`'s own await instead of to the consumer's
 * module top level. And one engine instance serves ONE node (`connect()` binds it
 * to that node's state manager, and handing a connected engine to a second
 * `createNode()` throws), so an engine VALUE here would work once and then fail
 * the second time this worker was asked for a node.
 */
export type EngineSupplier = () => Engine | Promise<Engine>;

/** What the WORKER thread decides. Everything else is the main thread's. */
export interface WorkerHostOptions {
	/**
	 * Build this node's engine on THIS thread. Omit it for the default
	 * `@ethereumjs/evm` engine (what `worker-entry` does).
	 *
	 * Called ONCE PER `createNode()`, so each node gets its own engine instance:
	 *
	 *   exposeNode({createEngine: () => createRevmEngine({wasm})});
	 *
	 * `createEngine`, not `engine`, deliberately: `NodeOptions.engine` is an
	 * `Engine` everywhere else in this package, and one name meaning "an engine"
	 * in one place and "a function that makes one" in another is how the wrong
	 * value gets passed. The main thread's options are untouched by this: they
	 * still travel through `createWorkerNode()` as they always did, and an engine
	 * still cannot come from there (see `./worker-client.ts`'s refusal).
	 */
	createEngine?: EngineSupplier;
}

/**
 * THE ONE `SlimNode` PROXY. Comlink cannot pass the node itself (its methods are
 * functions and its subscription hands back another one), so this is the node's
 * public surface rendered for the boundary.
 *
 * TYPED `SlimNode` ON PURPOSE, and that annotation is the mechanism rather than
 * documentation: every member of `SlimNode` must be here or this does not
 * compile, today and for every field added later. The plain values
 * (`stateMode`, `senderMode`, `engine`) clone across as-is; the client reads them
 * off the remote as promises.
 */
function nodeProxy(node: SlimNode): SlimNode {
	const forwarded: SlimNode = {
		request: (args) => node.request(args),
		mine: () => node.mine(),
		dumpState: () => node.dumpState(),
		loadState: (state) => node.loadState(state),
		getStateRoot: () => node.getStateRoot(),
		stateMode: node.stateMode,
		senderMode: node.senderMode,
		engine: node.engine,
		// newHeads over comlink: the callback arrives as a comlink proxy, and the
		// unsubscribe going back must be marked as one too, or it clones as `{}`.
		onNewHead: (cb) => proxy(node.onNewHead(cb)),
		dispose: () => node.dispose(),
	};
	return forwarded;
}

/**
 * The comlink API a Worker exposes: `createNode(options)` with the SAME options
 * `createNode()` takes on the main thread, returning the node as a proxy.
 *
 * Use {@link exposeNode} unless you are composing this into a larger exposed API
 * of your own; this is the same object `worker-entry` exposes.
 */
export function createNodeWorkerApi(hostOptions: WorkerHostOptions = {}) {
	const {createEngine} = hostOptions;
	// An honest edge rather than a `TypeError` from inside `createNode`: passing
	// the ENGINE where its FACTORY belongs is the one plausible mistake here, and a
	// consumer who makes it has an engine in hand and needs to know that this
	// thread builds one per node.
	if (createEngine !== undefined && typeof createEngine !== 'function') {
		throw new Error(
			'embedded-eth-node/worker-host: `createEngine` must be a FUNCTION that builds an engine on this thread, not an engine. ' +
				'It is called once per createNode() because one engine instance serves one node (connect() binds it to the state of the node it is given to). ' +
				'Pass `{createEngine: () => createRevmEngine({wasm})}` rather than `{createEngine: await createRevmEngine({wasm})}`.',
		);
	}
	return {
		async createNode(options: NodeOptions) {
			// The main thread's options pass through UNCHANGED; the engine, and only
			// the engine, is this thread's.
			const node = await createNode(
				createEngine ? {...options, engine: await createEngine()} : options,
			);
			return proxy(nodeProxy(node));
		},
	};
}

/** The api {@link exposeNode} exposes, i.e. what a client should `wrap<>()`. */
export type NodeWorkerApi = ReturnType<typeof createNodeWorkerApi>;

/**
 * Expose a node factory on THIS thread. This is the whole of a consumer's worker module:
 *
 *   // my-worker.ts
 *   import {exposeNode} from 'embedded-eth-node/worker-host';
 *   import {createRevmEngine} from 'embedded-eth-node/revm';
 *   import wasm from 'revm-wasm/revm.wasm';
 *
 *   exposeNode({createEngine: () => createRevmEngine({wasm})});
 *
 * The main thread then drives it with the ordinary client, unchanged:
 * `createWorkerNode({worker, chainId, ...})`. Call it ONCE per thread: comlink's
 * `expose()` adds a message listener, so two of them answer the same message
 * twice.
 *
 * Returns the exposed api, so `export const myApi = exposeNode(...)` is one line.
 */
export function exposeNode(hostOptions: WorkerHostOptions = {}): NodeWorkerApi {
	const api = createNodeWorkerApi(hostOptions);
	expose(api);
	return api;
}
