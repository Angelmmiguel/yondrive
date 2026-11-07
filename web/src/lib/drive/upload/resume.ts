/**
 * What survives a reload of an upload: where it was going and the digest of each
 * frame sent. The server lists which frames arrived but not their digests, and
 * the content hash needs them all, so a digest is written here before its frame
 * goes out. No names and no keys: the node has the name, sealed, and the key comes
 * back with the tree after an unlock.
 */
export interface ResumeRecord {
	uploadId: string;
	userId: string;
	nodeId: string;
	versionId: string;
	size: number;
	lastModified: number;
	frameSize: number;
	/** The version the upload started from, as sent at commit: '' for none yet. */
	expected: string;
	/** The generation of the node's key its frames are sealed under. */
	keyGeneration?: number;
}

export interface ResumeStore {
	list(userId: string): Promise<ResumeRecord[]>;
	put(record: ResumeRecord): Promise<void>;
	/** Digests, in padded base64, by frame index. */
	digests(uploadId: string): Promise<Map<number, string>>;
	putDigest(uploadId: string, index: number, digest: string): Promise<void>;
	remove(uploadId: string): Promise<void>;
}

/** Forgets on reload, for tests and for a browser with no IndexedDB. */
export function memoryResumeStore(): ResumeStore {
	const records = new Map<string, ResumeRecord>();
	const digests = new Map<string, Map<number, string>>();
	return {
		list: async (userId) => [...records.values()].filter((r) => r.userId === userId),
		put: async (record) => {
			records.set(record.uploadId, record);
		},
		digests: async (uploadId) => new Map(digests.get(uploadId)),
		putDigest: async (uploadId, index, digest) => {
			const known = digests.get(uploadId) ?? new Map<number, string>();
			known.set(index, digest);
			digests.set(uploadId, known);
		},
		remove: async (uploadId) => {
			records.delete(uploadId);
			digests.delete(uploadId);
		}
	};
}

const DB = 'yondrive-uploads';
const UPLOADS = 'uploads';
const DIGESTS = 'digests';

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/** In IndexedDB, since a very large file has more digests than localStorage has room for. */
export function indexedDbResumeStore(): ResumeStore {
	let opening: Promise<IDBDatabase> | null = null;
	const open = (): Promise<IDBDatabase> => {
		opening ??= new Promise((resolve, reject) => {
			const req = indexedDB.open(DB, 1);
			req.onupgradeneeded = () => {
				req.result.createObjectStore(UPLOADS, { keyPath: 'uploadId' });
				req.result.createObjectStore(DIGESTS);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		return opening;
	};
	const keysOf = (uploadId: string) => IDBKeyRange.bound([uploadId, 0], [uploadId, Infinity]);

	return {
		async list(userId) {
			const db = await open();
			const all = await request<ResumeRecord[]>(
				db.transaction(UPLOADS).objectStore(UPLOADS).getAll()
			);
			return all.filter((record) => record.userId === userId);
		},
		async put(record) {
			const db = await open();
			await request(db.transaction(UPLOADS, 'readwrite').objectStore(UPLOADS).put(record));
		},
		async digests(uploadId) {
			const db = await open();
			const store = db.transaction(DIGESTS).objectStore(DIGESTS);
			const [keys, values] = await Promise.all([
				request(store.getAllKeys(keysOf(uploadId))),
				request<string[]>(store.getAll(keysOf(uploadId)))
			]);
			return new Map(keys.map((key, i) => [(key as [string, number])[1], values[i]]));
		},
		async putDigest(uploadId, index, digest) {
			const db = await open();
			await request(
				db.transaction(DIGESTS, 'readwrite').objectStore(DIGESTS).put(digest, [uploadId, index])
			);
		},
		async remove(uploadId) {
			const db = await open();
			const tx = db.transaction([UPLOADS, DIGESTS], 'readwrite');
			tx.objectStore(UPLOADS).delete(uploadId);
			await request(tx.objectStore(DIGESTS).delete(keysOf(uploadId)));
		}
	};
}

/** The best store this browser offers. */
export function defaultResumeStore(): ResumeStore {
	if (typeof indexedDB === 'undefined') return memoryResumeStore();
	const durable = indexedDbResumeStore();
	const memory = memoryResumeStore();
	// A private window can refuse IndexedDB at any step: such a tab simply cannot resume.
	const either =
		<A extends unknown[], R>(pick: (store: ResumeStore) => (...args: A) => Promise<R>) =>
		(...args: A) =>
			pick(durable)(...args).catch(() => pick(memory)(...args));
	return {
		list: either((s) => s.list),
		put: either((s) => s.put),
		digests: either((s) => s.digests),
		putDigest: either((s) => s.putDigest),
		remove: either((s) => s.remove)
	};
}
