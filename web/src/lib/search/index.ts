/**
 * The inverted index in memory: pure, and fast enough on the main thread, though the
 * app keeps it in a worker. Words map to postings over a sorted vocabulary, so that a
 * prefix is a range (Spike C). What changes gets a new ordinal and the old one dies:
 * postings of a dead ordinal are skipped here, and left out of the next segment.
 */
import { fileKindOf } from '$lib/drive/kinds';
import type { KindFilter } from '$lib/drive/sort';
import { newId } from '$lib/drive/ids';
import {
	FIELD_NAME,
	FIELD_TAG,
	FIELD_TEXT,
	MAX_SEGMENT_BYTES,
	planCompaction,
	SEGMENT_VERSION,
	type SegmentBody,
	type SegmentMeta,
	type StoredDoc
} from './segment';
import { uniqueTokens } from './tokenize';
import type { DateFilter, IndexDoc, SearchHit, SearchQuery, SearchResults } from './types';

/** How many words of one file's text are kept. */
export const MAX_TEXT_WORDS = 20_000;
/** How many words one typed prefix may expand to before the rest are ignored. */
export const MAX_EXPANSION = 5000;

const WEIGHTS = [8, 4, 1];
const FIELD_NAMES = ['name', 'tag', 'text'] as const;
const DAY = 24 * 60 * 60 * 1000;
const WINDOWS: Record<Exclude<DateFilter, 'any'>, number> = {
	day: DAY,
	week: 7 * DAY,
	month: 31 * DAY,
	year: 366 * DAY
};

interface Entry {
	doc: IndexDoc;
	/** The ordinal of its name and tags. */
	meta: number;
	/** The ordinal of its text, or -1. */
	text: number;
	/** The version its text came from. */
	textVersion: string | null;
	/** The segment that holds this copy; null while it is only in memory. */
	origin: string | null;
	/** About how much of a segment it takes. */
	bytes: number;
}

/** What a merge or a flush produced, to store and then to forget about. */
export interface SegmentWrite {
	/** What to store, each under its id. */
	add: { id: string; body: SegmentBody }[];
	/** What the stored ones replace, to delete after. */
	remove: string[];
	/** Hands this back if storing them failed. */
	token: number;
}

const estimateDoc = (doc: IndexDoc): number =>
	doc.name.length * 2 + doc.type.length + doc.id.length * 3 + 120 + doc.tagIds.length * 40;

function sameMeta(a: IndexDoc, b: IndexDoc): boolean {
	return (
		a.parent === b.parent &&
		a.name === b.name &&
		a.kind === b.kind &&
		a.type === b.type &&
		a.modified === b.modified &&
		a.size === b.size &&
		a.shared === b.shared &&
		a.version === b.version &&
		a.text === b.text &&
		a.tagIds.length === b.tagIds.length &&
		a.tagIds.every((tag, i) => tag === b.tagIds[i]) &&
		a.tagNames.length === b.tagNames.length &&
		a.tagNames.every((tag, i) => tag === b.tagNames[i])
	);
}

function kindMatches(doc: IndexDoc, filter: KindFilter): boolean {
	switch (filter) {
		case 'all':
			return true;
		case 'folders':
			return doc.kind === 'folder';
		case 'images':
			return fileKindOf(doc) === 'image';
		case 'video':
			return fileKindOf(doc) === 'video';
		case 'documents':
			return ['doc', 'sheet', 'note', 'pdf'].includes(fileKindOf(doc));
		default:
			return doc.kind === 'file' && fileKindOf(doc) === 'other';
	}
}

export class SearchIndex {
	readonly #entries = new Map<string, Entry>();
	readonly #owners: (Entry | null)[] = [];
	readonly #postings = new Map<string, number[]>();
	#terms: string[] | null = null;
	/** What is gone from memory and may still be in a stored segment. */
	#gone = new Set<string>();
	readonly #segments = new Map<string, SegmentMeta>();
	readonly #undo = new Map<number, { add: string[]; restore: SegmentMeta[]; gone: string[] }>();
	#seq = 0;
	#token = 0;

	get size(): number {
		return this.#entries.size;
	}

	get segmentCount(): number {
		return this.#segments.size;
	}

	/** Whether anything is only in memory. */
	get dirty(): boolean {
		if (this.#gone.size > 0) return true;
		for (const entry of this.#entries.values()) if (entry.origin === null) return true;
		return false;
	}

	has(id: string): boolean {
		return this.#entries.has(id);
	}

	/** The stale check of one file: wants text, and has none of this version. */
	staleText(id: string): boolean {
		const entry = this.#entries.get(id);
		return (
			entry !== undefined &&
			entry.doc.text &&
			entry.doc.version !== null &&
			entry.textVersion !== entry.doc.version
		);
	}

	ids(): string[] {
		return [...this.#entries.keys()];
	}

	#own(entry: Entry): number {
		this.#owners.push(entry);
		return this.#owners.length - 1;
	}

	#retire(ordinal: number): void {
		if (ordinal >= 0) this.#owners[ordinal] = null;
	}

	#post(word: string, ordinal: number, field: number): void {
		const posting = (ordinal << 2) | field;
		const list = this.#postings.get(word);
		if (list === undefined) {
			this.#postings.set(word, [posting]);
			this.#terms = null;
		} else {
			list.push(posting);
		}
	}

	#postMeta(entry: Entry): void {
		const ordinal = this.#own(entry);
		entry.meta = ordinal;
		for (const word of uniqueTokens(entry.doc.name)) this.#post(word, ordinal, FIELD_NAME);
		for (const word of uniqueTokens(entry.doc.tagNames.join(' '))) {
			this.#post(word, ordinal, FIELD_TAG);
		}
	}

	/** Adds or replaces a doc, keeping its text. Returns whether anything changed. */
	upsert(doc: IndexDoc): boolean {
		const known = this.#entries.get(doc.id);
		if (known !== undefined && sameMeta(known.doc, doc)) return false;
		this.#gone.delete(doc.id);
		if (known === undefined) {
			const entry: Entry = {
				doc,
				meta: -1,
				text: -1,
				textVersion: null,
				origin: null,
				bytes: estimateDoc(doc)
			};
			this.#entries.set(doc.id, entry);
			this.#postMeta(entry);
			return true;
		}
		this.#retire(known.meta);
		known.doc = doc;
		known.origin = null;
		this.#postMeta(known);
		if (!doc.text && known.text >= 0) {
			this.#retire(known.text);
			known.text = -1;
			known.textVersion = null;
		}
		return true;
	}

	/** Puts the words of a file's text in place of what it had. */
	setText(id: string, version: string | null, text: string): boolean {
		const entry = this.#entries.get(id);
		if (entry === undefined) return false;
		this.#retire(entry.text);
		const words = uniqueTokens(text, MAX_TEXT_WORDS);
		entry.text = words.length === 0 ? -1 : this.#own(entry);
		entry.textVersion = version;
		entry.origin = null;
		entry.bytes = estimateDoc(entry.doc);
		for (const word of words) {
			this.#post(word, entry.text, FIELD_TEXT);
			entry.bytes += word.length + 10;
		}
		return true;
	}

	remove(id: string): boolean {
		const entry = this.#entries.get(id);
		if (entry === undefined) return false;
		this.#retire(entry.meta);
		this.#retire(entry.text);
		this.#entries.delete(id);
		this.#gone.add(id);
		return true;
	}

	#vocabulary(): string[] {
		this.#terms ??= [...this.#postings.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		return this.#terms;
	}

	/** Every live doc a word matches as a prefix, with the best it scored there. */
	#matches(word: string): Map<Entry, { score: number; field: number }> {
		const found = new Map<Entry, { score: number; field: number }>();
		const terms = this.#vocabulary();
		let low = 0;
		let high = terms.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (terms[mid] < word) low = mid + 1;
			else high = mid;
		}
		for (let i = low, seen = 0; i < terms.length && seen < MAX_EXPANSION; i++, seen++) {
			const term = terms[i];
			if (!term.startsWith(word)) break;
			const exact = term === word ? 2 : 1;
			for (const posting of this.#postings.get(term) as number[]) {
				const owner = this.#owners[posting >> 2];
				if (owner === null) continue;
				const field = posting & 3;
				const score = WEIGHTS[field] * exact;
				const best = found.get(owner);
				if (best === undefined || score > best.score) found.set(owner, { score, field });
			}
		}
		return found;
	}

	/** The names of the folders above a doc, from the top down. */
	#path(doc: IndexDoc): string[] {
		const path: string[] = [];
		const seen = new Set([doc.id]);
		let at = doc.parent === null ? undefined : this.#entries.get(doc.parent);
		while (at !== undefined && !seen.has(at.doc.id)) {
			seen.add(at.doc.id);
			path.unshift(at.doc.name);
			at = at.doc.parent === null ? undefined : this.#entries.get(at.doc.parent);
		}
		return path;
	}

	#passes(doc: IndexDoc, query: SearchQuery, since: number | null): boolean {
		if (query.type !== undefined && !kindMatches(doc, query.type)) return false;
		if (query.tag && !doc.tagIds.includes(query.tag)) return false;
		if (since !== null && doc.modified < since) return false;
		if (query.shared === 'with-me' && !doc.shared) return false;
		if (query.shared === 'mine' && doc.shared) return false;
		return true;
	}

	/**
	 * Every word typed has to match, each as the start of a word. With no words, the
	 * filters alone choose; with neither there is nothing to show.
	 */
	search(query: SearchQuery): SearchResults {
		const words = uniqueTokens(query.text);
		const hasFilter =
			(query.type !== undefined && query.type !== 'all') ||
			Boolean(query.tag) ||
			(query.date !== undefined && query.date !== 'any') ||
			(query.shared !== undefined && query.shared !== 'any');
		if (words.length === 0 && !hasFilter) return { hits: [], total: 0 };
		const since =
			query.date === undefined || query.date === 'any'
				? null
				: (query.now ?? Date.now()) - WINDOWS[query.date];

		const scored: { entry: Entry; score: number; field: number }[] = [];
		if (words.length === 0) {
			for (const entry of this.#entries.values()) {
				if (this.#passes(entry.doc, query, since)) scored.push({ entry, score: 0, field: -1 });
			}
		} else {
			const lists = words.map((word) => this.#matches(word)).sort((a, b) => a.size - b.size);
			for (const [entry, first] of lists[0]) {
				let score = first.score;
				let field = first.field;
				let all = true;
				for (let i = 1; i < lists.length; i++) {
					const other = lists[i].get(entry);
					if (other === undefined) {
						all = false;
						break;
					}
					score += other.score;
					field = Math.min(field, other.field);
				}
				if (all && this.#passes(entry.doc, query, since)) scored.push({ entry, score, field });
			}
		}
		scored.sort(
			(a, b) =>
				b.score - a.score ||
				b.entry.doc.modified - a.entry.doc.modified ||
				(a.entry.doc.id < b.entry.doc.id ? -1 : 1)
		);
		const hits = scored.slice(0, query.limit ?? 50).map(({ entry, field }): SearchHit => {
			const { id, parent, name, kind, type, modified, size, shared, tagIds } = entry.doc;
			return {
				id,
				parent,
				name,
				kind,
				type,
				modified,
				size,
				shared,
				tagIds,
				path: this.#path(entry.doc),
				matched: field < 0 ? 'none' : FIELD_NAMES[field]
			};
		});
		return { hits, total: scored.length };
	}

	/** Takes in a stored segment. Call in `seq` order: a later one overrides an earlier one. */
	load(id: string, body: SegmentBody, size: number): void {
		this.#seq = Math.max(this.#seq, body.seq);
		this.#segments.set(id, { id, seq: body.seq, size, gone: body.gone });
		for (const gone of body.gone) {
			this.remove(gone);
			this.#gone.delete(gone);
		}
		const entries: Entry[] = [];
		for (const stored of body.docs) {
			const doc = readDoc(stored);
			const known = this.#entries.get(doc.id);
			if (known !== undefined) {
				this.#retire(known.meta);
				this.#retire(known.text);
			}
			const entry: Entry = {
				doc,
				meta: -1,
				text: -1,
				textVersion: stored[12],
				origin: id,
				bytes: estimateDoc(doc)
			};
			entry.meta = this.#own(entry);
			this.#entries.set(doc.id, entry);
			entries.push(entry);
		}
		for (const [word, postings] of Object.entries(body.terms)) {
			for (const posting of postings) {
				const entry = entries[posting >> 2];
				if (entry === undefined) continue;
				const field = posting & 3;
				if (field === FIELD_TEXT) {
					if (entry.text < 0) entry.text = this.#own(entry);
					entry.bytes += word.length + 10;
					this.#post(word, entry.text, field);
				} else {
					this.#post(word, entry.meta, field);
				}
			}
		}
	}

	/** Bodies for these entries, split to fit a blob, each word listed once per body. */
	#write(entries: Entry[], gone: string[], seq: number): { id: string; body: SegmentBody }[] {
		const chunks: { id: string; entries: Entry[]; bytes: number }[] = [];
		for (const entry of entries) {
			let chunk = chunks.at(-1);
			if (chunk === undefined || chunk.bytes + entry.bytes > MAX_SEGMENT_BYTES) {
				chunk = { id: newId(), entries: [], bytes: 0 };
				chunks.push(chunk);
			}
			chunk.entries.push(entry);
			chunk.bytes += entry.bytes;
		}
		if (chunks.length === 0) chunks.push({ id: newId(), entries: [], bytes: 0 });

		const where = new Map<Entry, { chunk: number; at: number }>();
		const bodies = chunks.map((chunk, c): SegmentBody => {
			chunk.entries.forEach((entry, at) => where.set(entry, { chunk: c, at }));
			return {
				v: SEGMENT_VERSION,
				seq,
				docs: chunk.entries.map(writeDoc),
				gone: c === 0 ? gone : [],
				terms: Object.create(null) as Record<string, number[]>
			};
		});
		for (const [word, postings] of this.#postings) {
			for (const posting of postings) {
				const owner = this.#owners[posting >> 2];
				if (owner === null) continue;
				const place = where.get(owner);
				if (place === undefined) continue;
				const terms = bodies[place.chunk].terms;
				(terms[word] ??= []).push((place.at << 2) | (posting & 3));
			}
		}
		return chunks.map((chunk, c) => ({ id: chunk.id, body: bodies[c] }));
	}

	/** Writes what is only in memory. Nothing to write gives nothing. */
	flush(): SegmentWrite | null {
		const entries = [...this.#entries.values()].filter((entry) => entry.origin === null);
		const gone = [...this.#gone];
		if (entries.length === 0 && gone.length === 0) return null;
		const seq = this.#seq + 1;
		const add = this.#write(entries, gone, seq);
		this.#gone = new Set();
		this.#seq = seq;
		add.forEach(({ id, body }) => {
			this.#segments.set(id, { id, seq: body.seq, size: 0, gone: body.gone });
			for (const stored of body.docs) {
				const entry = this.#entries.get(stored[0]);
				if (entry !== undefined) entry.origin = id;
			}
		});
		const token = ++this.#token;
		this.#undo.set(token, { add: add.map(({ id }) => id), restore: [], gone });
		return { add, remove: [], token };
	}

	/** Merges the newest small segments, if there are too many. */
	compact(limit?: number): SegmentWrite | null {
		const run = planCompaction([...this.#segments.values()], limit);
		if (run.length === 0) return null;
		const ids = new Set(run.map((meta) => meta.id));
		const entries = [...this.#entries.values()].filter(
			(entry) => entry.origin !== null && ids.has(entry.origin)
		);
		const oldest = Math.min(...[...this.#segments.values()].map((meta) => meta.seq));
		const reachesOldest = run.some((meta) => meta.seq === oldest);
		// With nothing older left, nothing is there for a removal to hide.
		const gone = reachesOldest
			? []
			: [...new Set(run.flatMap((meta) => meta.gone))].filter((id) => !this.#entries.has(id));
		const add = this.#write(entries, gone, Math.max(...run.map((meta) => meta.seq)));
		for (const meta of run) this.#segments.delete(meta.id);
		add.forEach(({ id, body }) => {
			this.#segments.set(id, { id, seq: body.seq, size: 0, gone: body.gone });
			for (const stored of body.docs) {
				const entry = this.#entries.get(stored[0]);
				if (entry !== undefined) entry.origin = id;
			}
		});
		const token = ++this.#token;
		this.#undo.set(token, { add: add.map(({ id }) => id), restore: run, gone: [] });
		return { add, remove: run.map((meta) => meta.id), token };
	}

	/** A write is stored: says how big each segment came out, for later merges. */
	stored(token: number, sizes: Record<string, number>): void {
		this.#undo.delete(token);
		for (const [id, size] of Object.entries(sizes)) {
			const meta = this.#segments.get(id);
			if (meta !== undefined) meta.size = size;
		}
	}

	/** A write could not be stored: what it held counts as only in memory again. */
	abort(token: number): void {
		const undo = this.#undo.get(token);
		if (undo === undefined) return;
		this.#undo.delete(token);
		const added = new Set(undo.add);
		for (const id of undo.add) this.#segments.delete(id);
		for (const meta of undo.restore) this.#segments.set(meta.id, meta);
		for (const entry of this.#entries.values()) {
			if (entry.origin !== null && added.has(entry.origin)) entry.origin = null;
		}
		for (const id of undo.gone) if (!this.#entries.has(id)) this.#gone.add(id);
	}
}

function readDoc(stored: StoredDoc): IndexDoc {
	return {
		id: stored[0],
		parent: stored[1],
		name: stored[2],
		kind: stored[3] === 1 ? 'folder' : 'file',
		type: stored[4],
		modified: stored[5],
		size: stored[6],
		shared: stored[7] === 1,
		tagIds: stored[8],
		tagNames: stored[9],
		version: stored[10],
		text: stored[11] === 1
	};
}

function writeDoc({ doc, textVersion }: Entry): StoredDoc {
	return [
		doc.id,
		doc.parent,
		doc.name,
		doc.kind === 'folder' ? 1 : 0,
		doc.type,
		doc.modified,
		doc.size,
		doc.shared ? 1 : 0,
		doc.tagIds,
		doc.tagNames,
		doc.version,
		doc.text ? 1 : 0,
		textVersion
	];
}
