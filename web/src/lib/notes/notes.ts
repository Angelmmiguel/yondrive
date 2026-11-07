/**
 * Notes on top of the drive: the hidden folder that holds them, notebooks, and
 * notes as Markdown files with their own fields in sealed metadata. Everything is
 * an ordinary node, so versions, sharing, quota, the journal and both encryption
 * modes come with the drive, and nothing here reads the mode.
 */
import { isApiError } from '$lib/api/types';
import { markNew } from '$lib/editing/fresh';
import { createWith, saveVersion, type SaveDeps } from '$lib/editing/save';
import type { DriveNode, DriveTree } from '$lib/drive/tree';
import { numbered } from '$lib/editing/save';
import {
	dailyTitle,
	dayKey,
	fileNameOf,
	isNoteFile,
	isNotesRoot,
	JOURNAL,
	nextColor,
	NOTES_APP,
	NOTES_FOLDER_NAME,
	noteMetaPatch,
	notebookPatch,
	parseNoteMeta,
	sameTitle,
	titleOf,
	type NoteMeta,
	type NotebookColor
} from './model';
import { linkMention } from './parse';
import { BUILTIN_TEMPLATES, fillTemplate } from './templates';

export interface NotesDeps {
	tree: DriveTree;
	save: SaveDeps;
	/** A file's current bytes. */
	read(node: DriveNode): Promise<Uint8Array>;
	now?: () => number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Tries names until one is free: `Title.md`, `Title (2).md` and on. */
async function withFreeName<T>(name: string, attempt: (name: string) => Promise<T>): Promise<T> {
	for (let n = 1; ; n++) {
		try {
			return await attempt(n === 1 ? name : numbered(name, n));
		} catch (e) {
			if (!isApiError(e, 'name_conflict') || n >= 50) throw e;
		}
	}
}

const byOldest = (a: DriveNode, b: DriveNode) => a.created - b.created || (a.id < b.id ? -1 : 1);

export class Notes {
	readonly #deps: NotesDeps;
	#making: Promise<DriveNode> | null = null;

	constructor(deps: NotesDeps) {
		this.#deps = deps;
	}

	get #tree(): DriveTree {
		return this.#deps.tree;
	}

	#now(): number {
		return this.#deps.now?.() ?? Date.now();
	}

	/** The folder of notes, if the root's list has one. Two devices racing make two: the oldest wins. */
	root(): DriveNode | undefined {
		const rootId = this.#tree.rootId;
		if (rootId === null) return undefined;
		return this.#tree.childrenOf(rootId).filter(isNotesRoot).sort(byOldest)[0];
	}

	/** The folder of notes, made on first use. */
	async ensureRoot(): Promise<DriveNode> {
		const found = this.root();
		if (found !== undefined) return found;
		this.#making ??= (async () => {
			const rootId = this.#tree.rootId;
			if (rootId === null) throw new Error('the drive is not open');
			await this.#tree.loadFolder(rootId, true);
			const again = this.root();
			if (again !== undefined) return again;
			return withFreeName(NOTES_FOLDER_NAME, (name) =>
				this.#tree.createFolder(rootId, name, { app: NOTES_APP })
			);
		})().finally(() => (this.#making = null));
		return this.#making;
	}

	/** Notebooks: the folders in the folder of notes. */
	notebooks(rootId: string): DriveNode[] {
		return this.#tree
			.childrenOf(rootId)
			.filter((n) => n.kind === 'folder')
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** The notes of one folder. */
	notesIn(folderId: string): DriveNode[] {
		return this.#tree.childrenOf(folderId).filter(isNoteFile);
	}

	/** Every note of this user's, with the notebook it is in (null at the top). */
	all(rootId: string): { node: DriveNode; notebook: DriveNode | null }[] {
		const out = this.notesIn(rootId).map((node) => ({ node, notebook: null as DriveNode | null }));
		for (const nb of this.notebooks(rootId)) {
			for (const node of this.notesIn(nb.id)) out.push({ node, notebook: nb });
		}
		return out;
	}

	/** Files kept beside notes: pictures and attachments. */
	attachmentsIn(folderId: string): DriveNode[] {
		return this.#tree.childrenOf(folderId).filter((n) => n.kind === 'file' && !isNoteFile(n));
	}

	async createNotebook(rootId: string, name: string, color?: NotebookColor): Promise<DriveNode> {
		const count = this.notebooks(rootId).length;
		return this.#tree.createFolder(rootId, name, {
			notebook: { color: color ?? nextColor(count) }
		});
	}

	recolorNotebook(id: string, color: NotebookColor): Promise<DriveNode> {
		const node = this.#tree.nodes.get(id);
		return this.#tree.patch(id, notebookPatch(node?.raw ?? {}, color));
	}

	renameNotebook(id: string, name: string): Promise<DriveNode> {
		return this.#tree.rename(id, name);
	}

	/** A note: its file made with the first version in one go, so it never shows empty. */
	async createNote(
		folderId: string,
		title: string,
		markdown = '',
		meta: Partial<NoteMeta> = {}
	): Promise<DriveNode> {
		const bytes = encoder.encode(markdown);
		const made = await createWith(this.#deps.save, folderId, fileNameOf(title), bytes, {
			note: { ...meta }
		});
		markNew(made.id);
		return made;
	}

	/** Gives a note a new title, numbered if another note in its notebook has it. */
	async renameNote(id: string, title: string): Promise<DriveNode> {
		const node = this.#tree.nodes.get(id);
		if (node !== undefined && sameTitle(titleOf(node.name), title.trim())) return node;
		return withFreeName(fileNameOf(title), (name) => this.#tree.rename(id, name));
	}

	setMeta(id: string, meta: Partial<NoteMeta>): Promise<DriveNode> {
		const node = this.#tree.nodes.get(id);
		return this.#tree.patch(id, noteMetaPatch(node?.raw ?? {}, meta));
	}

	meta(node: DriveNode): NoteMeta {
		return parseNoteMeta(node.raw);
	}

	move(id: string, folderId: string): Promise<DriveNode> {
		return this.#tree.move(id, folderId);
	}

	async readText(node: DriveNode): Promise<string> {
		if (node.currentVersion === null) return '';
		return decoder.decode(await this.#deps.read(node));
	}

	/** Saves Markdown over the version this device last saw; a conflict is the caller's. */
	async writeText(node: DriveNode, markdown: string, expected: string): Promise<string> {
		const saved = await saveVersion(this.#deps.save, node, encoder.encode(markdown), expected);
		return saved.version;
	}

	/** A picture or a file kept beside a note, which the note names by id. */
	async attach(
		folderId: string,
		name: string,
		bytes: Uint8Array,
		noteId: string
	): Promise<DriveNode> {
		return createWith(this.#deps.save, folderId, name, bytes, { attachment: { note: noteId } });
	}

	/** Today's daily note: found by its day, or made in the Journal notebook. */
	async todayNote(rootId: string): Promise<DriveNode> {
		const today = dayKey(new Date(this.#now()));
		const found = this.all(rootId).find(
			({ node }) => node.trashedAt === null && this.meta(node).daily === today
		);
		if (found !== undefined) return found.node;
		let journal = this.notebooks(rootId).find((nb) => sameTitle(nb.name, JOURNAL));
		journal ??= await withFreeName(JOURNAL, (name) => this.createNotebook(rootId, name, 'amber'));
		const daily = BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:daily');
		const now = new Date(this.#now());
		const title = dailyTitle(now);
		return this.createNote(journal.id, title, fillTemplate(daily?.body ?? '', { title, now }), {
			daily: today
		});
	}

	/** Turns a plain mention of `title` in another note into a link. Whether there was one. */
	async linkMention(from: DriveNode, title: string, targetId: string): Promise<boolean> {
		const text = await this.readText(from);
		const next = linkMention(text, title, targetId);
		if (next === null || from.currentVersion === null) return false;
		await this.writeText(from, next, from.currentVersion);
		return true;
	}
}
