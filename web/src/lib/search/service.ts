/**
 * Search of one unlocked session: brings stored segments into the index, keeps the
 * index equal to the tree, reads the text it is missing and stores what changed. All of
 * it happens behind the screen, and a failure only leaves results a little behind:
 * the next reconcile puts it right. No query ever leaves here.
 */
import type { Api } from '$lib/api/client';
import { ApiError, isApiError } from '$lib/api/types';
import type { Sealer } from '$lib/crypto/sealer';
import { Limiter } from '$lib/drive/retry';
import { digestHeader } from '$lib/drive/upload/engine';
import type { SegmentCache } from './cache';
import type { EngineWrite, IndexClient, SealedSegment } from './engine';
import { extractorFor, extractText, type FileFacts } from './extract';
import type { IndexDoc, SearchQuery, SearchResults } from './types';

const SNAPSHOT_BATCH = 2000;
const TEXTS_AT_ONCE = 2;
const SEGMENTS_AT_ONCE = 4;

export interface SearchStatus {
	phase: 'idle' | 'loading' | 'indexing' | 'ready';
	/** Items the index holds. */
	items: number;
	/** Files whose text is still to be read. */
	pending: number;
	/** Segments could not be stored, as quota ran out: this device has it all the same. */
	unsaved: boolean;
}

export interface SearchDeps {
	api: Pick<Api, 'listIndexBlobs' | 'getBlob' | 'putSmallBlob' | 'deleteSmallBlob'>;
	sealer: Pick<Sealer, 'suite'>;
	cache: SegmentCache;
	index: IndexClient;
	/** Reads every folder there is to read. */
	settle: (signal: AbortSignal) => Promise<void>;
	/** What the index should hold now. */
	snapshot: () => IndexDoc[];
	/** A file's bytes, for its text. Null when it can no longer be read. */
	read: (id: string, doc: FileFacts) => Promise<Blob | null>;
	/** A node's doc as it is now, or undefined if it is not a searchable one. */
	docOf: (id: string) => IndexDoc | undefined;
	/** The words of a file's comments, indexed with its text. */
	comments?: (id: string) => Promise<string>;
	onstatus?: (status: SearchStatus) => void;
	/** How long changes gather before a reconcile, and before they are stored. */
	reconcileMs?: number;
	flushMs?: number;
	/** Yields between batches, so that the page stays responsive. */
	pause?: () => Promise<void>;
}

const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class SearchService {
	readonly #deps: SearchDeps;
	readonly #abort = new AbortController();
	readonly #queue = new Map<string, { facts: FileFacts; version: string }>();
	readonly #reading = new Limiter(TEXTS_AT_ONCE);
	#status: SearchStatus = { phase: 'idle', items: 0, pending: 0, unsaved: false };
	#started = false;
	#stopped = false;
	#reconciling = false;
	#again = false;
	#reconcileTimer: ReturnType<typeof setTimeout> | null = null;
	#flushTimer: ReturnType<typeof setTimeout> | null = null;
	#flushing: Promise<void> = Promise.resolve();
	#draining = false;

	constructor(deps: SearchDeps) {
		this.#deps = deps;
	}

	get status(): SearchStatus {
		return this.#status;
	}

	#report(change: Partial<SearchStatus>): void {
		if (this.#stopped) return;
		this.#status = { ...this.#status, ...change };
		this.#deps.onstatus?.(this.#status);
	}

	/** Asks the index. Nothing about this goes anywhere else. */
	search(query: SearchQuery): Promise<SearchResults> {
		return this.#deps.index.search(query);
	}

	/** Loads what is stored, then catches up with the tree. Call once the tree is open. */
	async start(): Promise<void> {
		this.#report({ phase: 'loading' });
		try {
			await this.#loadStored();
		} catch {
			// Only what was cached helps less: the tree still gives the whole index but for text.
		}
		this.#started = true;
		await this.reconcileNow();
	}

	async #loadStored(): Promise<void> {
		const { api, cache, index } = this.#deps;
		const listed: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await api.listIndexBlobs({ cursor });
			listed.push(...page.blobs.map((blob) => blob.id));
			cursor = page.next_cursor;
		} while (cursor !== undefined);

		const known = new Set(listed);
		for (const id of await cache.ids()) if (!known.has(id)) await cache.delete(id);

		const limiter = new Limiter(SEGMENTS_AT_ONCE);
		const segments: SealedSegment[] = [];
		await Promise.all(
			listed.map((id) =>
				limiter.run(async () => {
					let bytes = await cache.get(id);
					if (bytes === null) {
						bytes = await api.getBlob(id);
						await cache.put(id, bytes);
					}
					segments.push({ id, bytes });
				})
			)
		);
		const { bad } = await index.load(segments);
		for (const id of bad) {
			await cache.delete(id);
			await api.deleteSmallBlob(id).catch(() => {});
		}
	}

	/** The tree changed. A reconcile follows when it has been quiet for a moment. */
	treeChanged(): void {
		if (!this.#started || this.#stopped) return;
		if (this.#reconcileTimer !== null) clearTimeout(this.#reconcileTimer);
		this.#reconcileTimer = setTimeout(() => {
			this.#reconcileTimer = null;
			void this.reconcileNow();
		}, this.#deps.reconcileMs ?? 1500);
	}

	/** Makes the index equal to the tree, and reads the text that shows to be missing. */
	async reconcileNow(): Promise<void> {
		if (this.#stopped) return;
		if (this.#reconciling) {
			this.#again = true;
			return;
		}
		this.#reconciling = true;
		const { index, settle, snapshot, pause = yieldToPage } = this.#deps;
		try {
			do {
				this.#again = false;
				if (this.#status.phase !== 'loading') this.#report({ phase: 'indexing' });
				await settle(this.#abort.signal);
				if (this.#stopped) return;
				const docs = snapshot();
				const byId = new Map(docs.map((doc) => [doc.id, doc]));
				await index.beginReconcile();
				for (let at = 0; at < docs.length; at += SNAPSHOT_BATCH) {
					const { stale } = await index.reconcile(docs.slice(at, at + SNAPSHOT_BATCH));
					for (const id of stale) this.#enqueue(byId.get(id));
					await pause();
				}
				const { size } = await index.endReconcile();
				for (const id of this.#queue.keys()) if (!byId.has(id)) this.#queue.delete(id);
				this.#report({ items: size, pending: this.#queue.size });
			} while (this.#again && !this.#stopped);
			this.#report({ phase: this.#queue.size > 0 ? 'indexing' : 'ready' });
			this.#scheduleFlush();
			void this.#drain();
		} catch {
			// Stopped, or a worker gone: the next change tries again.
			if (!this.#stopped) this.#report({ phase: 'ready' });
		} finally {
			this.#reconciling = false;
		}
	}

	#enqueue(doc: IndexDoc | undefined): void {
		if (doc === undefined || doc.version === null) return;
		this.#queue.set(doc.id, { facts: doc, version: doc.version });
	}

	/** Reads the files whose text the index lacks, a few at a time, behind everything else. */
	async #drain(): Promise<void> {
		if (this.#draining) return;
		this.#draining = true;
		const { read, index, pause = yieldToPage } = this.#deps;
		try {
			while (this.#queue.size > 0 && !this.#stopped) {
				const batch = [...this.#queue.entries()].slice(0, TEXTS_AT_ONCE);
				let unreachable = false;
				await Promise.all(
					batch.map(([id, job]) =>
						this.#reading.run(async () => {
							try {
								// A file that only has comments to say for itself is not read.
								const blob = extractorFor(job.facts) === null ? null : await read(id, job.facts);
								const text = blob === null ? '' : await extractText(job.facts, blob);
								await index.setText(id, job.version, await this.#withComments(id, text));
							} catch (e) {
								// The connection may come back. Anything else will fail the same way each
								// time, so this version counts as done, with no text.
								if (isTransient(e)) unreachable = true;
								else await index.setText(id, job.version, '').catch(() => {});
							}
							if (!unreachable) this.#queue.delete(id);
						})
					)
				);
				this.#report({ pending: this.#queue.size });
				if (unreachable) return;
				await pause();
			}
			if (!this.#stopped) this.#report({ phase: 'ready', pending: 0 });
			this.#scheduleFlush();
		} finally {
			this.#draining = false;
		}
	}

	/**
	 * A file just uploaded or saved: its text comes from the bytes in hand, so nothing
	 * is read back. Plug-ins for other formats get the same bytes.
	 */
	async fileCommitted(id: string, blob: Blob): Promise<void> {
		if (this.#stopped) return;
		const { index, docOf } = this.#deps;
		const doc = docOf(id);
		if (doc === undefined || doc.version === null) return;
		this.#queue.delete(id);
		try {
			await index.upsert([doc]);
			const text = extractorFor(doc) === null ? '' : await extractText(doc, blob);
			await index.setText(id, doc.version, await this.#withComments(id, text));
			this.#scheduleFlush();
		} catch {
			// The next reconcile finds the text missing, and reads it back.
		}
		this.treeChanged();
	}

	/** A file's text and, when it has any, the words of its comments after it. */
	async #withComments(id: string, text: string): Promise<string> {
		const { comments, docOf } = this.#deps;
		if (comments === undefined || !docOf(id)?.version?.includes('+c')) return text;
		const words = await comments(id);
		return words === '' ? text : text === '' ? words : `${text}\n${words}`;
	}

	#scheduleFlush(): void {
		if (this.#stopped || this.#flushTimer !== null) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = null;
			void this.flushNow();
		}, this.#deps.flushMs ?? 4000);
	}

	/** Stores what is only in memory, and merges if segments have piled up. One at a time. */
	flushNow(limit?: number): Promise<void> {
		this.#flushing = this.#flushing.then(() => this.#flush(limit));
		return this.#flushing;
	}

	async #flush(limit?: number): Promise<void> {
		if (this.#stopped) return;
		const { index } = this.#deps;
		try {
			const wrote = await this.#store(await index.flush());
			await this.#store(await index.compact(limit));
			if (wrote) this.#report({ unsaved: false });
		} catch (e) {
			if (isApiError(e, 'quota_exceeded', 'storage_full')) this.#report({ unsaved: true });
			// Otherwise it is all still marked as in memory, and goes with the next flush.
		}
	}

	/** Whether there was anything to store. */
	async #store(write: EngineWrite | null): Promise<boolean> {
		if (write === null) return false;
		const { api, sealer, cache, index } = this.#deps;
		const sizes: Record<string, number> = {};
		try {
			for (const { id, bytes } of write.add) {
				await api.putSmallBlob(
					id,
					{ kind: 'index', suite: sealer.suite },
					bytes,
					digestHeader(bytes)
				);
				await cache.put(id, bytes);
				sizes[id] = bytes.length;
			}
		} catch (e) {
			await index.abort(write.token).catch(() => {});
			for (const id of Object.keys(sizes)) {
				await api.deleteSmallBlob(id).catch(() => {});
				await cache.delete(id);
			}
			throw e;
		}
		await index.stored(write.token, sizes);
		for (const id of write.remove) {
			await api.deleteSmallBlob(id).catch(() => {});
			await cache.delete(id);
		}
		return true;
	}

	/** A lock or sign-out: the index and its key go with the worker. */
	stop(): void {
		this.#stopped = true;
		this.#abort.abort();
		if (this.#reconcileTimer !== null) clearTimeout(this.#reconcileTimer);
		if (this.#flushTimer !== null) clearTimeout(this.#flushTimer);
		this.#queue.clear();
		this.#deps.index.stop();
	}

	/** Forgets this user's segments on this device, on signing out. */
	forget(): Promise<void> {
		return this.#deps.cache.clear();
	}
}

function isTransient(e: unknown): boolean {
	return e instanceof ApiError && (e.code === 'network' || e.status === 429 || e.status >= 500);
}
