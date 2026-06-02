/**
 * persistence.ts — IndexedDB persistence adapter for the node.
 *
 * The node's `dumpState`/`loadState` are async, so the adapter is trivially
 * async (no sync-storage shim needed over async IndexedDB): dump the live-set
 * Maps (+ block list / receipts / tx / logs index) to ONE IndexedDB record and
 * rehydrate on load. Slim, live-set-sized, no trie, no RLP state-root.
 *
 * bigint-safe JSON: we never put bigints in the serialized state (everything is
 * already hex strings in SerializedState), so a plain structured clone works and
 * we don't even need JSON — IndexedDB can store the object directly.
 */
import type {PersistenceAdapter, SerializedState} from './types.js';

export interface IndexedDBPersistenceOptions {
	db?: string;
	store?: string;
	key?: string;
}

export function createIndexedDBPersistence(
	opts: IndexedDBPersistenceOptions = {},
): PersistenceAdapter {
	const dbName = opts.db ?? 'embedded-eth-node';
	const storeName = opts.store ?? 'state';
	const key = opts.key ?? 'node-state';
	let dbPromise: Promise<IDBDatabase> | undefined;

	function getDb(): Promise<IDBDatabase> {
		if (!dbPromise) {
			dbPromise = new Promise((resolve, reject) => {
				const req = indexedDB.open(dbName, 1);
				req.onupgradeneeded = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains(storeName))
						db.createObjectStore(storeName);
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
		}
		return dbPromise;
	}

	return {
		async load(): Promise<SerializedState | null> {
			const db = await getDb();
			return new Promise((resolve, reject) => {
				const tx = db.transaction(storeName, 'readonly');
				const req = tx.objectStore(storeName).get(key);
				req.onsuccess = () => resolve((req.result as SerializedState) ?? null);
				req.onerror = () => reject(req.error);
			});
		},
		async save(state: SerializedState): Promise<void> {
			const db = await getDb();
			return new Promise((resolve, reject) => {
				const tx = db.transaction(storeName, 'readwrite');
				tx.objectStore(storeName).put(state, key);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		},
	};
}

/** An in-memory adapter (handy for tests / SSR / proving the round-trip). */
export function createMemoryPersistence(
	initial?: SerializedState | null,
): PersistenceAdapter {
	let stored: SerializedState | null = initial ?? null;
	return {
		async load() {
			return stored;
		},
		async save(state) {
			stored = state;
		},
	};
}
