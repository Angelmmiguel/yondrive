/**
 * The notes index: what each note's Markdown says (links, tags, tasks, pictures
 * and its text), by note and by the version it was read from. Backlinks, tags and
 * unlinked mentions are answered from it, on the device. It is kept current by
 * reading again the notes whose version moved, and stored only on this device,
 * sealed under the search index's key (see `cache.ts`). Pure, and plain data.
 */
import type { NoteFacts, NoteLink, NoteTask } from './parse';
import { mentionAt, around } from './parse';
import { sameTitle } from './model';

export const NOTES_INDEX_VERSION = 1;

export interface IndexEntry extends NoteFacts {
	/** The version the facts were read from. */
	version: string;
}

/** What `encode` writes: a version and the entries. */
interface Stored {
	v: typeof NOTES_INDEX_VERSION;
	entries: [string, IndexEntry][];
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

	get(id: string): IndexEntry | undefined {
		return this.entries.get(id);
	}

	/** Whether a note's facts are missing or from another version. */
	needs(id: string, version: string | null): boolean {
		return version !== null && this.entries.get(id)?.version !== version;
	}

	set(id: string, version: string, facts: NoteFacts): void {
		this.entries.set(id, { ...facts, version });
	}

	/** Drops what is not in `keep`; whether anything went. */
	retain(keep: ReadonlySet<string>): boolean {
		let changed = false;
		for (const id of [...this.entries.keys()]) {
			if (!keep.has(id)) {
				this.entries.delete(id);
				changed = true;
			}
		}
		return changed;
	}

	encode(): Uint8Array {
		const stored: Stored = { v: NOTES_INDEX_VERSION, entries: [...this.entries] };
		return new TextEncoder().encode(JSON.stringify(stored));
	}

	/** An index from stored bytes; what does not read is left out, and is read again. */
	static decode(bytes: Uint8Array): NotesIndex {
		const index = new NotesIndex();
		let stored: unknown;
		try {
			stored = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return index;
		}
		const s = stored as Partial<Stored> | null;
		if (s === null || typeof s !== 'object' || s.v !== NOTES_INDEX_VERSION) return index;
		for (const item of Array.isArray(s.entries) ? s.entries : []) {
			if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
			const entry = checkEntry(item[1]);
			if (entry !== null) index.entries.set(item[0], entry);
		}
		return index;
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
		links,
		tasks,
		tags: (e.tags as unknown[]).filter(isString),
		images: (e.images as unknown[]).filter(isString)
	};
}

/** The note a link points at: by id, or the note with that title. */
export function resolveLink(link: NoteLink, notes: readonly NoteRef[]): string | null {
	if (link.kind === 'node') return link.target;
	return notes.find((n) => sameTitle(n.title, link.target))?.id ?? null;
}

/** Notes that link to `target`, each once, with the context of its first link. */
export function backlinks(
	index: NotesIndex,
	target: string,
	notes: readonly NoteRef[]
): Backlink[] {
	const live = new Set(notes.map((n) => n.id));
	const out: Backlink[] = [];
	for (const [from, entry] of index.entries) {
		if (from === target || !live.has(from)) continue;
		const link = entry.links.find((l) => resolveLink(l, notes) === target);
		if (link) out.push({ from, context: link.context });
	}
	return out;
}

/** Notes that name `target`'s title in their text without linking to it. */
export function unlinkedMentions(
	index: NotesIndex,
	target: NoteRef,
	notes: readonly NoteRef[]
): Mention[] {
	const live = new Set(notes.map((n) => n.id));
	const out: Mention[] = [];
	for (const [from, entry] of index.entries) {
		if (from === target.id || !live.has(from)) continue;
		if (entry.links.some((l) => resolveLink(l, notes) === target.id)) continue;
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
