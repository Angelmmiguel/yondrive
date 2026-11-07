/**
 * Stored segments on this device, as the server has them: sealed, under their ids, so
 * that an unlock need not fetch them again. A segment never changes, so there is
 * nothing to keep fresh, only what the server no longer lists to drop.
 */
export interface SegmentCache {
	get(id: string): Promise<Uint8Array<ArrayBuffer> | null>;
	put(id: string, bytes: Uint8Array): Promise<void>;
	delete(id: string): Promise<void>;
	ids(): Promise<string[]>;
	/** Forgets everything of this user on this device. */
	clear(): Promise<void>;
}

export function memorySegmentCache(): SegmentCache & { items: Map<string, Uint8Array> } {
	const items = new Map<string, Uint8Array>();
	return {
		items,
		get: async (id) => (items.get(id)?.slice() as Uint8Array<ArrayBuffer> | undefined) ?? null,
		put: async (id, bytes) => void items.set(id, bytes.slice()),
		delete: async (id) => void items.delete(id),
		ids: async () => [...items.keys()],
		clear: async () => items.clear()
	};
}

const STORE = 'segments';

const asPromise = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

/**
 * Keeps segments in IndexedDB, in a database per user. Without it, works from the server each time.
 * `prefix` names another database for another index of the user's, as Notes keeps.
 */
export function indexedDbSegmentCache(userId: string, prefix = 'yondrive-search'): SegmentCache {
	const name = `${prefix}-${userId}`;
	let opening: Promise<IDBDatabase> | null = null;

	const open = (): Promise<IDBDatabase> => {
		opening ??= new Promise((resolve, reject) => {
			const request = indexedDB.open(name, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(STORE);
			request.onsuccess = () => {
				const db = request.result;
				// A sign-out from another screen deletes the database: an open connection must not block it.
				db.onversionchange = () => {
					db.close();
					opening = null;
				};
				resolve(db);
			};
			request.onerror = () => reject(request.error);
		});
		return opening;
	};

	const inStore = async <T>(
		mode: IDBTransactionMode,
		use: (store: IDBObjectStore) => IDBRequest<T>
	): Promise<T> => {
		const db = await open();
		return asPromise(use(db.transaction(STORE, mode).objectStore(STORE)));
	};

	return {
		async get(id) {
			try {
				const found = await inStore<Uint8Array<ArrayBuffer> | undefined>('readonly', (store) =>
					store.get(id)
				);
				return found ?? null;
			} catch {
				return null;
			}
		},
		async put(id, bytes) {
			await inStore('readwrite', (store) => store.put(bytes, id)).catch(() => {});
		},
		async delete(id) {
			await inStore('readwrite', (store) => store.delete(id)).catch(() => {});
		},
		async ids() {
			try {
				return (await inStore('readonly', (store) => store.getAllKeys())) as string[];
			} catch {
				return [];
			}
		},
		async clear() {
			try {
				(await open()).close();
			} catch {
				// Never opened.
			}
			opening = null;
			await asPromise(indexedDB.deleteDatabase(name) as unknown as IDBRequest<unknown>).catch(
				() => {}
			);
		}
	};
}
