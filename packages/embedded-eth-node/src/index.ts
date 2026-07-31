/**
 * embedded-eth-node — a slim, execution-only EIP-1193 Ethereum node
 * on @ethereumjs/vm. Transport-agnostic core: just an async `request()` +
 * mine/dumpState/loadState. Optional comlink Worker helpers are in ./worker-entry
 * (Worker side) and ./worker-client (main-thread side) so the core never imports
 * comlink.
 */
export {createNode} from './node.js';
export {
	createIndexedDBPersistence,
	createMemoryPersistence,
} from './persistence.js';
export type {
	SlimNode,
	NodeOptions,
	MiningConfig,
	StateMode,
	SenderMode,
	GenesisAccount,
	BlockEnv,
	PersistenceAdapter,
	RequestArguments,
	SerializedState,
} from './types.js';
export {RpcError} from './types.js';
// Worker helpers are intentionally NOT re-exported here to keep comlink out of
// the core bundle. Import them directly:
//   import {createWorkerNode} from 'embedded-eth-node/worker-client';
//   new Worker(new URL('embedded-eth-node/worker-entry', import.meta.url));
