<!--
  The note editor board: the rail, the notes of the notebook with a search, the
  note itself (title, notebook, tags, reminder, then the Markdown in the editor),
  and the Links and info panel. Saves are versions, after a pause, through the
  editors' shared session; someone else's save in between becomes a copy.
-->
<script lang="ts">
	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onDestroy, tick, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { EditorView } from 'prosemirror-view';
	import { api } from '$lib/api/client';
	import type { Editor } from '$lib/api/types';
	import { formatWhen } from '$lib/app/format';
	import { AppRail, Banner, Button, Icon, Menu, type MenuItem } from '$lib/components';
	import { insertImage, insertTable, setCallout, setStyle, toggleList } from '$lib/docs/commands';
	import { fromDoc, toDoc } from '$lib/docs/convert';
	import { ImageStore, redraw } from '$lib/docs/images';
	import { countWords } from '$lib/docs/words';
	import { describeDriveError } from '$lib/drive/errors';
	import { Presence } from '$lib/editing/presence';
	import { conflictName, createWith, saveVersion } from '$lib/editing/save';
	import { EditSession, type SaveStatus, type SessionFile } from '$lib/editing/session';
	import { writeDocument } from '$lib/formats/document';
	import { readMarkdown, writeMarkdown } from '$lib/formats/markdown';
	import type { NoteItem } from '$lib/notes/list';
	import {
		createNoteEditor,
		insertNodeLink,
		linkNode,
		pendingImages,
		refreshDecorations,
		replaceImageKey,
		runSlash,
		setText,
		type LinkKind,
		type Suggest
	} from '$lib/notes/editor';
	import { noteHtml, withoutNodes } from '$lib/notes/html';
	import {
		cleanTag,
		isNoteFile,
		notebookColor,
		sameTitle,
		TEMPLATES,
		titleOf,
		type NoteMeta
	} from '$lib/notes/model';
	import { nodeHref } from '$lib/notes/parse';
	import { PictureNotKeptError, PictureUploads } from '$lib/notes/pictures';
	import { canWrite, isOwner } from '$lib/sharing/roles';
	import { drive } from '$lib/state/drive.svelte';
	import { notes } from '$lib/state/notes.svelte';
	import { search } from '$lib/state/search.svelte';
	import { session as account } from '$lib/state/session.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import NoteSide from './NoteSide.svelte';
	import NotesDialogs from './NotesDialogs.svelte';

	interface Props {
		nodeId: string;
	}

	let { nodeId }: Props = $props();

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let problem = $state('');
	let fileId = $state(untrack(() => nodeId));
	let status = $state<SaveStatus>('saved');
	let saveError = $state('');
	let rev = $state(0);
	let words = $state(0);
	let others = $state.raw<Editor[]>([]);
	let othersDismissed = $state(false);
	let conflict = $state<{ copy: SessionFile; original: SessionFile } | null>(null);
	let mount = $state<HTMLElement>();
	let article = $state<HTMLElement>();
	let picker = $state<HTMLInputElement>();
	let view = $state.raw<EditorView | null>(null);
	let suggest = $state.raw<Suggest | null>(null);
	let active = $state(0);
	let titleDraft = $state('');
	let tagDraft = $state<string | null>(null);
	let listQuery = $state('');
	let tab = $state<'links' | 'info'>('links');
	let focus = $state(false);

	const narrow = new MediaQuery('max-width: 720px');
	let listOpen = $state(!narrow.current);
	let panelOpen = $state(!narrow.current);
	$effect(() => {
		if (narrow.current)
			untrack(() => {
				listOpen = false;
				panelOpen = false;
			});
	});

	let session: EditSession<'md'> | null = null;
	let original = '';
	let store: ImageStore | null = null;
	/** The document as it was when the screen closed, for saves that finish after. */
	let closedDoc: EditorView['state']['doc'] | null = null;
	/** Pictures pasted or picked go up as files beside the note, and the note names them by id. */
	const pictures = new PictureUploads({
		upload: async (key, alt) => {
			const folder = fileFolder;
			const core = notes.core;
			const img = store?.get(key);
			if (folder === null || core === null || img === undefined) throw new Error(NO_FOLDER);
			const ext = img.mime === 'image/jpeg' ? 'jpg' : 'png';
			const name = `${(alt || title || 'Picture').replace(/[/\\]/g, '-').slice(0, 80)}.${ext}`;
			return nodeHref((await core.attach(folder, name, img.bytes, fileId)).id);
		},
		onkept: (key, href) => {
			if (view) replaceImageKey(view, key, href);
		},
		onfailed: (e) =>
			toasts.push(
				'danger',
				`${e instanceof Error && !('code' in e) ? e.message : describeDriveError(e)} The picture stays in the note and is tried again when it is next saved.`
			)
	});

	const node = $derived(drive.node(fileId));
	const items = $derived.by(() => {
		void drive.rev;
		return notes.items();
	});
	const item = $derived(items.find((i) => i.id === fileId));
	const canEdit = $derived(node !== undefined && canWrite(node));
	const meta = $derived<NoteMeta | null>(item?.meta ?? null);
	const title = $derived(node ? titleOf(node.name) : '');
	const notebook = $derived(item?.notebook ?? null);
	const folderId = $derived(node?.parentId ?? null);
	/** Where pictures and files added here go: the note's folder, if this user can add to it. */
	const fileFolder = $derived.by(() => {
		const parent = folderId === null ? undefined : drive.node(folderId);
		return parent !== undefined && canWrite(parent) ? parent.id : null;
	});
	const NO_FOLDER =
		'Pictures and files cannot be added to this note: it was shared without a folder you can add to.';

	const presence = new Presence({
		api,
		onchange: (list) => {
			others = list;
			if (list.length === 0) othersDismissed = false;
		}
	});

	function saveDeps() {
		const core = drive.core;
		if (core === null) throw new Error('locked');
		return { tree: core.tree, engine: core.engine };
	}

	/** The Markdown as the editor has it now, once every picture in it has gone up as a file. */
	async function markdown(): Promise<string> {
		const before = closedDoc ?? view?.state.doc;
		if (before) pictures.start(pendingImages(before), true);
		await pictures.settle();
		const doc = closedDoc ?? view?.state.doc;
		if (!doc) throw new Error('The editor is closed.');
		// An empty note has nothing to keep: it is written as a new file, ending in a newline.
		return writeMarkdown(
			{ blocks: pictures.resolve(fromDoc(doc)), images: {} },
			original === '' ? undefined : original
		);
	}

	async function load() {
		phase = 'loading';
		problem = '';
		const core = drive.core;
		const notesCore = notes.core;
		if (core === null || notesCore === null) return;
		try {
			const found = await core.tree.resolve(fileId);
			if (!isNoteFile(found) || found.currentVersion === null)
				throw new Error('This note has nothing in it yet.');
			const text = await notesCore.readText(found);
			teardown();
			original = text;
			titleDraft = titleOf(found.name);
			store = new ImageStore();
			const opened = readMarkdown(text);
			session = new EditSession<'md'>(
				{
					save: async (file, bytes) => {
						const saved = await saveVersion(saveDeps(), file, bytes, file.version);
						const md = decoder.decode(bytes);
						notes.saved(saved.node.id, saved.version, md);
						search.fileCommitted(saved.node.id, new Blob([bytes as Uint8Array<ArrayBuffer>]));
						return saved.version;
					},
					copy: async (file, bytes) => {
						const here = drive.node(file.id);
						const parent = here?.parentId ? drive.node(here.parentId) : undefined;
						const folder =
							parent && canWrite(parent) ? parent.id : (notes.rootId ?? (drive.rootId as string));
						const who = account.account?.user.username ?? 'me';
						const made = await createWith(
							saveDeps(),
							folder,
							conflictName(here?.name ?? file.name, who, new Date()),
							bytes,
							{ note: { ...((here?.raw.note as object | undefined) ?? {}) } }
						);
						return { id: made.id, name: made.name, version: made.currentVersion ?? '' };
					},
					rename: async () => false,
					create: async () => {
						throw new Error('notes are not converted');
					},
					onstatus: (s, e) => {
						status = s;
						saveError =
							s !== 'failed'
								? ''
								: e instanceof PictureNotKeptError
									? e.message
									: describeDriveError(e);
					},
					onconflict: (copy) => {
						conflict = {
							copy,
							original: { id: found.id, name: found.name, version: found.currentVersion ?? '' }
						};
						toasts.push(
							'info',
							`Someone else saved this note first. Your changes are in a copy: ${titleOf(copy.name)}`,
							0
						);
					},
					onfile: (file) => {
						if (file.id !== fileId) {
							fileId = file.id;
							replaceState(resolve(`/notes/${file.id}`), {});
							presence.start(file.id, true);
						}
					}
				},
				{ id: found.id, name: found.name, version: found.currentVersion },
				{ original: 'md', saveAs: 'md' },
				async () => encoder.encode(await markdown())
			);
			phase = 'ready';
			await tick();
			if (mount === undefined) return;
			const s = store;
			view = createNoteEditor(mount, {
				doc: toDoc(opened.model),
				editable: () => canEdit,
				store: s,
				onUpdate: (v, changed) => {
					rev++;
					if (changed) {
						session?.changed();
						updateWordsSoon();
						uploadPending(v);
					}
				},
				onSave: () => void session?.flush(),
				onSuggest: (sg) => {
					suggest = sg;
					active = 0;
				},
				onSuggestKey: suggestKey,
				onOpenNode: openNode,
				kindOf,
				readImage: (id) => notes.imageUrl(id),
				onImageFailed: (e) =>
					toasts.push(
						'danger',
						e instanceof Error ? e.message : 'That picture could not be added.'
					),
				canAddPictures: () => fileFolder !== null,
				onPictureRefused: () => toasts.push('danger', NO_FOLDER)
			});
			updateWords();
			presence.start(found.id, canWrite(found));
			notes.saved(found.id, found.currentVersion, text);
		} catch (e) {
			phase = 'failed';
			problem = e instanceof Error && !('code' in e) ? e.message : describeDriveError(e);
		}
	}

	function teardown() {
		view?.destroy();
		view = null;
		store?.dispose();
		store = null;
	}

	$effect(() => {
		if (drive.status !== 'ready' || notes.core === null) return;
		untrack(() => {
			if (notes.rootId === null) void notes.ensureRoot();
			void load();
		});
	});

	// Someone saved elsewhere, or a version was restored: with nothing unsaved here, show it.
	$effect(() => {
		const current = node?.currentVersion;
		untrack(() => {
			if (phase !== 'ready' || !session || current == null) return;
			if (current !== session.file.version && !session.dirty && status === 'saved') void load();
		});
	});

	// Linked notes renamed, files arrived: the chips are drawn again.
	$effect(() => {
		void drive.rev;
		untrack(() => {
			if (view) refreshDecorations(view);
		});
	});

	$effect(() => {
		const e = canEdit;
		untrack(() => view?.setProps({ editable: () => e }));
	});

	onDestroy(() => {
		const s = session;
		closedDoc = view?.state.doc ?? null;
		presence.stop();
		void s?.close();
		if (wordTimer !== null) clearTimeout(wordTimer);
		teardown();
	});

	function beforeUnload(event: BeforeUnloadEvent) {
		if (session?.dirty) {
			void session.flush();
			event.preventDefault();
		}
	}

	let wordTimer: ReturnType<typeof setTimeout> | null = null;
	function updateWords() {
		if (wordTimer !== null) clearTimeout(wordTimer);
		wordTimer = null;
		words = view ? countWords(fromDoc(view.state.doc)) : 0;
	}
	function updateWordsSoon() {
		if (wordTimer !== null) clearTimeout(wordTimer);
		wordTimer = setTimeout(updateWords, 250);
	}

	function kindOf(id: string): LinkKind {
		const n = drive.node(id);
		if (n === undefined || n.trashedAt !== null) return 'missing';
		return isNoteFile(n) ? 'note' : 'file';
	}

	async function openNode(id: string) {
		await session?.flush();
		const target = drive.node(id) ?? (await drive.core?.tree.resolve(id).catch(() => undefined));
		if (target === undefined || target.trashedAt !== null) {
			toasts.push('info', 'This link points to something that is gone, or not shared with you.');
			return;
		}
		if (isNoteFile(target) && (notes.isNotesNode(target) || 'note' in target.raw)) {
			await goto(resolve(`/notes/${id}`));
		} else if (target.kind === 'folder') {
			await goto(resolve(`/files/${id}`));
		} else drive.open(target);
	}

	/** Sends up the pictures just added; one that failed waits for the next save. */
	function uploadPending(v: EditorView) {
		pictures.start(pendingImages(v.state.doc));
	}

	async function picked(event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = '';
		if (!file || !view || !store || !notes.core) return;
		const folder = fileFolder;
		if (folder === null) {
			toasts.push('danger', NO_FOLDER);
			return;
		}
		try {
			if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type)) {
				const img = await redraw(file);
				const key = store.add(img);
				const width = Math.min(img.width, 640);
				const height = Math.round((img.height * width) / img.width);
				insertImage(
					key,
					file.name.replace(/\.[^.]+$/, ''),
					width,
					height
				)(view.state, view.dispatch);
				view.focus();
				return;
			}
			const bytes = new Uint8Array(await file.arrayBuffer());
			const made = await notes.core.attach(folder, file.name, bytes, fileId);
			if (view) linkNode(view, made.id, made.name);
		} catch (e) {
			toasts.push(
				'danger',
				e instanceof Error && !('code' in e) ? e.message : describeDriveError(e)
			);
		}
	}

	// The menus at the caret.
	const SLASH = [
		{ id: 'text', label: 'Text', md: '', icon: 'text' },
		{ id: 'heading', label: 'Heading', md: '#', icon: 'heading' },
		{ id: 'check', label: 'Checklist', md: '[ ]', icon: 'list-check' },
		{ id: 'link', label: 'Link to note', md: '[[', icon: 'link' },
		{ id: 'code', label: 'Code', md: '```', icon: 'code' },
		{ id: 'callout', label: 'Callout', md: '>!', icon: 'callout' },
		{ id: 'file', label: 'Image or file', md: '', icon: 'attach' },
		{ id: 'table', label: 'Table', md: '|', icon: 'table' }
	] as const;

	type Option = { id: string; label: string; hint: string; icon: 'note' | 'doc' | 'plus' };

	const slashItems = $derived(
		suggest?.kind === 'slash'
			? SLASH.filter((s) => s.label.toLowerCase().startsWith(suggest!.query.trim().toLowerCase()))
			: []
	);

	const linkItems = $derived.by<Option[]>(() => {
		if (suggest?.kind !== 'link') return [];
		const q = suggest.query.trim().toLowerCase();
		const found: Option[] = items
			.filter((i) => i.id !== fileId && i.title.toLowerCase().includes(q))
			.slice(0, 6)
			.map((i) => ({
				id: i.id,
				label: i.title,
				hint: i.notebook?.name ?? 'Notes',
				icon: 'note'
			}));
		if (q !== '') {
			void drive.rev;
			const files: Option[] = [];
			for (const n of drive.core?.tree.nodes.values() ?? []) {
				if (files.length >= 4) break;
				if (n.kind !== 'file' || n.trashedAt !== null || n.currentVersion === null || !n.readable)
					continue;
				if (isNoteFile(n) || drive.inNotes(n.id) || !n.name.toLowerCase().includes(q)) continue;
				files.push({ id: n.id, label: n.name, hint: 'Drive', icon: 'doc' });
			}
			found.push(...files);
			if (!items.some((i) => sameTitle(i.title, suggest!.query)))
				found.push({
					id: 'new',
					label: `New note “${suggest.query.trim()}”`,
					hint: '',
					icon: 'plus'
				});
		}
		return found;
	});

	const menuLength = $derived(suggest?.kind === 'slash' ? slashItems.length : linkItems.length);

	function suggestKey(key: string): boolean {
		if (menuLength === 0) return false;
		if (key === 'ArrowDown') active = (active + 1) % menuLength;
		else if (key === 'ArrowUp') active = (active - 1 + menuLength) % menuLength;
		else if (suggest?.kind === 'slash') chooseSlash(slashItems[active].id);
		else void chooseLink(linkItems[active]);
		return true;
	}

	function chooseSlash(id: string) {
		if (!view || !suggest) return;
		const s = suggest;
		const command = {
			text: setText,
			heading: setStyle('h2'),
			check: toggleList('check'),
			code: setStyle('code'),
			callout: setCallout('note'),
			table: insertTable(3, 3),
			link: null,
			file: null
		}[id];
		runSlash(view, s, command ?? null);
		if (id === 'link') view.dispatch(view.state.tr.insertText('[['));
		if (id === 'file') picker?.click();
	}

	async function chooseLink(option: Option | undefined) {
		if (!view || !suggest || !option) return;
		const s = suggest;
		if (option.id === 'new') {
			const name = s.query.trim();
			const made = await notes.newNote(folderId === notes.rootId ? null : folderId, name);
			if (made && view) insertNodeLink(view, s, made.id, titleOf(made.name));
			return;
		}
		insertNodeLink(view, s, option.id, option.label);
	}

	const menuAt = $derived.by(() => {
		void rev;
		if (!view || !suggest || !article) return null;
		try {
			const c = view.coordsAtPos(suggest.from);
			const box = article.getBoundingClientRect();
			return { left: Math.max(0, c.left - box.left), top: c.bottom - box.top + 6 };
		} catch {
			return null;
		}
	});

	// Title, notebook, tags and reminder.
	async function rename() {
		const typed = titleDraft.trim();
		if (!node || !canEdit || typed === '' || sameTitle(typed, title)) {
			titleDraft = title;
			return;
		}
		const done = await notes.run((core) => core.renameNote(node.id, typed));
		titleDraft = done ? titleOf(done.name) : title;
	}

	const notebookItems = $derived<MenuItem[]>([
		{ id: '', label: 'No notebook', icon: 'note' },
		...notes.notebooks().map((nb) => ({ id: nb.id, label: nb.name, icon: 'notebook' as const }))
	]);

	async function moveTo(id: string) {
		if (!node || !notes.rootId) return;
		const target = id === '' ? notes.rootId : id;
		if (target === node.parentId) return;
		await session?.flush();
		await notes.run((core) => core.move(node.id, target));
	}

	async function addTag() {
		const tag = cleanTag(tagDraft ?? '');
		tagDraft = null;
		if (!node || !meta || tag === '' || meta.tags.includes(tag)) return;
		await notes.run((core) => core.setMeta(node.id, { tags: [...meta.tags, tag] }));
	}

	async function removeTag(tag: string) {
		if (!node || !meta) return;
		await notes.run((core) => core.setMeta(node.id, { tags: meta.tags.filter((t) => t !== tag) }));
	}

	const writtenTags = $derived((item?.tags ?? []).filter((t) => !meta?.tags.includes(t)));

	function togglePin() {
		if (!node || !meta) return;
		void notes.run((core) => core.setMeta(node.id, { pinned: !meta.pinned }));
	}

	const reminderText = $derived(
		meta?.reminder == null
			? null
			: new Date(meta.reminder).toLocaleString(undefined, {
					weekday: 'short',
					month: 'short',
					day: 'numeric',
					hour: 'numeric',
					minute: '2-digit'
				})
	);

	// The list of the notebook.
	const siblings = $derived(
		items
			.filter(
				(i) =>
					!i.meta.archived &&
					(item?.shared
						? i.shared
						: !i.shared && (i.notebook?.id ?? null) === (notebook?.id ?? null))
			)
			.filter((i) => {
				const q = listQuery.trim().toLowerCase();
				return (
					q === '' ||
					i.title.toLowerCase().includes(q) ||
					(i.entry?.text ?? '').toLowerCase().includes(q)
				);
			})
			.sort(
				(a, b) =>
					Number(b.meta.pinned) - Number(a.meta.pinned) || b.node.updatedAt - a.node.updatedAt
			)
	);
	const listName = $derived(notebook?.name ?? (item?.shared ? 'Shared' : 'Notes'));

	async function newInNotebook() {
		const made = await notes.newNote(notebook?.id ?? null);
		if (made) await goto(resolve(`/notes/${made.id}`));
	}

	// Exports.
	function save(blob: Blob, name: string) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}

	async function exportAs(kind: 'md' | 'pdf' | 'html' | 'doc') {
		if (!view) return;
		try {
			if (kind === 'pdf') {
				window.print();
				return;
			}
			const blocks = fromDoc(view.state.doc);
			if (kind === 'md') {
				save(new Blob([await markdown()], { type: 'text/markdown' }), `${title}.md`);
			} else if (kind === 'html') {
				save(new Blob([noteHtml(title, { blocks })], { type: 'text/html' }), `${title}.html`);
			} else {
				const bytes = await writeDocument('docx', withoutNodes({ blocks }));
				const root = drive.rootId;
				if (root === null) return;
				const made = await createWith(saveDeps(), root, `${title}.docx`, bytes);
				search.fileCommitted(made.id, new Blob([bytes as Uint8Array<ArrayBuffer>]));
				toasts.push('ok', `Saved to My files as “${made.name}”.`);
			}
		} catch (e) {
			toasts.push(
				'danger',
				e instanceof Error && !('code' in e) ? e.message : describeDriveError(e)
			);
		}
	}

	async function saveAsTemplate() {
		const text = await markdown();
		await notes.run(async (core, root) => {
			let folder = core.notebooks(root).find((nb) => sameTitle(nb.name, TEMPLATES));
			folder ??= await core.createNotebook(root, TEMPLATES, 'violet');
			await core.createNote(folder.id, title, text);
		});
		toasts.push('ok', `“${title}” is now a template.`);
	}

	const more = $derived<MenuItem[]>([
		...(meta && !item?.shared
			? [
					meta.archived
						? { id: 'unarchive', label: 'Take out of the archive', icon: 'archive' as const }
						: { id: 'archive', label: 'Archive', icon: 'archive' as const }
				]
			: []),
		...(node && isOwner(node) ? [{ id: 'share', label: 'Share…', icon: 'shared' as const }] : []),
		{ id: 'template', label: 'Save as template', icon: 'template' },
		{ id: 'history', label: 'Version history', icon: 'history' },
		{ id: 'print', label: 'Print or save as PDF…', icon: 'print' },
		...(canEdit ? [{ id: 'trash', label: 'Move to trash', icon: 'trash' as const }] : [])
	]);

	async function chooseMore(id: string) {
		if (!node) return;
		if (id === 'archive' || id === 'unarchive') {
			await notes.run((core) => core.setMeta(node.id, { archived: id === 'archive' }));
		} else if (id === 'share') drive.dialog = { kind: 'share', node };
		else if (id === 'template') await saveAsTemplate();
		else if (id === 'history') drive.versionsOf = node;
		else if (id === 'print') window.print();
		else if (id === 'trash') {
			await session?.flush();
			await notes.run((core) => core.trashNote(node.id));
			void drive.loadTrash();
			toasts.push('ok', `“${title}” is in the trash.`);
			await goto(resolve('/notes'));
		}
	}

	const statusText = $derived(
		!canEdit
			? 'View only'
			: { saved: 'Saved', unsaved: 'Unsaved changes', saving: 'Saving…', failed: 'Not saved' }[
					status
				]
	);
	const othersNames = $derived(others.map((o) => o.username).join(', '));

	function toggleListPane() {
		listOpen = !listOpen;
		focus = false;
		if (listOpen && narrow.current) panelOpen = false;
	}

	function togglePanel() {
		panelOpen = !panelOpen;
		focus = false;
		if (panelOpen && narrow.current) listOpen = false;
	}

	function pickNote(next: NoteItem) {
		if (narrow.current) listOpen = false;
		void goto(resolve(`/notes/${next.id}`));
	}
</script>

<svelte:window onbeforeunload={beforeUnload} />
<svelte:head><title>{title || 'Note'} · Notes · YonDrive</title></svelte:head>

<div class="screen" class:focus>
	{#if !focus}
		<div class="rail">
			<AppRail current="notes" hrefs={{ drive: resolve('/'), notes: resolve('/notes') }} />
		</div>
	{/if}

	{#if narrow.current && (listOpen || panelOpen) && !focus}
		<button
			type="button"
			class="scrim"
			aria-label="Close the panel"
			onclick={() => ((listOpen = false), (panelOpen = false))}
		></button>
	{/if}

	{#if listOpen && !focus}
		<aside class="list" aria-label="Notes in {listName}">
			<div class="list-head">
				<div class="list-title">
					<a class="ghost" href={resolve('/notes')} aria-label="Back to all notes"
						><Icon name="arrow-left" size={18} /></a
					>
					{#if notebook}
						<span style:color="var(--notebook-{notebookColor(notebook.raw)})" class="nb-icon"
							><Icon name="notebook" size={17} strokeWidth={1.9} /></span
						>
					{/if}
					<h2>{listName}</h2>
					<span class="muted">{siblings.length}</span>
					{#if !item?.shared}
						<button
							type="button"
							class="ghost push"
							aria-label="New note in {listName}"
							onclick={() => void newInNotebook()}><Icon name="pencil" size={17} /></button
						>
					{/if}
				</div>
				<div class="list-search">
					<label for="list-search" class="sr">Search in {listName}</label>
					<span class="search-icon"><Icon name="search" size={15} /></span>
					<input
						id="list-search"
						type="search"
						placeholder="Search in {listName}"
						bind:value={listQuery}
					/>
				</div>
			</div>
			<div class="list-items">
				{#each siblings as s (s.id)}
					<button
						type="button"
						class="li"
						class:on={s.id === fileId}
						aria-current={s.id === fileId ? 'page' : undefined}
						onclick={() => pickNote(s)}
					>
						<span class="li-top">
							{#if s.meta.pinned}<span class="li-pin" aria-label="Pinned" role="img"
									><Icon name="pin" size={12} strokeWidth={2} /></span
								>{/if}
							<span class="li-title">{s.title}</span>
							<span class="li-time">{formatWhen(s.node.updatedAt)}</span>
						</span>
						<span class="li-text">{s.entry?.preview ?? ''}</span>
					</button>
				{/each}
			</div>
		</aside>
	{/if}

	<div class="main">
		<header class="head">
			{#if narrow.current}
				<a class="ghost" href={resolve('/notes')} aria-label="Back to all notes"
					><Icon name="arrow-left" size={18} /></a
				>
			{/if}
			<button
				type="button"
				class="ghost"
				aria-label="Toggle note list"
				aria-pressed={listOpen && !focus}
				onclick={toggleListPane}><Icon name="split" size={18} /></button
			>
			<nav class="crumbs" aria-label="Location">
				<a href={resolve('/notes')}>{listName}</a>
				<span aria-hidden="true">/</span>
				<span class="here">{title}</span>
			</nav>
			<div class="actions">
				<span
					class="status"
					data-testid="save-status"
					class:bad={status === 'failed'}
					title={saveError || undefined}
				>
					{#if status === 'saved' && canEdit}<span class="ok"
							><Icon name="check" size={13} strokeWidth={2.2} /></span
						>{/if}
					{statusText}
				</span>
				{#if status === 'failed'}
					<button type="button" class="retry" onclick={() => void session?.flush()}
						>Try again</button
					>
				{/if}
				{#if meta && !item?.shared}
					<button
						type="button"
						class="ghost"
						class:on={meta.pinned}
						aria-label={meta.pinned ? 'Unpin note' : 'Pin note'}
						aria-pressed={meta.pinned}
						title="Pin"
						onclick={togglePin}><Icon name="pin" size={17} /></button
					>
				{/if}
				<button
					type="button"
					class="ghost"
					class:on={focus}
					aria-label="Focus mode"
					aria-pressed={focus}
					title="Focus mode"
					onclick={() => (focus = !focus)}><Icon name="focus" size={17} /></button
				>
				<button
					type="button"
					class="ghost"
					class:on={panelOpen && !focus}
					aria-label="Toggle links and info"
					aria-pressed={panelOpen && !focus}
					title="Links & info"
					onclick={togglePanel}><Icon name="panel" size={17} /></button
				>
				<Menu
					label="More options"
					items={more}
					width={250}
					align="end"
					onselect={(id) => void chooseMore(id)}
				>
					{#snippet trigger(attrs)}
						<button type="button" class="ghost" aria-label="More options" {...attrs}
							><Icon name="more" size={17} /></button
						>
					{/snippet}
				</Menu>
			</div>
		</header>

		<div class="body">
			{#if phase === 'failed'}
				<Banner tone="danger" title="This note could not be opened">{problem}</Banner>
			{:else if phase === 'loading'}
				<p class="muted" aria-live="polite">Opening…</p>
			{/if}
			{#if conflict}
				<Banner
					tone="warn"
					title="Saved as a separate copy"
					dismissible
					ondismiss={() => (conflict = null)}
				>
					Someone else saved “{titleOf(conflict.original.name)}” while you were editing, so nothing
					of theirs was overwritten. Your changes are in “{titleOf(conflict.copy.name)}”, which you
					are editing now.
					<a href={resolve(`/notes/${conflict.original.id}`)} data-sveltekit-reload>Open theirs</a>
				</Banner>
			{/if}
			{#if others.length > 0 && !othersDismissed}
				<div data-testid="editing-warning">
					<Banner
						tone="warn"
						title="{othersNames} {others.length === 1 ? 'is' : 'are'} also editing this note"
					>
						You can carry on. If you both save, the later save becomes a separate copy, so neither
						is lost.
						{#snippet actions()}
							<Button size="sm" onclick={() => (othersDismissed = true)}>Continue</Button>
						{/snippet}
					</Banner>
				</div>
			{/if}

			<article class="note" class:hidden={phase !== 'ready'} bind:this={article}>
				<label for="note-title" class="sr">Title</label>
				<textarea
					id="note-title"
					class="title"
					rows="1"
					readonly={!canEdit}
					bind:value={titleDraft}
					onblur={() => void rename()}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							(e.currentTarget as HTMLTextAreaElement).blur();
							view?.focus();
						}
					}}></textarea>

				<div class="meta">
					{#if !item?.shared && canEdit}
						<Menu
							label="Notebook"
							heading="Move to notebook"
							items={notebookItems}
							width={240}
							align="start"
							onselect={(id) => void moveTo(id)}
						>
							{#snippet trigger(attrs)}
								<button type="button" class="pill" {...attrs}>
									<span
										style:color={notebook
											? `var(--notebook-${notebookColor(notebook.raw)})`
											: undefined}
										class="nb-icon"><Icon name="notebook" size={14} strokeWidth={2} /></span
									>
									{notebook?.name ?? 'No notebook'}
									<Icon name="chevron-down" size={12} strokeWidth={2.2} />
								</button>
							{/snippet}
						</Menu>
					{/if}
					{#each meta?.tags ?? [] as t (t)}
						<span class="tag"
							>#{t}{#if canEdit}<button
									type="button"
									class="untag"
									aria-label="Remove tag {t}"
									onclick={() => void removeTag(t)}><Icon name="close" size={11} /></button
								>{/if}</span
						>
					{/each}
					{#each writtenTags as t (t)}
						<span class="tag written" title="Written in the note">#{t}</span>
					{/each}
					{#if canEdit && !item?.shared}
						{#if tagDraft !== null}
							<input
								class="tag-input"
								aria-label="New tag"
								placeholder="tag"
								bind:value={tagDraft}
								onblur={() => void addTag()}
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										void addTag();
									} else if (e.key === 'Escape') tagDraft = null;
								}}
							/>
						{:else}
							<button
								type="button"
								class="add-tag"
								aria-label="Add tag"
								onclick={async () => {
									tagDraft = '';
									await tick();
									(document.querySelector('.tag-input') as HTMLInputElement | null)?.focus();
								}}>+ Tag</button
							>
						{/if}
						<button
							type="button"
							class="reminder"
							class:set={reminderText !== null}
							onclick={() => node && (notes.dialog = { kind: 'reminder', node })}
						>
							<Icon name="alarm" size={14} strokeWidth={2} />
							{reminderText ?? 'Reminder'}
						</button>
					{/if}
					<span class="edited">Edited {node ? formatWhen(node.updatedAt).toLowerCase() : ''}</span>
				</div>

				<div class="editor" bind:this={mount}></div>

				{#if suggest && menuAt && menuLength > 0}
					<div
						class="menu"
						role="listbox"
						aria-label={suggest.kind === 'slash' ? 'Insert block' : 'Link to a note or file'}
						style:left="{menuAt.left}px"
						style:top="{menuAt.top}px"
					>
						<span class="menu-head">{suggest.kind === 'slash' ? 'Insert' : 'Link to'}</span>
						{#if suggest.kind === 'slash'}
							{#each slashItems as s, i (s.id)}
								<button
									type="button"
									role="option"
									aria-selected={i === active}
									class="opt"
									class:on={i === active}
									onmousedown={(e) => e.preventDefault()}
									onclick={() => chooseSlash(s.id)}
								>
									<span class="opt-icon"><Icon name={s.icon} size={15} /></span>
									<span class="opt-label">{s.label}</span>
									<span class="opt-md">{s.md}</span>
								</button>
							{/each}
						{:else}
							{#each linkItems as l, i (l.id)}
								<button
									type="button"
									role="option"
									aria-selected={i === active}
									class="opt"
									class:on={i === active}
									onmousedown={(e) => e.preventDefault()}
									onclick={() => void chooseLink(l)}
								>
									<span class="opt-icon {l.icon}"><Icon name={l.icon} size={15} /></span>
									<span class="opt-label">{l.label}</span>
									<span class="opt-md">{l.hint}</span>
								</button>
							{/each}
						{/if}
					</div>
				{/if}
			</article>
		</div>
	</div>

	{#if panelOpen && !focus && item && phase === 'ready'}
		<div class="sidewrap">
			<NoteSide
				{item}
				{items}
				{words}
				bind:tab
				onopen={(id) => void openNode(id)}
				onexport={(k) => void exportAs(k)}
				onversions={() => node && (drive.versionsOf = node)}
				onlinked={() => notes.treeChanged()}
				onclose={narrow.current ? () => (panelOpen = false) : undefined}
			/>
		</div>
	{/if}
</div>

<input bind:this={picker} type="file" hidden data-testid="note-file-input" onchange={picked} />

<NotesDialogs />

<style>
	.screen {
		min-height: 100vh;
		display: flex;
		align-items: stretch;
		background: var(--surface-paper);
		color: var(--text-strong);
	}

	.rail {
		display: flex;
		flex: none;
	}

	.list {
		flex: 0 0 290px;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		background: var(--surface-side);
		border-right: 1px solid var(--border);
		max-height: 100vh;
		position: sticky;
		top: 0;
	}

	.list-head {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px 14px 10px;
	}

	.list-title {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.list-title h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.push {
		margin-left: auto;
	}

	.nb-icon {
		display: inline-grid;
	}

	.list-search {
		position: relative;
		display: flex;
		align-items: center;
	}

	.search-icon {
		position: absolute;
		left: 11px;
		display: grid;
		color: var(--text-muted);
	}

	.list-search input {
		width: 100%;
		box-sizing: border-box;
		height: 38px;
		padding: 0 12px 0 32px;
		border: 1px solid var(--border-field);
		border-radius: 10px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
		font-size: 13px;
		outline-color: var(--notes);
	}

	.list-items {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 0 8px 16px;
	}

	.li {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 10px 12px;
		border: 0;
		border-radius: 11px;
		background: transparent;
		color: var(--text-strong);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.li:hover {
		background: var(--surface-hover);
	}

	.li.on {
		background: var(--surface);
		box-shadow:
			0 0 0 1px var(--notes-line),
			var(--shadow-lg);
	}

	.li-top {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
	}

	.li-pin {
		display: grid;
		color: var(--notes);
	}

	.li-title {
		flex: 1;
		min-width: 0;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.li-time {
		flex: none;
		font-size: 11px;
		color: var(--text-muted);
	}

	.li-text {
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--text-muted);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.main {
		flex: 999 1 560px;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.head {
		position: sticky;
		top: 0;
		z-index: 10;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		padding: 10px 20px;
		background: var(--surface-paper);
		border-bottom: 1px solid var(--divider);
	}

	.ghost {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
		text-decoration: none;
	}

	.ghost:hover {
		background: var(--surface-hover);
	}

	.ghost.on {
		background: var(--notes-soft);
		color: var(--notes-ink);
	}

	.crumbs {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-size: 13px;
		color: var(--text-muted);
	}

	.crumbs a {
		color: var(--text-muted);
		text-decoration: none;
	}

	.here {
		color: var(--text-strong);
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-right: 8px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.status .ok {
		display: grid;
		color: var(--ok);
	}

	.status.bad {
		color: var(--danger-ink);
	}

	.retry {
		border: 0;
		background: none;
		color: var(--accent);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 12px;
		width: 100%;
		max-width: 760px;
		box-sizing: border-box;
		margin: 0 auto;
		padding: 28px 28px 96px;
	}

	.note {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 18px;
		font-size: 16px;
		line-height: 1.7;
		color: var(--text-body);
	}

	.note.hidden {
		display: none;
	}

	.title {
		margin: 0;
		padding: 0;
		border: 0;
		resize: none;
		field-sizing: content;
		background: transparent;
		color: var(--text-strong);
		font: inherit;
		font-size: 34px;
		line-height: 1.15;
		font-weight: 600;
		letter-spacing: -0.025em;
		outline: none;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		line-height: 1.4;
	}

	.pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 30px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text-body);
		font: inherit;
		cursor: pointer;
	}

	.tag {
		height: 30px;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 0 10px;
		border-radius: 8px;
		background: var(--surface-sunken);
		color: var(--text-soft);
	}

	.tag.written {
		background: transparent;
		border: 1px solid var(--border);
	}

	.untag {
		display: grid;
		padding: 2px;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.add-tag {
		height: 30px;
		padding: 0 8px;
		border: 1px dashed var(--border-strong);
		border-radius: 8px;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		cursor: pointer;
	}

	.tag-input {
		height: 30px;
		width: 110px;
		box-sizing: border-box;
		padding: 0 8px;
		border: 1px solid var(--border-field);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
		outline: none;
	}

	.reminder {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 30px;
		padding: 0 10px;
		border: 1px dashed var(--border-strong);
		border-radius: 8px;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		cursor: pointer;
	}

	.reminder.set {
		border: 0;
		background: var(--notes-soft);
		color: var(--notes-ink);
	}

	.edited {
		margin-left: auto;
		color: var(--text-muted);
	}

	.muted {
		color: var(--text-muted);
		font-size: 12px;
	}

	.menu {
		position: absolute;
		z-index: 20;
		width: 280px;
		padding: 6px;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border-strong);
		border-radius: 14px;
		background: var(--surface);
		box-shadow: var(--shadow-lg);
		font-size: 14px;
		line-height: 1.4;
	}

	.menu-head {
		padding: 6px 10px 4px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.opt {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 40px;
		padding: 0 10px;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: var(--text-strong);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.opt:hover,
	.opt.on {
		background: var(--surface-sunken);
	}

	.opt-icon {
		width: 28px;
		height: 28px;
		flex: none;
		display: grid;
		place-items: center;
		border-radius: 7px;
		border: 1px solid var(--border);
		background: var(--surface-paper);
		color: var(--icon);
	}

	.opt-icon.note {
		color: var(--notes);
	}

	.opt-icon.doc {
		color: var(--drive);
	}

	.opt-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.opt-md {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-muted);
	}

	.sidewrap {
		display: contents;
	}

	.scrim {
		display: none;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	/* The note itself, in the editor. */
	.editor :global(.note-body) {
		outline: none;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		min-height: 40vh;
	}

	.editor :global(.note-body > *) {
		margin: 0 0 0.6em;
	}

	.editor :global(h1),
	.editor :global(h2),
	.editor :global(h3) {
		color: var(--text-strong);
		line-height: 1.25;
		letter-spacing: -0.015em;
		margin-top: 0.8em;
	}

	.editor :global(h1) {
		font-size: 1.6em;
	}

	.editor :global(h2) {
		font-size: 1.375em;
	}

	.editor :global(h3) {
		font-size: 1.15em;
	}

	.editor :global(blockquote) {
		padding: 4px 0 4px 18px;
		border-left: 3px solid var(--border-strong);
		color: var(--text-soft);
	}

	.editor :global(blockquote.callout) {
		padding: 14px 16px 14px 46px;
		border: 0;
		border-radius: 12px;
		background: var(--notes-callout);
		color: var(--text-soft);
		font-size: 15px;
		position: relative;
	}

	.editor :global(blockquote.callout::before) {
		content: '';
		position: absolute;
		left: 16px;
		top: 16px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: 2px solid var(--notes);
		box-sizing: border-box;
	}

	.editor :global(pre) {
		padding: 16px 18px;
		border-radius: 12px;
		border: 1px solid var(--divider);
		background: var(--code);
		font-family: var(--font-mono);
		font-size: 13px;
		line-height: 1.65;
		white-space: pre-wrap;
	}

	.editor :global(code) {
		font-family: var(--font-mono);
		font-size: 0.88em;
	}

	.editor :global(.li) {
		position: relative;
		margin-bottom: 0.25em;
		padding-left: calc(1.8em + var(--lvl, 0) * 1.6em);
	}

	.editor :global(.li[data-level='1']) {
		--lvl: 1;
	}
	.editor :global(.li[data-level='2']) {
		--lvl: 2;
	}
	.editor :global(.li[data-level='3']) {
		--lvl: 3;
	}

	.editor :global(.li-bullet::before),
	.editor :global(.li-number::before) {
		position: absolute;
		left: calc(var(--lvl, 0) * 1.6em);
		width: 1.4em;
		text-align: right;
		color: var(--text-soft);
	}

	.editor :global(.li-bullet::before) {
		content: '•';
	}

	.editor :global(.li-number::before) {
		content: attr(data-n);
		font-variant-numeric: tabular-nums;
	}

	.editor :global(.check-box) {
		position: absolute;
		left: calc(var(--lvl, 0) * 1.6em + 0.1em);
		top: 0.35em;
		width: 1.05em;
		height: 1.05em;
		padding: 0;
		border: 1.5px solid var(--text-muted);
		border-radius: 4px;
		background: var(--surface);
		cursor: pointer;
	}

	.editor :global(.li-check[data-checked='true'] .check-box) {
		background: var(--notes);
		border-color: var(--notes);
		box-shadow: inset 0 0 0 2px var(--surface-paper);
	}

	.editor :global(.li-check[data-checked='true']) {
		color: var(--text-muted);
		text-decoration: line-through;
	}

	.editor :global(.due) {
		padding: 1px 8px;
		border-radius: 99px;
		background: var(--surface-sunken);
		color: var(--text-muted);
		font-size: 12px;
	}

	.editor :global(.due-today),
	.editor :global(.due-overdue) {
		background: var(--danger-soft);
		color: var(--danger-ink);
	}

	.editor :global(.hashtag) {
		color: var(--notes-ink);
	}

	.editor :global(a.node-link) {
		padding: 0 6px;
		border-radius: 6px;
		font-weight: 500;
		text-decoration: none;
		cursor: pointer;
	}

	.editor :global(.chip-note),
	.editor :global(.chip-note a),
	.editor :global(a.node-link .chip-note) {
		background: var(--notes-soft);
		color: var(--notes-ink);
	}

	.editor :global(.chip-file),
	.editor :global(.chip-file a) {
		background: var(--drive-soft);
		color: var(--accent-ink);
	}

	.editor :global(.chip-missing) {
		color: var(--text-muted);
		text-decoration: line-through dotted;
	}

	.editor :global(a:not(.node-link)) {
		color: var(--accent);
	}

	.editor :global(table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.92em;
	}

	.editor :global(td),
	.editor :global(th) {
		padding: 8px 12px;
		border: 1px solid var(--border-strong);
		vertical-align: top;
		text-align: left;
	}

	.editor :global(th) {
		background: var(--surface-sunken);
		font-weight: 600;
	}

	.editor :global(td > *),
	.editor :global(th > *) {
		margin: 0;
	}

	.editor :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: 12px;
		border: 1px solid var(--divider);
	}

	.editor :global(.image-placeholder) {
		display: inline-block;
		padding: 6px 10px;
		border: 1px dashed var(--border-strong);
		border-radius: 6px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.editor :global(.locked) {
		padding: 10px 14px;
		border: 1px dashed var(--warn-line);
		border-radius: 8px;
		background: var(--warn-soft);
		user-select: none;
	}

	.editor :global(.locked-label) {
		display: block;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--warn-ink);
	}

	.editor :global(.locked-text) {
		white-space: pre-wrap;
		color: var(--text-soft);
	}

	.editor :global(.selectedCell) {
		background: var(--selection);
	}

	.editor :global(.ProseMirror-selectednode) {
		outline: 2px solid var(--notes);
	}

	.editor :global(.ProseMirror-gapcursor) {
		display: none;
		pointer-events: none;
		position: absolute;
	}

	@media (max-width: 720px) {
		.rail {
			display: none;
		}

		.body {
			padding: 16px 16px 64px;
		}

		.head {
			flex-wrap: nowrap;
			padding: 8px 12px;
			gap: 6px;
		}

		.crumbs {
			display: none;
		}

		.title {
			font-size: 26px;
		}

		.scrim {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 30;
			border: 0;
			padding: 0;
			background: rgb(8 8 10 / 0.4);
		}

		.list,
		.sidewrap {
			display: flex;
			position: fixed;
			top: 0;
			bottom: 0;
			z-index: 31;
			width: min(320px, 86vw);
			max-height: none;
			overflow-y: auto;
			background: var(--surface-page);
			box-shadow: var(--shadow-lg);
		}

		.list {
			left: 0;
		}

		.sidewrap {
			right: 0;
		}

		.sidewrap > :global(*) {
			flex: 1;
			max-width: none;
		}

		.menu {
			width: min(280px, calc(100vw - 32px));
		}
	}

	@media print {
		.rail,
		.list,
		.head,
		.sidewrap,
		.scrim,
		.meta,
		.menu {
			display: none !important;
		}

		.screen,
		.body {
			background: #fff;
			padding: 0;
		}

		.note,
		.title {
			color: #000;
		}
	}
</style>
