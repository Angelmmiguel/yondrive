/**
 * The notes index: what each note's Markdown says (links, tags, tasks, pictures
 * and its text), by note and by the version it was read from. Backlinks, tags and
 * unlinked mentions are answered from it, on the device. It is kept current by
 * reading again the notes whose version moved, and stored only on this device, an
 * entry per note, each sealed under the search index's key (see `indexer.ts`).
 * Pure, and plain data.
 */
import type { NoteFacts, NoteLink, NoteTask } from './parse';
import { around, MAX_FACTS, mentionAt } from './parse';
import { normalizeName } from '$lib/crypto/metadata';

/** 2: an entry per note, stored on its own. 1 was every entry in one. */
export const NOTES_INDEX_VERSION = 2;

export interface IndexEntry extends NoteFacts {
	/** The version the facts were read from. */
	version: string;
}

/** What `encodeEntry` writes: a version and one note's entry. */
interface StoredEntry {
	v: typeof NOTES_INDEX_VERSION;
	entry: IndexEntry;
}

export interface NoteRef {
	id: string;
	title: string;
}

export interface Backlink {
	from: string;
	context: string;
}

export interface Mention {
	from: string;
	context: string;
}

export class NotesIndex {
	readonly entries = new Map<string, IndexEntry>();
	/** Moves on with each change, so what is worked out from the entries is kept until then. */
	revision = 0;
	/** Notes whose entry was set or dropped since the index was last stored. */
	readonly #changed = new Set<string>();

	get(id: string): IndexEntry | undefined {
		return this.entries.get(id);
	}

	/** Whether a note's facts are missing or from another version. */
	needs(id: string, version: string | null): boolean {
		return version !== null && this.entries.get(id)?.version !== version;
	}

	set(id: string, version: string, facts: NoteFacts): void {
		this.entries.set(id, { ...facts, version });
		this.#changed.add(id);
		this.revision++;
	}

	/** Drops what is not in `keep`; whether anything went. */
	retain(keep: ReadonlySet<string>): boolean {
		let changed = false;
		for (const id of [...this.entries.keys()]) {
			if (!keep.has(id)) {
				this.entries.delete(id);
				this.#changed.add(id);
				changed = true;
			}
		}
		if (changed) this.revision++;
		return changed;
	}

	/** What changed since the last call: the entries to store again, and the notes to forget. */
	takeChanges(): { put: [string, IndexEntry][]; drop: string[] } {
		const put: [string, IndexEntry][] = [];
		const drop: string[] = [];
		for (const id of this.#changed) {
			const entry = this.entries.get(id);
			if (entry === undefined) drop.push(id);
			else put.push([id, entry]);
		}
		this.#changed.clear();
		return { put, drop };
	}

	/** One note's entry as stored. */
	static encodeEntry(entry: IndexEntry): Uint8Array {
		const stored: StoredEntry = { v: NOTES_INDEX_VERSION, entry };
		return new TextEncoder().encode(JSON.stringify(stored));
	}

	/** One note's entry from stored bytes, or null if they do not read: it is read again. */
	static decodeEntry(bytes: Uint8Array): IndexEntry | null {
		let stored: unknown;
		try {
			stored = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return null;
		}
		const s = stored as Partial<StoredEntry> | null;
		if (s === null || typeof s !== 'object' || s.v !== NOTES_INDEX_VERSION) return null;
		return checkEntry(s.entry);
	}
}

const isString = (v: unknown): v is string => typeof v === 'string';

function checkEntry(value: unknown): IndexEntry | null {
	if (value === null || typeof value !== 'object') return null;
	const e = value as Record<string, unknown>;
	if (!isString(e.version) || !isString(e.preview) || !isString(e.text)) return null;
	if (typeof e.words !== 'number' || !Array.isArray(e.links) || !Array.isArray(e.tasks))
		return null;
	if (!Array.isArray(e.tags) || !Array.isArray(e.images)) return null;
	const links = (e.links as unknown[]).filter(
		(l): l is NoteLink =>
			l !== null &&
			typeof l === 'object' &&
			((l as NoteLink).kind === 'node' || (l as NoteLink).kind === 'title') &&
			isString((l as NoteLink).target) &&
			isString((l as NoteLink).context)
	);
	const tasks = (e.tasks as unknown[]).filter(
		(t): t is NoteTask =>
			t !== null &&
			typeof t === 'object' &&
			isString((t as NoteTask).text) &&
			typeof (t as NoteTask).done === 'boolean' &&
			((t as NoteTask).due === null || isString((t as NoteTask).due))
	);
	return {
		version: e.version,
		preview: e.preview,
		text: e.text,
		words: e.words,
		// Stored before the caps of `analyzeModel`, an entry could hold more.
		links: links.slice(0, MAX_FACTS),
		tasks: tasks.slice(0, MAX_FACTS),
		tags: (e.tags as unknown[]).filter(isString).slice(0, MAX_FACTS),
		images: (e.images as unknown[]).filter(isString).slice(0, MAX_FACTS)
	};
}

/**
 * The notes a link may point at, looked up by title in one step. Built once for a
 * list of notes and passed to each question, so no question walks the notes per link.
 */
export class NoteRefs {
	readonly live: ReadonlySet<string>;
	readonly #byTitle = new Map<string, string>();

	constructor(notes: readonly NoteRef[]) {
		this.live = new Set(notes.map((n) => n.id));
		for (const n of notes) {
			const key = normalizeName(n.title.trim());
			// The first note with a title is the one it names, as before.
			if (!this.#byTitle.has(key)) this.#byTitle.set(key, n.id);
		}
	}

	/** The note a link points at: by id, or the note with that title. */
	resolve(link: NoteLink): string | null {
		if (link.kind === 'node') return link.target;
		return this.#byTitle.get(normalizeName(link.target.trim())) ?? null;
	}
}

/** For each note, the notes that link to it and the context of each one's first link. */
type LinkGraph = Map<string, Backlink[]>;

const graphs = new WeakMap<NotesIndex, { revision: number; refs: NoteRefs; graph: LinkGraph }>();

/** Who links to whom, read once per change of the index or of the notes. */
function linkGraph(index: NotesIndex, refs: NoteRefs): LinkGraph {
	const known = graphs.get(index);
	if (known !== undefined && known.revision === index.revision && known.refs === refs)
		return known.graph;
	const graph: LinkGraph = new Map();
	for (const [from, entry] of index.entries) {
		if (!refs.live.has(from)) continue;
		const reached = new Set<string>();
		for (const link of entry.links) {
			const to = refs.resolve(link);
			if (to === null || to === from || reached.has(to)) continue;
			reached.add(to);
			const list = graph.get(to);
			const back = { from, context: link.context };
			if (list === undefined) graph.set(to, [back]);
			else list.push(back);
		}
	}
	graphs.set(index, { revision: index.revision, refs, graph });
	return graph;
}

/** Notes that link to `target`, each once, with the context of its first link. */
export function backlinks(index: NotesIndex, target: string, refs: NoteRefs): Backlink[] {
	return linkGraph(index, refs).get(target) ?? [];
}

/** Notes that name `target`'s title in their text without linking to it. */
export function unlinkedMentions(index: NotesIndex, target: NoteRef, refs: NoteRefs): Mention[] {
	const linking = new Set(backlinks(index, target.id, refs).map((b) => b.from));
	const out: Mention[] = [];
	for (const [from, entry] of index.entries) {
		if (from === target.id || !refs.live.has(from) || linking.has(from)) continue;
		const at = mentionAt(entry.text, target.title);
		if (at >= 0) out.push({ from, context: around(entry.text, at, target.title.length) });
	}
	return out;
}

/** Every tag of a note: those given in the editor and the `#tags` of its text. */
export function tagsOf(entry: IndexEntry | undefined, given: readonly string[]): string[] {
	return [...new Set([...given, ...(entry?.tags ?? [])])];
}

/** How many notes carry each tag, most used first. */
export function tagCounts(lists: readonly (readonly string[])[]): { tag: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const tags of lists) for (const t of new Set(tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
	return [...counts]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
