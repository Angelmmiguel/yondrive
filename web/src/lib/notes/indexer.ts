/**
 * Keeping the notes index equal to the notes: after each change to the tree, the
 * notes whose current version the index has not read are read, a couple at a
 * time, and what has gone is dropped. The index is kept on this device only, an
 * entry per note sealed like a search segment under the search index's key, in a
 * database of its own, and only the entries that changed are written again;
 * another device builds its own from the notes. Losing it costs a read of each
 * note, nothing more.
 */
import type { Sealer } from '$lib/crypto/sealer';
import { Limiter } from '$lib/drive/retry';
import type { SegmentCache } from '$lib/search/cache';
import { NotesIndex, type IndexEntry } from './index';
import { analyze } from './parse';

/** The index's id: each note's entry is kept under `notes-index/<note id>`, and bound to it. */
export const NOTES_INDEX_ID = 'notes-index';

const ENTRY = `${NOTES_INDEX_ID}/`;
export const entryId = (noteId: string) => `${ENTRY}${noteId}`;

/** A note larger than this is not read for the index. */
export const NOTE_READ_LIMIT = 4 * 1024 * 1024;

export interface NotesCache {
	load(): Promise<NotesIndex>;
	/** Stores what changed since the last save, and only that. */
	save(index: NotesIndex): Promise<void>;
	forget(): Promise<void>;
}

/**
 * The index in a store of sealed segments, an entry per note, each sealed under
 * `key` and bound to the index and the note, so one note's entry never opens as
 * another's.
 */
export function sealedNotesCache(
	store: SegmentCache,
	sealer: Pick<Sealer, 'sealIndexSegmentWith' | 'openIndexSegmentWith'>,
	key: Uint8Array
): NotesCache {
	return {
		async load() {
			const index = new NotesIndex();
			const ids = await store.ids();
			// Earlier builds kept every entry in one blob, written whole on each change.
			if (ids.includes(NOTES_INDEX_ID)) await store.delete(NOTES_INDEX_ID);
			await Promise.all(
				ids
					.filter((id) => id.startsWith(ENTRY))
					.map(async (id) => {
						const bytes = await store.get(id);
						if (bytes === null) return;
						let entry: IndexEntry | null = null;
						try {
							entry = NotesIndex.decodeEntry(sealer.openIndexSegmentWith(key, id, bytes));
						} catch {
							// Read again from the note below.
						}
						if (entry !== null) index.entries.set(id.slice(ENTRY.length), entry);
						// One that does not open or read is read again from the note, if it is still there.
						else await store.delete(id);
					})
			);
			return index;
		},
		async save(index) {
			const { put, drop } = index.takeChanges();
			await Promise.all([
				...put.map(([noteId, entry]) =>
					store.put(
						entryId(noteId),
						sealer.sealIndexSegmentWith(key, entryId(noteId), NotesIndex.encodeEntry(entry))
					)
				),
				...drop.map((noteId) => store.delete(entryId(noteId)))
			]);
		},
		forget: () => store.clear()
	};
}

export interface IndexedNote {
	id: string;
	version: string | null;
	size: number;
}

export interface IndexerDeps {
	cache: NotesCache;
	/** A note's Markdown, or null when it cannot be read now. */
	read(id: string): Promise<string | null>;
	onchange(): void;
	saveMs?: number;
}

export class NotesIndexer {
	index = new NotesIndex();
	readonly #deps: IndexerDeps;
	readonly #reading = new Limiter(2);
	#loaded: Promise<void> | null = null;
	#running: Promise<void> | null = null;
	#again: IndexedNote[] | null = null;
	#saveTimer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;

	constructor(deps: IndexerDeps) {
		this.#deps = deps;
	}

	/** Takes in what this device stored last time. */
	load(): Promise<void> {
		this.#loaded ??= this.#deps.cache
			.load()
			.then((index) => {
				if (!this.#stopped) this.index = index;
			})
			.catch(() => {});
		return this.#loaded;
	}

	/** Brings the index in line with these notes. Called again while running, it runs once more after. */
	reconcile(notes: IndexedNote[]): Promise<void> {
		if (this.#running) {
			this.#again = notes;
			return this.#running;
		}
		this.#running = this.#run(notes).finally(() => {
			this.#running = null;
			const again = this.#again;
			this.#again = null;
			if (again !== null && !this.#stopped) void this.reconcile(again);
		});
		return this.#running;
	}

	async #run(notes: IndexedNote[]): Promise<void> {
		await this.load();
		const keep = new Set(notes.map((n) => n.id));
		let changed = this.index.retain(keep);
		const stale = notes.filter((n) => this.index.needs(n.id, n.version));
		if (changed) this.#deps.onchange();
		await Promise.all(
			stale.map((n) =>
				this.#reading.run(async () => {
					if (this.#stopped || n.version === null) return;
					let text: string | null = '';
					if (n.size <= NOTE_READ_LIMIT) text = await this.#deps.read(n.id).catch(() => null);
					if (text === null || this.#stopped) return;
					this.index.set(n.id, n.version, analyze(text));
					changed = true;
					this.#deps.onchange();
				})
			)
		);
		if (changed) this.#scheduleSave();
	}

	/** A note just saved here, with its text in hand: nothing is read back. */
	saved(id: string, version: string, markdown: string): void {
		if (this.#stopped) return;
		this.index.set(id, version, analyze(markdown));
		this.#deps.onchange();
		this.#scheduleSave();
	}

	#scheduleSave(): void {
		if (this.#stopped || this.#saveTimer !== null) return;
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = null;
			if (!this.#stopped) void this.#deps.cache.save(this.index).catch(() => {});
		}, this.#deps.saveMs ?? 3000);
	}

	/** Stores what is pending now; for tests and for a closing tab. */
	async flush(): Promise<void> {
		if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
		this.#saveTimer = null;
		await this.#running;
		await this.#deps.cache.save(this.index);
	}

	stop(): void {
		this.#stopped = true;
		if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
		this.#saveTimer = null;
		this.index = new NotesIndex();
	}
}
