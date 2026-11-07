/**
 * The index with its key: what the worker runs, and what runs in place where there
 * are no workers. It holds the plaintext of the index and a key good for segments
 * only. Ending it, which a lock does by ending the worker, ends both.
 */
import { zero } from '$lib/crypto/random';
import { sealerFor, type Suite } from '$lib/crypto/sealer';
import { SearchIndex, type SegmentWrite } from './index';
import { decodeSegment, encodeSegment, type SegmentBody } from './segment';
import type { IndexDoc, SearchQuery, SearchResults } from './types';

export interface SealedSegment {
	id: string;
	bytes: Uint8Array<ArrayBuffer>;
}

export interface EngineWrite {
	add: SealedSegment[];
	remove: string[];
	token: number;
}

/** What the rest of the app asks of the index, wherever it runs. */
export interface IndexClient {
	/** Takes stored segments in; answers those that do not open, to make again. */
	load(segments: SealedSegment[]): Promise<{ bad: string[] }>;
	beginReconcile(): Promise<void>;
	reconcile(docs: IndexDoc[]): Promise<{ stale: string[] }>;
	endReconcile(): Promise<{ removed: number; size: number }>;
	upsert(docs: IndexDoc[]): Promise<void>;
	setText(id: string, version: string | null, text: string): Promise<boolean>;
	search(query: SearchQuery): Promise<SearchResults>;
	flush(): Promise<EngineWrite | null>;
	compact(limit?: number): Promise<EngineWrite | null>;
	stored(token: number, sizes: Record<string, number>): Promise<void>;
	abort(token: number): Promise<void>;
	/** Ends it, with what it holds. */
	stop(): void;
}

/** The index's methods in one object, sealed on the way out and opened on the way in. */
export function createEngine(
	suite: Suite,
	key: Uint8Array
): Omit<IndexClient, 'stop'> & {
	stop(): void;
	index: SearchIndex;
} {
	const sealer = sealerFor(suite);
	const index = new SearchIndex();
	let marks: Set<string> | null = null;

	const seal = (write: SegmentWrite | null): EngineWrite | null => {
		if (write === null) return null;
		return {
			add: write.add.map(({ id, body }) => ({
				id,
				bytes: sealer.sealIndexSegmentWith(key, id, encodeSegment(body)) as Uint8Array<ArrayBuffer>
			})),
			remove: write.remove,
			token: write.token
		};
	};

	return {
		index,
		async load(segments) {
			const bad: string[] = [];
			const opened: { id: string; body: SegmentBody; size: number }[] = [];
			for (const { id, bytes } of segments) {
				try {
					const body = decodeSegment(sealer.openIndexSegmentWith(key, id, bytes));
					opened.push({ id, body, size: bytes.length });
				} catch {
					bad.push(id);
				}
			}
			opened.sort((a, b) => a.body.seq - b.body.seq || (a.id < b.id ? -1 : 1));
			for (const { id, body, size } of opened) index.load(id, body, size);
			return { bad };
		},
		async beginReconcile() {
			marks = new Set();
		},
		async reconcile(docs) {
			const stale: string[] = [];
			for (const doc of docs) {
				marks?.add(doc.id);
				index.upsert(doc);
				if (index.staleText(doc.id)) stale.push(doc.id);
			}
			return { stale };
		},
		async endReconcile() {
			let removed = 0;
			if (marks !== null) {
				for (const id of index.ids()) {
					if (!marks.has(id) && index.remove(id)) removed++;
				}
			}
			marks = null;
			return { removed, size: index.size };
		},
		async upsert(docs) {
			for (const doc of docs) {
				marks?.add(doc.id);
				index.upsert(doc);
			}
		},
		setText: async (id, version, text) => index.setText(id, version, text),
		search: async (query) => index.search(query),
		flush: async () => seal(index.flush()),
		compact: async (limit) => seal(index.compact(limit)),
		stored: async (token, sizes) => index.stored(token, sizes),
		abort: async (token) => index.abort(token),
		stop() {
			zero(key);
		}
	};
}
