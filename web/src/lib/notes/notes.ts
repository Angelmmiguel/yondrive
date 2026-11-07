/**
 * Notes on top of the drive: the hidden folder that holds them, notebooks, and
 * notes as Markdown files with their own fields in sealed metadata. Everything is
 * an ordinary node, so versions, sharing, quota, the journal and both encryption
 * modes come with the drive, and nothing here reads the mode.
 */
import { isApiError } from '$lib/api/types';
import { markNew } from '$lib/editing/fresh';
import { createWith, saveVersion, type SaveDeps } from '$lib/editing/save';
import { rawMetadata } from '$lib/drive/metadata';
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
import { buildExport, type ExportFile, type ExportNote } from './export';
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

/** The note a file is kept beside, if it is a picture or attachment of one. */
const ownerOf = (node: DriveNode): unknown => rawMetadata(node.raw.attachment).note;

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

	/**
	 * Every folder of notes, oldest first. Two devices racing on first use make two,
	 * and Drive hides them all, so all of them are the notes; new ones go in the oldest.
	 */
	roots(): DriveNode[] {
		const rootId = this.#tree.rootId;
		if (rootId === null) return [];
		return this.#tree.childrenOf(rootId).filter(isNotesRoot).sort(byOldest);
	}

	/** The folder of notes new notes go in: the oldest, if the root's list has one. */
	root(): DriveNode | undefined {
		return this.roots()[0];
	}

	/** The folders whose notes and notebooks are this user's notes: `rootId` and any other folder of notes. */
	space(rootId: string): string[] {
		return [rootId, ...this.roots().map((r) => r.id)].filter((id, i, all) => all.indexOf(id) === i);
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

	/** Notebooks: the folders in the folders of notes. */
	notebooks(rootId: string): DriveNode[] {
		return this.space(rootId)
			.flatMap((id) => this.#tree.childrenOf(id))
			.filter((n) => n.kind === 'folder')
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** The notes of one folder. */
	notesIn(folderId: string): DriveNode[] {
		return this.#tree.childrenOf(folderId).filter(isNoteFile);
	}

	/** Every note of this user's, with the notebook it is in (null at the top). */
	all(rootId: string): { node: DriveNode; notebook: DriveNode | null }[] {
		const out = this.space(rootId).flatMap((id) =>
			this.notesIn(id).map((node) => ({ node, notebook: null as DriveNode | null }))
		);
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

	/** The pictures and files kept beside a note for it, in the folder it is in. */
	attachmentsOf(noteId: string): DriveNode[] {
		const folder = this.#tree.nodes.get(noteId)?.parentId;
		if (folder == null) return [];
		return this.attachmentsIn(folder).filter((n) => ownerOf(n) === noteId);
	}

	/** Moves a note, and what is kept beside it for it, so its pictures go where it goes. */
	async move(id: string, folderId: string): Promise<DriveNode> {
		const files = this.attachmentsOf(id);
		const moved = await this.#tree.move(id, folderId);
		for (const file of files) await this.#moveNumbered(file, folderId);
		return moved;
	}

	/** Moves a file, numbering its name if the folder already has one like it. */
	async #moveNumbered(file: DriveNode, folderId: string): Promise<void> {
		for (let n = 1; ; n++) {
			try {
				if (n > 1) await this.#tree.rename(file.id, numbered(file.name, n));
				await this.#tree.move(file.id, folderId);
				return;
			} catch (e) {
				if (!isApiError(e, 'name_conflict') || n >= 50) throw e;
			}
		}
	}

	/** Puts a note in the trash with what is kept beside it for it. */
	async trashNote(id: string): Promise<void> {
		const files = this.attachmentsOf(id);
		await this.#tree.trash(id);
		for (const file of files) await this.#tree.trash(file.id);
	}

	/** Takes a note or notebook out of the trash with what went there with it, as `trash` lists it. */
	async restore(id: string, trash: readonly DriveNode[]): Promise<DriveNode> {
		const restored = await this.#tree.restore(id);
		for (const file of trash) if (ownerOf(file) === id) await this.#tree.restore(file.id);
		return restored;
	}

	/** Deletes a note or notebook for good, with what went to the trash with it. */
	async purge(id: string, trash: readonly DriveNode[]): Promise<void> {
		await this.#tree.purge(id);
		for (const file of trash) if (ownerOf(file) === id) await this.#tree.purge(file.id);
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

	/** A file's bytes, such as an attachment's. */
	readBytes(node: DriveNode): Promise<Uint8Array> {
		return this.#deps.read(node);
	}

	/** Every note and every file beside them, as a ZIP of plain Markdown with links intact. */
	async exportAll(rootId: string): Promise<Uint8Array> {
		const notes: ExportNote[] = [];
		const files: ExportFile[] = [];
		const folders: { id: string; folder: string }[] = [
			...this.space(rootId).map((id) => ({ id, folder: '' })),
			...this.notebooks(rootId).map((nb) => ({ id: nb.id, folder: nb.name }))
		];
		for (const { id, folder } of folders) {
			for (const node of this.notesIn(id)) {
				notes.push({ id: node.id, folder, name: node.name, markdown: await this.readText(node) });
			}
			for (const node of this.attachmentsIn(id)) {
				if (node.currentVersion === null) continue;
				// Left behind by a note trashed before its files went with it.
				const owner = ownerOf(node);
				if (typeof owner === 'string' && this.#tree.nodes.get(owner)?.trashedAt != null) continue;
				files.push({ id: node.id, folder, name: node.name, bytes: await this.readBytes(node) });
			}
		}
		return buildExport(notes, files);
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
