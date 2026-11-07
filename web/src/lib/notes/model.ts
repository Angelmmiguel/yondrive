/**
 * What makes a node part of Notes, read from its sealed metadata the same way in
 * both modes. Notes are Markdown files in one folder under the user's root, which
 * the Drive views leave out; notebooks are the folders directly inside it. The
 * fields here sit beside the drive's own, under keys of their own, and anything
 * that is missing or of the wrong type reads as the default.
 */
import { rawMetadata, type RawMetadata } from '$lib/drive/metadata';
import { MAX_NAME_LENGTH } from '$lib/drive/names';
import { normalizeName } from '$lib/crypto/metadata';

/** The value of `app` on the folder that holds every note. */
export const NOTES_APP = 'notes';
export const NOTES_FOLDER_NAME = 'Notes';
export const NOTE_EXTENSION = '.md';
export const UNTITLED = 'Untitled note';
/** The notebook daily notes go in, made when the first one is. */
export const JOURNAL = 'Journal';
/** The notebook whose notes are offered as templates. */
export const TEMPLATES = 'Templates';

export const NOTEBOOK_COLORS = ['blue', 'orange', 'green', 'violet', 'amber', 'rose'] as const;
export type NotebookColor = (typeof NOTEBOOK_COLORS)[number];

/** A note's own fields, kept in its metadata under `note`. */
export interface NoteMeta {
	pinned: boolean;
	archived: boolean;
	/** When to remind, in Unix milliseconds. Only an open app reminds. */
	reminder: number | null;
	/** Tags given in the editor; `#tags` in the text count as well. */
	tags: string[];
	/** The day of a daily note, `YYYY-MM-DD`. */
	daily: string | null;
}

export interface NodeLike {
	kind: 'file' | 'folder';
	name: string;
	raw: RawMetadata;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseNoteMeta(raw: RawMetadata): NoteMeta {
	const note = rawMetadata(raw.note);
	const reminder = note.reminder;
	return {
		pinned: note.pinned === true,
		archived: note.archived === true,
		reminder:
			typeof reminder === 'number' && Number.isFinite(reminder) && reminder > 0 ? reminder : null,
		tags: Array.isArray(note.tags)
			? [...new Set(note.tags.filter((t): t is string => typeof t === 'string').map(cleanTag))]
					.filter((t) => t !== '')
					.slice(0, 64)
			: [],
		daily: typeof note.daily === 'string' && DAY.test(note.daily) ? note.daily : null
	};
}

/** The metadata patch that writes `meta` back, keeping fields of `note` this client does not know. */
export function noteMetaPatch(raw: RawMetadata, meta: Partial<NoteMeta>): RawMetadata {
	return { note: { ...rawMetadata(raw.note), ...meta } };
}

export function notebookColor(raw: RawMetadata): NotebookColor {
	const nb = rawMetadata(raw.notebook);
	return NOTEBOOK_COLORS.find((c) => c === nb.color) ?? 'blue';
}

export function notebookPatch(raw: RawMetadata, color: NotebookColor): RawMetadata {
	return { notebook: { ...rawMetadata(raw.notebook), color } };
}

/** The colour for a new notebook, going round the palette. */
export function nextColor(count: number): NotebookColor {
	return NOTEBOOK_COLORS[count % NOTEBOOK_COLORS.length];
}

/** The folder that holds every note. */
export const isNotesRoot = (node: NodeLike): boolean =>
	node.kind === 'folder' && node.raw.app === NOTES_APP;

/** A note: a Markdown file. Inside the notes folder no mark is needed; a share carries one. */
export const isNoteFile = (node: NodeLike): boolean =>
	node.kind === 'file' && node.name.toLowerCase().endsWith(NOTE_EXTENSION);

/** Whether a shared node says it is a note or a notebook. */
export const marksNote = (node: NodeLike): boolean =>
	node.kind === 'file' ? 'note' in node.raw && isNoteFile(node) : 'notebook' in node.raw;

/** A note's title: its file name without `.md`. */
export function titleOf(name: string): string {
	return name.toLowerCase().endsWith(NOTE_EXTENSION) ? name.slice(0, -NOTE_EXTENSION.length) : name;
}

/** The file name of a title: what a name cannot hold becomes a dash, and `.md` goes on the end. */
export function fileNameOf(title: string): string {
	let t = title
		.replace(/[/\\\0]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
	if (t === '' || t === '.' || t === '..') t = UNTITLED;
	const room = MAX_NAME_LENGTH - NOTE_EXTENSION.length;
	if (t.length > room) t = t.slice(0, room).trimEnd();
	return `${t}${NOTE_EXTENSION}`;
}

/** Titles compare as names do: the same letters, whatever their case or composition. */
export const sameTitle = (a: string, b: string): boolean =>
	normalizeName(a.trim()) === normalizeName(b.trim());

/** A tag as kept: without its `#`, lower case, letters, digits, `-`, `_` and `/`. */
export function cleanTag(typed: string): string {
	return typed
		.trim()
		.replace(/^#+/, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_/-]+/gu, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A day as `YYYY-MM-DD`, in local time: the title and the key of a daily note. */
export function dayKey(when: Date): string {
	return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/** The title of the daily note of a day. The date itself, so it sorts and reads in any language. */
export const dailyTitle = (when: Date): string => dayKey(when);

/** Whether two times fall on the same local day. */
export const sameDay = (a: number, b: number): boolean =>
	dayKey(new Date(a)) === dayKey(new Date(b));
