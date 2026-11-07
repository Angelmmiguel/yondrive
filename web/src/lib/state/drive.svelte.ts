/**
 * The drive as the screens see it. It owns one `Drive` per unlocked session and
 * turns its changes into reactive state. A lock or sign-out ends the session of the
 * app shell, whose effect calls `stop`, and that zeroes everything the drive holds.
 */
import { LockedError } from '$lib/account/errors';
import { registerDocumentText } from '$lib/docs/search-text';
import { registerSheetText } from '$lib/sheets/search-text';
import { editorFor, editorPath } from '$lib/drive/editors';
import { viewerFor } from '$lib/drive/viewers/kinds';
import { api } from '$lib/api/client';
import { isApiError, type Storage } from '$lib/api/types';
import { categoryOf, fileKindOf, type Category } from '$lib/drive/kinds';
import { describeDriveError } from '$lib/drive/errors';
import { BLOB_LIMIT, Drive, type StrayUpload } from '$lib/drive/drive';
import { createFramePool } from '$lib/drive/frame-pool';
import type { TagDefinition } from '$lib/drive/metadata';
import { createNodeOpener } from '$lib/drive/node-opener';
import { sortNodes, type KindFilter, type SortKey } from '$lib/drive/sort';
import { canStream, createStreamClient, registerStreamWorker } from '$lib/drive/stream/client';
import type { DriveNode } from '$lib/drive/tree';
import { fromDrop, fromInput, type Picked } from '$lib/drive/upload/pick';
import type { UploadItem } from '$lib/drive/upload/queue';
import { defaultResumeStore } from '$lib/drive/upload/resume';
import { localPinStorage } from '$lib/sharing/contacts';
import { canWrite } from '$lib/sharing/roles';
import { localRotationJobs } from '$lib/sharing/rotation';
import { formatBytes } from '$lib/app/format';
import { notesSubtree } from '$lib/notes/items';
import { isNotesRoot, marksNote } from '$lib/notes/model';
import { notes } from './notes.svelte';
import { search } from './search.svelte';
import { session } from './session.svelte';
import { sharing } from './sharing.svelte';
import { toasts } from './toasts.svelte';

const VIEW_KEY = 'yondrive-drive-view';

// Documents and spreadsheets are searched by their text, read on the device like any other file's.
registerDocumentText();
registerSheetText();
const POLL_MS = 60_000;

export type ViewMode = 'list' | 'grid';

/** A dialog of the shell, and what it is about. */
export type DriveDialog =
	| { kind: 'new-folder'; parentId: string }
	| { kind: 'rename'; node: DriveNode }
	| { kind: 'move'; nodes: DriveNode[] }
	| { kind: 'tags'; nodes: DriveNode[] }
	| { kind: 'new-tag' }
	| { kind: 'purge'; node: DriveNode }
	| { kind: 'share'; node: DriveNode }
	| { kind: 'empty-trash' };

function readView(): { mode: ViewMode; sort: SortKey } {
	try {
		const stored = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Record<string, unknown>;
		return {
			mode: stored.mode === 'grid' ? 'grid' : 'list',
			sort: stored.sort === 'name' || stored.sort === 'size' ? stored.sort : 'modified'
		};
	} catch {
		return { mode: 'list', sort: 'modified' };
	}
}

/** Starts the browser's download of a stream: the response is an attachment, so the frame stays empty. */
function saveUrl(url: string): void {
	const frame = document.createElement('iframe');
	frame.hidden = true;
	frame.src = url;
	document.body.append(frame);
	setTimeout(() => frame.remove(), 10 * 60 * 1000);
}

function saveBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export class DriveState {
	/** Bumped on every change to the tree: the lists below read it. */
	rev = $state(0);
	status = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle');
	error = $state<string | null>(null);
	uploads = $state.raw<UploadItem[]>([]);
	/** Uploads the server holds that this tab has nothing to do with. */
	strays = $state.raw<StrayUpload[]>([]);
	storage = $state.raw<Storage | null>(null);
	lastBackup = $state.raw<string | null>(null);
	/** The trash of Drive: what is in the trash outside of Notes. */
	trash = $state.raw<DriveNode[]>([]);
	/** Everything in the trash, notes included, for Notes to pick its own from. */
	allTrash = $state.raw<DriveNode[]>([]);
	trashLoaded = $state(false);
	/** Where an upload goes from here, set by the folder on screen. */
	folder = $state<string | null>(null);
	viewMode = $state<ViewMode>('list');
	sort = $state<SortKey>('modified');
	filter = $state<KindFilter>('all');
	viewing = $state.raw<DriveNode | null>(null);
	versionsOf = $state.raw<DriveNode | null>(null);
	dialog = $state.raw<DriveDialog | null>(null);

	core: Drive | null = null;
	#stops: (() => void)[] = [];
	#bump = false;
	#pollRunning = false;

	/** Starts the drive of the session that is open. */
	start(): void {
		const { sealer, account } = session;
		if (this.core !== null || sealer === null || account === null) return;
		const view = readView();
		this.viewMode = view.mode;
		this.sort = view.sort;
		const opener = createNodeOpener(sealer);
		const core = new Drive({
			api,
			sealer,
			keys: () => {
				if (session.keys === null) throw new LockedError();
				return session.keys;
			},
			userId: () => account.user.id,
			open: opener.open,
			pool: createFramePool(sealer),
			resume: defaultResumeStore(),
			streams: createStreamClient(sealer, (integrity) =>
				toasts.push(
					'danger',
					integrity
						? 'This download stopped because part of it failed its integrity check. It may be damaged or may have been changed on the server.'
						: 'This download stopped before it finished.',
					0
				)
			),
			saveUrl,
			saveBlob,
			pins: localPinStorage(account.user.id),
			rotationJobs: localRotationJobs(account.user.id),
			onResumeRotation: (progress) => sharing.track(progress),
			onCommitted: (node, blob) => search.fileCommitted(node.id, blob)
		});
		this.core = core;
		sharing.attach(core.sharing);
		if (session.keys !== null) {
			search.attach(core, sealer, session.keys.masterKey, account.user.id);
			notes.attach(core, sealer, session.keys.masterKey, account.user.id);
		}
		this.#stops.push(() => opener.stop());
		core.tree.onchange = () => {
			this.#changed();
			search.treeChanged();
			notes.treeChanged();
		};
		core.queue.onchange = () => {
			const wasActive = this.uploads.some((i) => i.status === 'uploading');
			this.uploads = core.queue.items;
			if (wasActive && !core.queue.active) {
				void this.refreshStorage();
				void this.refreshStrays();
			}
		};
		this.status = 'loading';
		registerStreamWorker();
		void core
			.start()
			.then(() => {
				if (this.core !== core) return;
				this.status = 'ready';
				search.start();
				notes.start();
				void sharing.sync();
				void this.refreshStorage();
				void this.loadTrash().catch(() => {});
				void this.refreshStrays();
				if (account.user.role === 'admin') void this.#loadBackup();
			})
			.catch((e) => {
				if (this.core !== core) return;
				this.status = 'failed';
				this.error = this.#message(e);
			});

		const poll = () => void this.poll();
		const timer = setInterval(poll, POLL_MS);
		window.addEventListener('focus', poll);
		this.#stops.push(() => {
			clearInterval(timer);
			window.removeEventListener('focus', poll);
		});
	}

	/** On a lock or sign-out: nothing of the drive stays in memory. */
	stop(): void {
		for (const stop of this.#stops) stop();
		this.#stops = [];
		sharing.detach();
		const forget = search.detach();
		const forgetNotes = notes.detach();
		// This runs as an effect's teardown, which reads the state from before: a moment
		// later the session says what really happened.
		queueMicrotask(() => {
			if (session.status === 'signed-out') {
				void forget();
				void forgetNotes();
			}
		});
		this.core?.stop();
		this.core = null;
		this.status = 'idle';
		this.error = null;
		this.uploads = [];
		this.strays = [];
		this.storage = null;
		this.lastBackup = null;
		this.trash = [];
		this.allTrash = [];
		this.trashLoaded = false;
		this.folder = null;
		this.viewing = null;
		this.versionsOf = null;
		this.dialog = null;
		this.rev += 1;
	}

	#changed(): void {
		if (this.#bump) return;
		this.#bump = true;
		queueMicrotask(() => {
			this.#bump = false;
			this.rev += 1;
		});
	}

	#message(e: unknown): string {
		if (isApiError(e, 'unauthorized')) session.signedOut();
		sharing.warn(e);
		return describeDriveError(e);
	}

	/** Runs an action of the person's, telling them if it fails. */
	async run<T>(action: (core: Drive) => Promise<T>): Promise<T | undefined> {
		const core = this.core;
		if (core === null) return undefined;
		try {
			const result = await action(core);
			return result;
		} catch (e) {
			toasts.push('danger', this.#message(e));
			return undefined;
		}
	}

	/** Whether what is on screen can be added to. */
	get canAddHere(): boolean {
		void this.rev;
		const id = this.folder ?? this.rootId;
		const node = id === null ? undefined : this.core?.tree.nodes.get(id);
		return node === undefined || canWrite(node);
	}

	get rootId(): string | null {
		void this.rev;
		return this.core?.tree.rootId ?? null;
	}

	node(id: string): DriveNode | undefined {
		void this.rev;
		return this.core?.tree.nodes.get(id);
	}

	/** A folder's children. At the root, the folder of notes stays out: Notes shows it. */
	children(id: string): DriveNode[] {
		void this.rev;
		const all = this.core?.tree.childrenOf(id) ?? [];
		return id === this.rootId ? all.filter((n) => !isNotesRoot(n)) : all;
	}

	/** Whether a node is in the folder of notes, which Drive's lists leave to Notes. */
	inNotes(id: string): boolean {
		return this.core?.tree.breadcrumbs(id).some(isNotesRoot) ?? false;
	}

	folderLoaded(id: string): boolean {
		void this.rev;
		return this.core?.tree.isLoaded(id) ?? false;
	}

	#live(): DriveNode[] {
		void this.rev;
		const tree = this.core?.tree;
		if (tree === undefined) return [];
		const hidden = notesSubtree(tree);
		return tree.live().filter((n) => !hidden.has(n.id));
	}

	get tags(): TagDefinition[] {
		void this.rev;
		return this.core?.tree.tags ?? [];
	}

	get favorites(): DriveNode[] {
		return this.#live().filter((n) => n.favorite);
	}

	/** Files, last changed first. */
	recent(limit: number): DriveNode[] {
		return this.#live()
			.filter((n) => n.kind === 'file')
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, limit);
	}

	tagged(tagId: string): DriveNode[] {
		return this.#live().filter((n) => n.tags.includes(tagId));
	}

	tagCount(tagId: string): number {
		return this.tagged(tagId).length;
	}

	/** Bytes of each kind of file, from what this device can read. */
	get categories(): Record<Category, number> {
		const totals: Record<Category, number> = { images: 0, video: 0, documents: 0, other: 0 };
		for (const node of this.#live()) {
			if (node.kind === 'file') totals[categoryOf(node)] += node.size;
		}
		return totals;
	}

	/** Applies the sort and the kind filter of the list on screen. */
	arrange(nodes: readonly DriveNode[]): DriveNode[] {
		return sortNodes(
			nodes.filter((node) => {
				switch (this.filter) {
					case 'all':
						return true;
					case 'folders':
						return node.kind === 'folder';
					case 'images':
						return fileKindOf(node) === 'image';
					case 'video':
						return fileKindOf(node) === 'video';
					case 'documents':
						return ['doc', 'sheet', 'note', 'pdf'].includes(fileKindOf(node));
					default:
						return node.kind === 'file' && fileKindOf(node) === 'other';
				}
			}),
			this.sort
		);
	}

	setView(mode: ViewMode): void {
		this.viewMode = mode;
		this.#saveView();
	}

	setSort(sort: SortKey): void {
		this.sort = sort;
		this.#saveView();
	}

	#saveView(): void {
		try {
			localStorage.setItem(VIEW_KEY, JSON.stringify({ mode: this.viewMode, sort: this.sort }));
		} catch {
			// Without storage the view goes back to the default next time.
		}
	}

	async refreshStorage(): Promise<void> {
		try {
			this.storage = await api.getMyStorage();
		} catch {
			// The bar keeps what it last knew.
		}
	}

	/** Finds uploads nothing here is carrying on with. Idle tabs are the ones that can tell. */
	async refreshStrays(): Promise<void> {
		const core = this.core;
		if (core === null || core.queue.active) return;
		try {
			const strays = await core.strayUploads();
			if (this.core === core) this.strays = strays;
		} catch {
			// The panel keeps what it last knew.
		}
	}

	/** Gives up an upload found on the server. */
	async abortStray(upload: StrayUpload): Promise<void> {
		await this.run((core) => core.abortStray(upload));
		await this.refreshStrays();
		await this.refreshStorage();
	}

	async #loadBackup(): Promise<void> {
		try {
			this.lastBackup = (await api.getAdminHealth()).last_backup_at ?? null;
		} catch {
			this.lastBackup = null;
		}
	}

	async loadTrash(): Promise<void> {
		if (this.core === null) return;
		const all = await this.core.tree.listTrash();
		this.allTrash = all;
		this.trash = all.filter((n) => !this.inNotes(n.id));
		this.trashLoaded = true;
	}

	/** Reads the journal, on focus and once a minute. Only one at a time. */
	async poll(): Promise<void> {
		const core = this.core;
		if (core === null || this.status !== 'ready' || this.#pollRunning) return;
		this.#pollRunning = true;
		try {
			if (await core.poll()) {
				search.treeChanged();
				await sharing.sync();
				await this.refreshStorage();
				await this.loadTrash();
			}
		} catch (e) {
			if (isApiError(e, 'unauthorized')) session.signedOut();
			// Anything else: the next poll will catch up, as the cursor did not move.
		} finally {
			this.#pollRunning = false;
		}
	}

	/** Puts what was picked into the queue, for this folder. */
	upload(picked: Picked, parentId: string | null = this.folder ?? this.rootId): void {
		const core = this.core;
		if (core === null || parentId === null) return;
		const target = core.tree.nodes.get(parentId);
		if (target !== undefined && !canWrite(target)) {
			toasts.push('info', 'You can only view this folder, so nothing can be added to it.');
			return;
		}
		if (picked.folders.length > 0) {
			void core.queue.addFolders(parentId, picked.folders).catch((e) => {
				toasts.push('danger', this.#message(e));
			});
		}
		if (picked.files.length > 0) core.queue.addFiles(parentId, picked.files);
	}

	uploadInput(files: FileList | null, parentId?: string | null): void {
		if (files !== null && files.length > 0) this.upload(fromInput(files), parentId);
	}

	async uploadDrop(transfer: DataTransfer): Promise<void> {
		this.upload(await fromDrop(transfer));
	}

	/** Downloads, saying so when it has to go through memory. */
	async download(node: DriveNode, versionId?: string): Promise<void> {
		let notice: number | null = null;
		if (!canStream()) {
			notice = toasts.push(
				'info',
				`This connection is not secure, so the file is held in memory while it downloads, up to ${formatBytes(BLOB_LIMIT)}.`,
				0
			);
		}
		await this.run((core) => core.download(node, versionId));
		if (notice !== null) toasts.dismiss(notice);
	}

	/**
	 * Shows a file: in the viewer if there is one for it, otherwise in its editor.
	 * Plain text, Markdown, CSV and TSV have both, and `edit` takes them there.
	 */
	open(node: DriveNode): void {
		if (viewerFor(node) === null && editorFor(node.name) !== null) this.edit(node);
		else this.viewing = node;
	}

	edit(node: DriveNode): void {
		const kind = editorFor(node.name);
		if (kind === null) return;
		this.viewing = null;
		// A note, such as one shared on its own, opens in Notes.
		const path =
			kind === 'doc' && (marksNote(node) || this.inNotes(node.id))
				? (`/notes/${node.id}` as const)
				: editorPath(kind, node.id);
		// Loaded when needed, so that this module stays free of the router.
		void Promise.all([import('$app/navigation'), import('$app/paths')]).then(([nav, paths]) =>
			nav.goto(paths.resolve(path))
		);
	}

	/** Takes a tag off the list. */
	async deleteTag(id: string): Promise<void> {
		await this.run((core) => core.tree.deleteTag(id));
	}
}

export const drive = new DriveState();
