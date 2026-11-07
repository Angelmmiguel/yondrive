/**
 * Notes as the screens see them: the folder of notes, the index, the list's
 * choices and reminders. It follows the drive of the session: attached when the
 * drive starts, stopped with it on a lock or sign-out, which ends the index and
 * zeroes its key. What is typed in its search stays on the device.
 */
import { LockedError } from '$lib/account/errors';
import { zero } from '$lib/crypto/random';
import type { Sealer } from '$lib/crypto/sealer';
import type { Drive } from '$lib/drive/drive';
import type { DriveNode } from '$lib/drive/tree';
import { indexedDbSegmentCache } from '$lib/search/cache';
import { tagCounts } from '$lib/notes/index';
import { NotesIndexer, sealedNotesCache, NOTE_READ_LIMIT } from '$lib/notes/indexer';
import {
	arrange,
	sectionCounts,
	type Chip,
	type NoteItem,
	type NoteSort,
	type Section
} from '$lib/notes/list';
import { describeDriveError } from '$lib/drive/errors';
import { MAX_IMAGE_BYTES } from '$lib/docs/images';
import { ImageUrls } from '$lib/notes/images';
import { buildItems, exportName, matchedIds } from '$lib/notes/items';
import { isNoteFile, marksNote, UNTITLED, type NoteMeta } from '$lib/notes/model';
import { Notes } from '$lib/notes/notes';
import {
	dueReminders,
	givenStore,
	nextReminder,
	reminderKey,
	type DueReminder
} from '$lib/notes/reminders';
import { search } from './search.svelte';
import { sharing } from './sharing.svelte';
import { toasts } from './toasts.svelte';

const VIEW_KEY = 'yondrive-notes-view';
const RECONCILE_MS = 300;
const REMINDER_CHECK_MS = 30_000;

export type NotesView = 'cards' | 'list';

/** A dialog of Notes, and what it is about. */
export type NotesDialog =
	| { kind: 'notebook'; node: DriveNode | null }
	| { kind: 'delete-notebook'; node: DriveNode }
	| { kind: 'reminder'; node: DriveNode };

function readView(): { view: NotesView; sort: NoteSort } {
	try {
		const stored = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Record<string, unknown>;
		return {
			view: stored.view === 'list' ? 'list' : 'cards',
			sort: stored.sort === 'created' || stored.sort === 'title' ? stored.sort : 'edited'
		};
	} catch {
		return { view: 'cards', sort: 'edited' };
	}
}

export class NotesState {
	/** Bumped when the index changes; the lists read it with the drive's. */
	rev = $state(0);
	rootId = $state<string | null>(null);
	failed = $state<string | null>(null);
	view = $state<NotesView>('cards');
	sort = $state<NoteSort>('edited');
	section = $state<Section>('all');
	notebook = $state<string | null>(null);
	tag = $state<string | null>(null);
	chips = $state.raw<readonly Chip[]>([]);
	/** Reminders given while the app was open, newest first, for the bell. */
	alerts = $state.raw<DueReminder[]>([]);
	/** The clock the lists read, moved on as reminders are checked. */
	now = $state(Date.now());
	dialog = $state.raw<NotesDialog | null>(null);
	exporting = $state(false);

	core: Notes | null = null;
	#drive: Drive | null = null;
	#indexer: NotesIndexer | null = null;
	#key: Uint8Array | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#reminderTimer: ReturnType<typeof setTimeout> | null = null;
	#given: ReturnType<typeof givenStore> | null = null;
	#userId = '';
	/** Pictures read from the drive, as object URLs, until the session ends. */
	#images: ImageUrls | null = null;

	/** Gives this drive its notes. Nothing is read until the tree is open. */
	attach(core: Drive, sealer: Sealer, masterKey: Uint8Array, userId: string): void {
		this.detach();
		const view = readView();
		this.view = view.view;
		this.sort = view.sort;
		this.#drive = core;
		this.core = new Notes({
			tree: core.tree,
			save: { tree: core.tree, engine: core.engine },
			read: async (node) => {
				const blob = await core.readBlob(node, await core.openVersion(node), {
					limit: NOTE_READ_LIMIT
				});
				return new Uint8Array(await blob.arrayBuffer());
			}
		});
		const key = sealer.indexKey(masterKey);
		this.#key = key;
		this.#indexer = new NotesIndexer({
			cache: sealedNotesCache(indexedDbSegmentCache(userId, 'yondrive-notes'), sealer, key),
			read: async (id) => {
				const node = core.tree.nodes.get(id);
				return node === undefined ? null : this.core!.readText(node);
			},
			onchange: () => this.#bump()
		});
		this.#given = givenStore(userId);
		this.#userId = userId;
		this.#images = new ImageUrls(async (id) => {
			const node = await core.tree.resolve(id);
			if (node.currentVersion === null || node.size > MAX_IMAGE_BYTES) return null;
			const blob = await core.readBlob(node, await core.openVersion(node), {
				limit: MAX_IMAGE_BYTES
			});
			return new Uint8Array(await blob.arrayBuffer());
		});
	}

	/** The tree is open: finds the folder of notes and starts the index and reminders. */
	start(): void {
		void this.#indexer?.load().then(() => this.#bump());
		this.treeChanged();
		this.#checkReminders();
	}

	/** On a lock or sign-out. Returns what forgets this device's copy of the index, for a sign-out. */
	detach(): () => Promise<void> {
		const indexer = this.#indexer;
		indexer?.stop();
		const cache = this.#key;
		if (this.#timer !== null) clearTimeout(this.#timer);
		if (this.#reminderTimer !== null) clearTimeout(this.#reminderTimer);
		this.#timer = null;
		this.#reminderTimer = null;
		this.#indexer = null;
		this.#images?.clear();
		this.#images = null;
		this.#drive = null;
		this.core = null;
		this.rootId = null;
		this.failed = null;
		this.alerts = [];
		this.notebook = null;
		this.tag = null;
		this.section = 'all';
		this.chips = [];
		this.#given = null;
		if (cache !== null) zero(cache);
		this.#key = null;
		this.rev += 1;
		const userId = this.#userId;
		return () =>
			userId === ''
				? Promise.resolve()
				: indexedDbSegmentCache(userId, 'yondrive-notes')
						.clear()
						.catch(() => {});
	}

	#bump(): void {
		this.rev += 1;
	}

	/** The tree changed: the folder may have appeared, notes moved on. */
	treeChanged(): void {
		if (this.#drive === null) return;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.#reconcile();
		}, RECONCILE_MS);
	}

	#reconcile(): void {
		const core = this.core;
		const drive = this.#drive;
		if (core === null || drive === null) return;
		const root = core.root();
		if (root !== undefined) this.rootId = root.id;
		const nodes = this.#indexed();
		void this.#indexer?.reconcile(
			nodes.map((n) => ({ id: n.id, version: n.currentVersion, size: n.size }))
		);
		this.#scheduleReminders();
		this.#bump();
	}

	/** Makes the folder of notes if there is none yet; called when Notes is opened. */
	async ensureRoot(): Promise<string | null> {
		const core = this.core;
		if (core === null) return null;
		try {
			const root = await core.ensureRoot();
			this.rootId = root.id;
			return root.id;
		} catch (e) {
			this.failed = e instanceof LockedError ? null : 'Notes could not be opened.';
			return null;
		}
	}

	/** Notes the index should hold: this user's and those shared. */
	#indexed(): DriveNode[] {
		return [...this.#own().map((i) => i.node), ...this.#shared().map((i) => i.node)];
	}

	#own(): { node: DriveNode; notebook: DriveNode | null }[] {
		const root = this.rootId;
		if (this.core === null || root === null) return [];
		return this.core.all(root);
	}

	#shared(): { node: DriveNode; notebook: DriveNode | null }[] {
		const drive = this.#drive;
		if (drive === null) return [];
		const out: { node: DriveNode; notebook: DriveNode | null }[] = [];
		for (const id of drive.sharedTops()) {
			const node = drive.tree.nodes.get(id);
			if (node === undefined || node.trashedAt !== null || !marksNote(node)) continue;
			if (node.kind === 'file') out.push({ node, notebook: null });
			else
				for (const child of drive.tree.childrenOf(node.id)) {
					if (isNoteFile(child)) out.push({ node: child, notebook: node });
				}
		}
		return out;
	}

	/** Every note this user can reach, as the list draws them. Read with `drive.rev` and `rev`. */
	items(): NoteItem[] {
		void this.rev;
		const drive = this.#drive;
		if (drive === null) return [];
		const root = this.rootId;
		const folders =
			root === null || this.core === null
				? []
				: [...this.core.space(root), ...this.core.notebooks(root).map((n) => n.id)];
		return buildItems(
			drive.tree,
			folders,
			this.#own(),
			this.#shared(),
			this.#indexer?.index ?? null
		);
	}

	/** The index, for links and mentions. */
	get index() {
		void this.rev;
		return this.#indexer?.index ?? null;
	}

	/** Every folder of notes: two devices racing on first use make two. */
	#space(): Set<string> {
		const root = this.rootId;
		return new Set(root === null || this.core === null ? [] : this.core.space(root));
	}

	/** Notes in the trash: notes and notebooks of the folders of notes. */
	trashed(trash: readonly DriveNode[]): DriveNode[] {
		const space = this.#space();
		const tree = this.#drive?.tree;
		if (space.size === 0 || tree === undefined) return [];
		return trash.filter(
			(n) =>
				(isNoteFile(n) || n.kind === 'folder') &&
				n.parentId !== null &&
				(space.has(n.parentId) || space.has(tree.nodes.get(n.parentId)?.parentId ?? ''))
		);
	}

	notebooks(): DriveNode[] {
		void this.rev;
		const root = this.rootId;
		return root === null ? [] : (this.core?.notebooks(root) ?? []);
	}

	/** Tags in use, most used first. */
	tags(items: readonly NoteItem[]): { tag: string; count: number }[] {
		return tagCounts(items.filter((i) => !i.shared).map((i) => i.tags));
	}

	counts(items: readonly NoteItem[], trashed: number) {
		return sectionCounts(items, trashed, this.now);
	}

	/** The notes on screen. `matched` is what the search found, or null. */
	arranged(items: readonly NoteItem[], matched: ReadonlySet<string> | null): NoteItem[] {
		return arrange(items, {
			section: this.section,
			notebook: this.notebook,
			tag: this.tag,
			chips: this.chips,
			matched,
			sort: this.sort,
			now: this.now
		});
	}

	/** Notes whose words match, through the on-device search, plus titles typed so far. */
	async find(text: string, items: readonly NoteItem[]): Promise<Set<string>> {
		const hits = await search.find(text);
		return matchedIds(
			items,
			text,
			hits.map((h) => h.id)
		);
	}

	isNotesNode(node: DriveNode): boolean {
		const tree = this.#drive?.tree;
		if (tree === undefined) return false;
		for (const id of this.#space()) if (tree.isWithin(node.id, id)) return true;
		const shared = this.#shared();
		return shared.some((s) => s.node.id === node.id);
	}

	setView(view: NotesView): void {
		this.view = view;
		this.#saveView();
	}

	setSort(sort: NoteSort): void {
		this.sort = sort;
		this.#saveView();
	}

	#saveView(): void {
		try {
			localStorage.setItem(VIEW_KEY, JSON.stringify({ view: this.view, sort: this.sort }));
		} catch {
			// The view goes back to the default next time.
		}
	}

	toggleChip(chip: Chip): void {
		this.chips = this.chips.includes(chip)
			? this.chips.filter((c) => c !== chip)
			: [...this.chips, chip];
	}

	/** A note saved here: the index takes the text in hand. */
	saved(id: string, version: string, markdown: string): void {
		this.#indexer?.saved(id, version, markdown);
	}

	/** Reminders are this user's: one in a note shared with them was set by someone else. */
	#reminding() {
		return this.items()
			.filter((i) => !i.shared && !i.meta.archived)
			.map((i) => ({ id: i.id, title: i.title, reminder: i.meta.reminder }));
	}

	/** Gives what has come due, then waits for the next one, or half a minute. */
	#checkReminders(): void {
		const given = this.#given;
		if (given === null) return;
		this.now = Date.now();
		const due = dueReminders(this.#reminding(), this.now, given.load());
		for (const r of due) {
			given.add(reminderKey(r.id, r.at));
			this.alerts = [r, ...this.alerts].slice(0, 20);
			toasts.push('info', `Reminder: ${r.title}`, 0);
		}
		this.#scheduleReminders();
	}

	#scheduleReminders(): void {
		if (this.#given === null) return;
		if (this.#reminderTimer !== null) clearTimeout(this.#reminderTimer);
		const next = nextReminder(this.#reminding(), Date.now());
		const wait = next === null ? REMINDER_CHECK_MS : Math.min(REMINDER_CHECK_MS, next - Date.now());
		this.#reminderTimer = setTimeout(
			() => {
				this.#reminderTimer = null;
				this.#checkReminders();
			},
			Math.max(250, wait)
		);
	}

	/** Runs something of the person's, telling them if it fails. */
	async run<T>(action: (core: Notes, rootId: string) => Promise<T>): Promise<T | undefined> {
		const core = this.core;
		const root = this.rootId ?? (await this.ensureRoot());
		if (core === null || root === null) return undefined;
		try {
			const out = await action(core, root);
			this.treeChanged();
			return out;
		} catch (e) {
			toasts.push('danger', describeDriveError(e));
			return undefined;
		}
	}

	/** A new note in a notebook, or at the top. */
	newNote(
		folder: string | null,
		title = UNTITLED,
		markdown = '',
		meta: Partial<NoteMeta> = {}
	): Promise<DriveNode | undefined> {
		return this.run((core, root) => core.createNote(folder ?? root, title, markdown, meta));
	}

	/** Every note as a ZIP of Markdown files, built here and saved by the browser. */
	async exportAll(): Promise<void> {
		if (this.exporting) return;
		this.exporting = true;
		try {
			const bytes = await this.run((core, root) => core.exportAll(root));
			if (bytes === undefined) return;
			const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = exportName(Date.now());
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} finally {
			this.exporting = false;
		}
	}

	/**
	 * A picture of the drive to draw, by id: read and checked to be a type the browser may
	 * draw from its bytes, never from its name. Null for anything else.
	 */
	imageUrl(id: string): Promise<string | null> {
		return this.#images?.url(id) ?? Promise.resolve(null);
	}

	dismissAlert(id: string): void {
		this.alerts = this.alerts.filter((a) => a.id !== id);
	}

	/** Whether shares have been read; the Shared section waits for them. */
	get sharedLoaded(): boolean {
		return sharing.sharedLoaded;
	}
}

export const notes = new NotesState();
