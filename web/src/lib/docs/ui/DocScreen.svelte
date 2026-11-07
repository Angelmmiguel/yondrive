<!--
  The document editor of the board: header, toolbar, outline, one continuous sheet
  of paper, details and versions, and a footer with the word count and zoom. It
  opens one file, reads it in the formats worker, and saves edits as versions.
-->
<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onDestroy, tick, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { EditorView } from 'prosemirror-view';
	import { api } from '$lib/api/client';
	import type { Editor } from '$lib/api/types';
	import { formatBytes, formatWhen } from '$lib/app/format';
	import {
		Banner,
		Button,
		Dialog,
		Field,
		Icon,
		Menu,
		SegmentedControl,
		TextInput,
		type MenuItem
	} from '$lib/components';
	import { describeDriveError } from '$lib/drive/errors';
	import type { DriveNode } from '$lib/drive/tree';
	import { listVersions, restoreVersion, type VersionEntry } from '$lib/drive/versions';
	import {
		CAPS,
		FORMAT_NAMES,
		formatOf,
		MIME,
		noticeOf,
		renameTo,
		type DocFormat,
		type Notice,
		type SaveFormat
	} from '$lib/formats/document';
	import { safeHref } from '$lib/formats/model';
	import { countWords } from '../words';
	import { canChangePlace, canWrite, isOwner } from '$lib/sharing/roles';
	import { drive } from '$lib/state/drive.svelte';
	import { search } from '$lib/state/search.svelte';
	import { session as account } from '$lib/state/session.svelte';
	import { theme } from '$lib/state/theme.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import { insertImage, setMarkValue } from '../commands';
	import { fromDoc, toDoc } from '../convert';
	import { createEditor } from '../editor';
	import { createFormats } from '../formats-client';
	import { ImageStore, redraw } from '../images';
	import { Presence } from '../presence';
	import { conflictName, createWith, saveVersion, type SaveDeps } from '../save';
	import { DocSession, type SaveStatus, type SessionFile } from '../session';
	import { schema } from '../schema';
	import DocSide from './DocSide.svelte';
	import DocToolbar from './DocToolbar.svelte';
	import FindBar from './FindBar.svelte';

	interface Props {
		nodeId: string;
	}

	let { nodeId }: Props = $props();

	/** The most a document may be to open here. */
	const OPEN_LIMIT = 64 * 1024 * 1024;

	const formats = createFormats();
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let problem = $state('');
	let fileId = $state(untrack(() => nodeId));
	let fileName = $state('');
	let format = $state<DocFormat>('docx');
	let saveAs = $state<SaveFormat>('docx');
	let status = $state<SaveStatus>('saved');
	let saveError = $state('');
	let notice = $state<Notice | null>(null);
	let mode = $state<'edit' | 'view'>('edit');
	let rev = $state(0);
	let zoom = $state(100);
	/** A phone: the panels start closed and open over the page, one at a time. */
	const narrow = new MediaQuery('max-width: 720px');
	let outlineOpen = $state(!narrow.current);
	let panel = $state<'details' | 'versions' | null>(narrow.current ? null : 'details');
	let findOpen = $state(false);
	let others = $state.raw<Editor[]>([]);
	let othersDismissed = $state(false);
	let conflict = $state<{ copy: SessionFile; original: SessionFile } | null>(null);
	let versions = $state.raw<VersionEntry[]>([]);
	let versionsError = $state('');
	let words = $state(0);
	let linkOpen = $state(false);
	let linkValue = $state('');
	let linkError = $state('');
	let convertTo = $state<SaveFormat | null>(null);
	let hasLocked = $state(false);
	let mount = $state<HTMLElement>();
	let picker = $state<HTMLInputElement>();
	let view = $state.raw<EditorView | null>(null);
	let docSession: DocSession | null = null;
	let store: ImageStore | null = null;

	const node = $derived(drive.node(fileId));
	const canEdit = $derived(node !== undefined && canWrite(node));
	const editing = $derived(canEdit && mode === 'edit');
	const caps = $derived(CAPS[saveAs]);

	const presence = new Presence({
		api,
		onchange: (list) => {
			others = list;
			if (list.length === 0) othersDismissed = false;
		}
	});

	function saveDeps(): SaveDeps {
		const core = drive.core;
		if (core === null) throw new Error('locked');
		return { tree: core.tree, engine: core.engine };
	}

	/** Where a new file goes: next to this one if this user may write there, or My files. */
	function folderFor(file: SessionFile): string {
		const here = drive.node(file.id);
		const parent = here?.parentId == null ? undefined : drive.node(here.parentId);
		if (parent !== undefined && canWrite(parent)) return parent.id;
		return drive.rootId as string;
	}

	async function load() {
		phase = 'loading';
		problem = '';
		const core = drive.core;
		if (core === null) return;
		try {
			const found = await core.tree.resolve(fileId);
			if (found.kind !== 'file' || found.currentVersion === null)
				throw new Error('This file has nothing in it yet.');
			const f = formatOf(found.name);
			if (f === null) throw new Error('This kind of file does not open in the editor.');
			const version = await core.openVersion(found);
			const blob = await core.readBlob(found, version, { limit: OPEN_LIMIT });
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const opened = await formats.read(bytes, f);
			teardown();
			format = f;
			saveAs = f === 'doc' ? 'docx' : f;
			fileName = found.name;
			notice = noticeOf(f, opened.census);
			hasLocked = opened.model.blocks.some((b) => b.type === 'locked');
			mode = canWrite(found) ? 'edit' : 'view';
			store = new ImageStore(opened.model.images);
			docSession = new DocSession(
				{
					formats,
					save: async (file, out) => {
						const saved = await saveVersion(saveDeps(), file, out, file.version);
						search.fileCommitted(saved.id, new Blob([out as Uint8Array<ArrayBuffer>]));
						return saved.currentVersion ?? '';
					},
					copy: async (file, out) => {
						const who = account.account?.user.username ?? 'me';
						const made = await createWith(
							saveDeps(),
							folderFor(file),
							conflictName(file.name, who, new Date()),
							out
						);
						search.fileCommitted(made.id, new Blob([out as Uint8Array<ArrayBuffer>]));
						return { id: made.id, name: made.name, version: made.currentVersion ?? '' };
					},
					rename: async (file, name) => {
						const here = drive.node(file.id);
						const parent = here?.parentId == null ? undefined : drive.node(here.parentId);
						if (here === undefined || !canChangePlace(here, parent)) return false;
						try {
							await drive.core?.tree.rename(file.id, name);
							return true;
						} catch {
							return false;
						}
					},
					create: async (file, name, out) => {
						const made = await createWith(saveDeps(), folderFor(file), name, out);
						return { id: made.id, name: made.name, version: made.currentVersion ?? '' };
					},
					blocks: () => (view ? fromDoc(view.state.doc) : []),
					images: store,
					onstatus: (s, e) => {
						status = s;
						saveError = s === 'failed' ? describeDriveError(e) : '';
					},
					onconflict: (copy) => {
						conflict = {
							copy,
							original: { id: found.id, name: found.name, version: found.currentVersion ?? '' }
						};
						toasts.push(
							'info',
							`Someone else saved this document first. Your changes are in a copy: ${copy.name}`,
							0
						);
					},
					onfile: (file) => {
						const moved = file.id !== fileId;
						fileId = file.id;
						fileName = file.name;
						format = formatOf(file.name) ?? format;
						if (moved) {
							replaceState(resolve(`/doc/${file.id}`), {});
							presence.start(file.id, editing);
						}
					}
				},
				{ id: found.id, name: found.name, version: found.currentVersion },
				{ bytes, format: f }
			);
			phase = 'ready';
			await tick();
			if (mount === undefined) return;
			const s = store;
			view = createEditor(mount, {
				doc: toDoc(opened.model),
				caps: () => CAPS[saveAs],
				editable: () => editing,
				store: s,
				onUpdate: (_v, changed) => {
					rev++;
					if (changed) {
						docSession?.changed();
						updateWordsSoon();
					}
				},
				onBlocked: () =>
					toasts.push(
						'info',
						'Locked content cannot be changed or removed here. It is kept in the file as it was.'
					),
				onImageFailed: (e) =>
					toasts.push(
						'danger',
						e instanceof Error ? e.message : 'That picture could not be added.'
					),
				onSave: () => void docSession?.flush(),
				onFind: () => (findOpen = true)
			});
			updateWords();
			presence.start(found.id, canWrite(found));
			void loadVersions();
		} catch (e) {
			phase = 'failed';
			problem = e instanceof Error && !('code' in e) ? e.message : describeDriveError(e);
		}
	}

	let wordTimer: ReturnType<typeof setTimeout> | null = null;
	function updateWords() {
		if (wordTimer !== null) clearTimeout(wordTimer);
		wordTimer = null;
		words = view ? countWords(fromDoc(view.state.doc)) : 0;
	}
	/** While typing, the count waits for a pause; a document just opened is counted at once. */
	function updateWordsSoon() {
		if (wordTimer !== null) clearTimeout(wordTimer);
		wordTimer = setTimeout(updateWords, 250);
	}

	async function loadVersions() {
		const core = drive.core;
		const sealer = account.sealer;
		if (core === null || sealer === null) return;
		try {
			versionsError = '';
			versions = await listVersions(fileId, drive.node(fileId)?.currentVersion ?? null, {
				api,
				sealer
			});
		} catch (e) {
			versionsError = describeDriveError(e);
		}
	}

	$effect(() => {
		if (status === 'saved') untrack(() => void loadVersions());
	});

	function teardown() {
		view?.destroy();
		view = null;
		store?.dispose();
		store = null;
	}

	$effect(() => {
		if (drive.status !== 'ready') return;
		untrack(() => void load());
	});

	// Editing or only looking: the editor, and whether the heartbeat says so.
	$effect(() => {
		const e = editing;
		untrack(() => {
			view?.setProps({ editable: () => e });
			if (phase === 'ready') {
				presence.start(fileId, e);
				view?.dispatch(view.state.tr.setMeta('lists', true));
			}
		});
	});

	onDestroy(() => {
		const s = docSession;
		presence.stop();
		void s?.close().finally(() => formats.stop());
		if (wordTimer !== null) clearTimeout(wordTimer);
		teardown();
	});

	function beforeUnload(event: BeforeUnloadEvent) {
		if (docSession?.dirty) {
			void docSession.flush();
			event.preventDefault();
		}
	}

	// Outline: the headings, in order.
	const outline = $derived.by(() => {
		void rev;
		const out: { pos: number; label: string; level: number }[] = [];
		view?.state.doc.forEach((n, pos) => {
			const style = n.attrs.style as string | undefined;
			if (n.type.name !== 'paragraph' || !style || !/^(title|h[1-6])$/.test(style)) return;
			const label = n.textContent.trim();
			if (label) out.push({ pos, label, level: style === 'title' ? 0 : Number(style[1]) });
		});
		return out;
	});

	function goToHeading(pos: number) {
		if (!view) return;
		const dom = view.nodeDOM(pos) as HTMLElement | null;
		dom?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		if (narrow.current) outlineOpen = false;
	}

	function toggleOutline() {
		outlineOpen = !outlineOpen;
		if (outlineOpen && narrow.current) panel = null;
	}

	function togglePanel() {
		panel = panel ? null : 'details';
		if (panel && narrow.current) outlineOpen = false;
	}

	const MODES = [
		{ value: 'edit', label: 'Editing', icon: 'pencil' },
		{ value: 'view', label: 'Viewing', icon: 'eye' }
	] as const;

	const downloads = $derived<MenuItem[]>([
		{
			id: 'original',
			lead: `.${(formatOf(fileName) ?? format).replace('markdown', 'md')}`,
			label: FORMAT_NAMES[formatOf(fileName) ?? format],
			note: 'Original'
		},
		...(['docx', 'odt', 'rtf', 'md', 'txt'] as SaveFormat[])
			.filter((f) => f !== formatOf(fileName))
			.map((f) => ({ id: f, lead: `.${f}`, label: FORMAT_NAMES[f] })),
		{ id: 'print', label: 'Print or save as PDF…', icon: 'print' as const }
	]);

	async function download(id: string) {
		if (id === 'print') {
			window.print();
			return;
		}
		if (id === 'original') {
			if (node) await drive.download(node);
			return;
		}
		if (!docSession) return;
		try {
			const f = id as SaveFormat;
			const bytes = await docSession.bytes(f);
			const url = URL.createObjectURL(
				new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME[f] })
			);
			const a = document.createElement('a');
			a.href = url;
			a.download = renameTo(fileName, f);
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
			if (hasLocked && f !== saveAs)
				toasts.push('info', 'Locked content is written as plain text in this copy.');
		} catch (e) {
			toasts.push('danger', e instanceof Error ? e.message : 'That download did not work.');
		}
	}

	function openLink() {
		if (!view) return;
		const current = view.state.selection.$from.marks().find((m) => m.type === schema.marks.link);
		linkValue = (current?.attrs.href as string | undefined) ?? 'https://';
		linkError = '';
		linkOpen = true;
	}

	function applyLink() {
		if (!view) return;
		const href = linkValue.trim();
		if (href !== '' && href !== 'https://' && !safeHref(href)) {
			linkError = 'Use a web address (https://), an email (mailto:) or a phone number (tel:).';
			return;
		}
		const value = href === '' || href === 'https://' ? null : { href };
		const { empty } = view.state.selection;
		if (empty && value) {
			const tr = view.state.tr.insertText(href);
			const to = tr.selection.from;
			tr.addMark(to - href.length, to, schema.marks.link.create(value));
			view.dispatch(tr);
		} else setMarkValue(schema.marks.link, value)(view.state, view.dispatch);
		linkOpen = false;
		view.focus();
	}

	async function pickedImage(event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = '';
		if (!file || !view || !store) return;
		try {
			const img = await redraw(file);
			const key = store.add(img);
			const width = Math.min(img.width, 624);
			const height = Math.round((img.height * width) / img.width);
			insertImage(key, file.name.replace(/\.[^.]+$/, ''), width, height)(view.state, view.dispatch);
			view.focus();
		} catch (e) {
			toasts.push('danger', e instanceof Error ? e.message : 'That picture could not be added.');
		}
	}

	async function confirmConvert() {
		const f = convertTo;
		convertTo = null;
		if (!f || !docSession) return;
		saveAs = f;
		await docSession.convertTo(f);
		if (docSession.status === 'saved') {
			toasts.push('ok', `Saved as ${FORMAT_NAMES[f]}. The previous version is in Versions.`);
			format = f;
			notice = { summary: `Saved as .${f} from now on.`, lines: [] };
		}
	}

	async function restore(v: VersionEntry) {
		const core = drive.core;
		const sealer = account.sealer;
		if (!core || !sealer || !node) return;
		await docSession?.flush();
		try {
			await restoreVersion(fileId, v, node.currentVersion, { api, sealer, tree: core.tree });
			toasts.push('ok', 'Restored as the current version.');
			await load();
		} catch (e) {
			toasts.push('danger', describeDriveError(e));
		}
	}

	const details = $derived.by(() => {
		const n = node;
		if (!n) return [];
		const trail = drive.core?.tree.breadcrumbs(n.id) ?? [];
		void drive.rev;
		return [
			{ k: 'Format', v: `${FORMAT_NAMES[format]} (.${format})` },
			{ k: 'Size', v: formatBytes(n.size) },
			{ k: 'Words', v: String(words) },
			{
				k: 'Location',
				v: ['My files', ...trail.slice(1, -1).map((t: DriveNode) => t.name)].join(' / ')
			},
			{ k: 'Owner', v: isOwner(n) ? 'You' : 'Shared with you' },
			{ k: 'Created', v: formatWhen(n.created) },
			{ k: 'Modified', v: formatWhen(n.updatedAt) }
		];
	});

	const back = $derived(node?.parentId ? resolve(`/files/${node.parentId}`) : resolve('/'));
	const statusText = $derived(
		!canEdit
			? 'View only'
			: { saved: 'Saved', unsaved: 'Unsaved changes', saving: 'Saving…', failed: 'Not saved' }[
					status
				]
	);
	const othersNames = $derived(others.map((o) => o.username).join(', '));
	const dark = $derived(
		theme.choice === 'dark' ||
			(theme.choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
	);

	/** On a phone, what does not fit in the header: mode, sharing, downloads and theme. */
	const more = $derived<MenuItem[]>([
		...(canEdit
			? [
					mode === 'edit'
						? { id: 'mode', label: 'Switch to viewing', icon: 'eye' as const }
						: { id: 'mode', label: 'Switch to editing', icon: 'pencil' as const }
				]
			: []),
		...(node && isOwner(node) ? [{ id: 'share', label: 'Share…', icon: 'shared' as const }] : []),
		...downloads.map((d) => ({ ...d, id: `download:${d.id}` })),
		{ id: 'theme', label: dark ? 'Light theme' : 'Dark theme', icon: dark ? 'sun' : 'moon' }
	]);

	function chooseMore(id: string) {
		if (id === 'mode') mode = mode === 'edit' ? 'view' : 'edit';
		else if (id === 'share' && node) drive.dialog = { kind: 'share', node };
		else if (id === 'theme') theme.choose(dark ? 'light' : 'dark');
		else if (id.startsWith('download:')) void download(id.slice('download:'.length));
	}
</script>

<svelte:window onbeforeunload={beforeUnload} />
<svelte:head><title>{fileName || 'Document'} · YonDrive</title></svelte:head>

<div class="screen" style:--zoom={zoom / 100}>
	<div class="top">
		<header class="head">
			<a class="ghost back" href={back} aria-label="Back to the folder"
				><Icon name="arrow-left" /></a
			>
			<span class="badge" aria-hidden="true"><Icon name="doc" size={20} /></span>
			<div class="title">
				<div class="line">
					<h1 class="name" title={fileName}>{fileName}</h1>
					<span class="fmt">{format.toUpperCase()}</span>
				</div>
				<div class="meta">
					<span
						data-testid="save-status"
						class:bad={status === 'failed'}
						title={saveError || undefined}>{statusText}</span
					>
					{#if status === 'failed'}
						<button type="button" class="retry" onclick={() => void docSession?.flush()}
							>Try again</button
						>
					{/if}
				</div>
			</div>
			{#if narrow.current}
				<Menu label="More" items={more} width={280} align="end" onselect={chooseMore}>
					{#snippet trigger(attrs)}
						<button type="button" class="ghost" aria-label="More" {...attrs}
							><Icon name="more" /></button
						>
					{/snippet}
				</Menu>
			{:else}
				<div class="actions">
					{#if canEdit}
						<SegmentedControl
							label="Mode"
							options={MODES}
							value={mode}
							onchange={(v) => (mode = v as 'edit' | 'view')}
						/>
					{/if}
					<Menu
						label="Download as"
						heading="Download as"
						triggerLabel="Download"
						triggerIcon="download"
						items={downloads}
						width={280}
						align="end"
						onselect={(id) => void download(id)}
					/>
					{#if node && isOwner(node)}
						<Button
							variant="primary"
							icon="shared"
							onclick={() => node && (drive.dialog = { kind: 'share', node })}>Share</Button
						>
					{/if}
					<button
						type="button"
						class="ghost"
						aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
						onclick={() => theme.choose(dark ? 'light' : 'dark')}
					>
						<Icon name={dark ? 'sun' : 'moon'} />
					</button>
				</div>
			{/if}
		</header>
		{#if phase === 'ready' && view && editing}
			<DocToolbar
				{view}
				{rev}
				{caps}
				outline={outlineOpen}
				panel={panel !== null}
				onlink={openLink}
				onimage={() => picker?.click()}
				onfind={() => (findOpen = true)}
				ontoggleoutline={toggleOutline}
				ontogglepanel={togglePanel}
			/>
		{:else if phase === 'ready' && view}
			<div class="viewbar">
				<button type="button" class="ghost sm" onclick={() => (findOpen = true)}
					><Icon name="search" size={16} /> Find</button
				>
				<button type="button" class="ghost sm" aria-pressed={outlineOpen} onclick={toggleOutline}
					><Icon name="outline" size={16} /> Outline</button
				>
				<button type="button" class="ghost sm" aria-pressed={panel !== null} onclick={togglePanel}
					><Icon name="panel" size={16} /> Details</button
				>
			</div>
		{/if}
		{#if findOpen && view}
			<FindBar
				{view}
				{rev}
				editable={editing}
				onclose={() => ((findOpen = false), view?.focus())}
			/>
		{/if}
	</div>

	<div class="body">
		{#if narrow.current && phase === 'ready' && (outlineOpen || panel)}
			<button
				type="button"
				class="scrim"
				aria-label="Close the panel"
				onclick={() => ((outlineOpen = false), (panel = null))}
			></button>
		{/if}
		{#if outlineOpen && phase === 'ready'}
			<nav class="outline" aria-label="Outline">
				<h2>Outline</h2>
				{#each outline as o (o.pos)}
					<button
						type="button"
						class="ol"
						style:padding-left="{10 + Math.max(0, o.level - 1) * 14}px"
						class:top={o.level <= 1}
						onclick={() => goToHeading(o.pos)}>{o.label}</button
					>
				{:else}
					<p class="empty">Headings appear here.</p>
				{/each}
			</nav>
		{/if}

		<main class="main">
			{#if phase === 'failed'}
				<Banner tone="danger" title="This document could not be opened">{problem}</Banner>
			{:else if phase === 'loading'}
				<p class="loading" aria-live="polite">Opening…</p>
			{/if}
			{#if conflict}
				<div class="note">
					<Banner
						tone="warn"
						title="Saved as a separate copy"
						dismissible
						ondismiss={() => (conflict = null)}
					>
						Someone else saved “{conflict.original.name}” while you were editing, so nothing of
						theirs was overwritten. Your changes are in “{conflict.copy.name}”, which you are
						editing now.
						<a href={resolve(`/doc/${conflict.original.id}`)} data-sveltekit-reload
							>Open their version</a
						>
					</Banner>
				</div>
			{/if}
			{#if others.length > 0 && !othersDismissed}
				<div class="note" data-testid="editing-warning">
					<Banner
						tone="warn"
						title="{othersNames} {others.length === 1 ? 'is' : 'are'} also editing this document"
					>
						You can carry on. If you both save, the later save becomes a separate copy, so neither
						is lost.
						{#snippet actions()}
							<Button size="sm" onclick={() => (othersDismissed = true)}>Continue</Button>
						{/snippet}
					</Banner>
				</div>
			{/if}
			{#if notice && phase === 'ready'}
				<div class="notice" role="status" data-testid="doc-notice">
					<Icon name="info" />
					<div class="notice-text">
						<span>{notice.summary}</span>
						{#each notice.lines as line (line)}<span class="line">{line}</span>{/each}
					</div>
					<button type="button" class="ghost" aria-label="Dismiss" onclick={() => (notice = null)}
						><Icon name="close" size={16} /></button
					>
				</div>
			{/if}
			<div class="paper-wrap" class:hidden={phase !== 'ready'}>
				<article class="paper" class:viewing={!editing} bind:this={mount}></article>
			</div>
		</main>

		{#if panel && phase === 'ready'}
			<div class="sidewrap">
				<DocSide
					bind:tab={panel}
					{details}
					format={formatOf(fileName) ?? format}
					saveFormat={saveAs}
					{canEdit}
					{versions}
					{versionsError}
					onconvert={(f) => (convertTo = f)}
					onrestore={(v) => void restore(v)}
					ondownload={(v) => node && void drive.download(node, v.id)}
				/>
			</div>
		{/if}
	</div>

	<footer class="foot">
		<span data-testid="word-count">{words} {words === 1 ? 'word' : 'words'}</span>
		<span class="zoom">
			<button
				type="button"
				class="ghost"
				aria-label="Zoom out"
				onclick={() => (zoom = Math.max(50, zoom - 10))}><Icon name="zoom-out" size={16} /></button
			>
			<span class="pct">{zoom}%</span>
			<button
				type="button"
				class="ghost"
				aria-label="Zoom in"
				onclick={() => (zoom = Math.min(200, zoom + 10))}><Icon name="zoom-in" size={16} /></button
			>
		</span>
	</footer>
</div>

<input
	bind:this={picker}
	type="file"
	accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
	hidden
	data-testid="image-input"
	onchange={pickedImage}
/>

<Dialog open={linkOpen} title="Link" onclose={() => (linkOpen = false)} width={440}>
	<form
		id="doc-link"
		onsubmit={(e) => {
			e.preventDefault();
			applyLink();
		}}
	>
		<Field label="Address" error={linkError} hint="Leave it empty to remove the link.">
			{#snippet children(field)}
				<TextInput {...field} bind:value={linkValue} data-autofocus autocomplete="off" />
			{/snippet}
		</Field>
	</form>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (linkOpen = false)}>Cancel</Button>
		<Button variant="primary" type="submit" form="doc-link">Apply</Button>
	{/snippet}
</Dialog>

<Dialog
	open={convertTo !== null}
	title="Save as {convertTo ? FORMAT_NAMES[convertTo] : ''}?"
	onclose={() => (convertTo = null)}
	width={480}
>
	<p>
		From now on this document is saved as .{convertTo}, and its name changes to match. The current
		version stays in Versions, so nothing is lost.
	</p>
	{#if hasLocked}
		<p class="warnline">
			This file has locked content. A file in another format cannot carry it over, so it becomes
			plain text.
		</p>
	{/if}
	{#if convertTo === 'md' || convertTo === 'txt'}
		<p class="warnline">
			{convertTo === 'md'
				? 'Markdown cannot hold fonts, sizes, colours, underline, alignment or pictures.'
				: 'Plain text holds no formatting at all.'}
		</p>
	{/if}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (convertTo = null)}>Cancel</Button>
		<Button variant="primary" onclick={() => void confirmConvert()}>Convert</Button>
	{/snippet}
</Dialog>

<style>
	.screen {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		background: var(--surface-canvas);
		color: var(--text-strong);
	}

	.top {
		position: sticky;
		top: 0;
		z-index: 10;
		background: var(--surface-page);
		border-bottom: 1px solid var(--border);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 14px;
		padding: 10px 16px;
	}

	.ghost {
		min-width: 38px;
		height: 38px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
		text-decoration: none;
	}

	.ghost.sm {
		height: 32px;
		padding: 0 10px;
		font-size: 13px;
		color: var(--text-strong);
	}

	.ghost:hover {
		background: var(--surface-hover);
	}

	.badge {
		width: 36px;
		height: 36px;
		flex: none;
		display: grid;
		place-items: center;
		border-radius: 10px;
		background: var(--drive-soft);
		color: var(--drive);
	}

	.title {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1 1 260px;
	}

	.line {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.name {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 17px;
		font-weight: 600;
	}

	.fmt {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		padding: 1px 5px;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.meta .bad {
		color: var(--danger-ink);
	}

	.retry {
		border: 0;
		background: none;
		color: var(--accent);
		cursor: pointer;
		font: inherit;
		padding: 0;
	}

	.actions {
		margin-left: auto;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.viewbar {
		display: flex;
		gap: 4px;
		padding: 4px 16px 8px;
	}

	.body {
		flex: 1;
		display: flex;
		flex-wrap: wrap;
		align-items: stretch;
	}

	.outline {
		flex: 1 1 220px;
		max-width: 100%;
		box-sizing: border-box;
		padding: 24px 12px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.outline h2 {
		margin: 0 0 8px;
		padding: 0 10px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.ol {
		display: block;
		width: 100%;
		text-align: left;
		padding: 7px 10px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-soft);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ol.top {
		font-weight: 500;
		color: var(--text-strong);
	}

	.ol:hover {
		background: var(--surface-hover);
	}

	.empty {
		padding: 0 10px;
		font-size: 13px;
		color: var(--text-muted);
	}

	.main {
		flex: 999 1 600px;
		min-width: 0;
		padding: 28px 20px 64px;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
	}

	.main > :global(*) {
		width: 100%;
		max-width: 816px;
	}

	.loading {
		color: var(--text-muted);
	}

	.notice {
		box-sizing: border-box;
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--surface);
		color: var(--text-soft);
		font-size: 13px;
	}

	.notice-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.notice .ghost {
		min-width: 32px;
		height: 32px;
	}

	.paper-wrap.hidden {
		display: none;
	}

	.paper {
		box-sizing: border-box;
		min-height: 1056px;
		padding: 72px 88px;
		background: var(--surface-paper);
		border-radius: 4px;
		box-shadow: var(--shadow-sm);
		zoom: var(--zoom);
		font-family: var(--font-serif);
		font-size: 17px;
		line-height: 1.6;
		color: var(--text-strong);
	}

	.sidewrap {
		display: contents;
	}

	.scrim {
		display: none;
	}

	@media (max-width: 720px) {
		.paper {
			padding: 32px 20px;
		}

		.head {
			flex-wrap: nowrap;
			gap: 8px;
			padding: 8px 12px;
		}

		.badge {
			display: none;
		}

		.title {
			flex: 1 1 0;
		}

		.main {
			padding: 16px 12px 48px;
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

		.outline,
		.sidewrap {
			display: flex;
			position: fixed;
			top: 0;
			bottom: 0;
			z-index: 31;
			width: min(320px, 86vw);
			overflow-y: auto;
			background: var(--surface-page);
			box-shadow: var(--shadow-lg);
		}

		.outline {
			left: 0;
		}

		.sidewrap {
			right: 0;
		}

		.sidewrap > :global(*) {
			flex: 1;
		}
	}

	.foot {
		position: sticky;
		bottom: 0;
		z-index: 10;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 16px;
		padding: 6px 16px;
		background: var(--surface-page);
		border-top: 1px solid var(--border);
		font-size: 12px;
		color: var(--text-muted);
	}

	.zoom {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.zoom .ghost {
		min-width: 30px;
		height: 30px;
	}

	.pct {
		min-width: 44px;
		text-align: center;
		font-family: var(--font-mono);
	}

	.warnline {
		color: var(--warn-ink);
	}

	/* The document itself. */
	.paper :global(.doc-body) {
		outline: none;
		white-space: pre-wrap;
		overflow-wrap: break-word;
	}

	.paper :global(.doc-body > *) {
		margin: 0 0 0.6em;
	}

	.paper :global(h1),
	.paper :global(h2),
	.paper :global(h3),
	.paper :global(h4),
	.paper :global(h5),
	.paper :global(h6),
	.paper :global(.doc-title) {
		font-family: var(--font-serif);
		line-height: 1.2;
		margin-top: 0.8em;
	}

	.paper :global(.doc-title) {
		font-size: 2.1em;
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.paper :global(h1) {
		font-size: 1.8em;
	}

	.paper :global(h2) {
		font-size: 1.35em;
	}

	.paper :global(h3) {
		font-size: 1.12em;
	}

	.paper :global(blockquote) {
		padding: 4px 0 4px 18px;
		border-left: 3px solid var(--border-strong);
		color: var(--text-soft);
		font-style: italic;
	}

	.paper :global(pre) {
		padding: 10px 14px;
		border-radius: 8px;
		background: var(--surface-sunken);
		font-family: var(--font-mono);
		font-size: 0.82em;
		white-space: pre-wrap;
	}

	.paper :global(code) {
		font-family: var(--font-mono);
		font-size: 0.88em;
	}

	.paper :global(.li) {
		position: relative;
		margin-bottom: 0.25em;
		padding-left: calc(1.6em + var(--lvl, 0) * 1.6em);
	}

	.paper :global(.li[data-level='1']) {
		--lvl: 1;
	}
	.paper :global(.li[data-level='2']) {
		--lvl: 2;
	}
	.paper :global(.li[data-level='3']) {
		--lvl: 3;
	}
	.paper :global(.li[data-level='4']) {
		--lvl: 4;
	}
	.paper :global(.li[data-level='5']),
	.paper :global(.li[data-level='6']),
	.paper :global(.li[data-level='7']),
	.paper :global(.li[data-level='8']) {
		--lvl: 5;
	}

	.paper :global(.li-bullet::before),
	.paper :global(.li-number::before) {
		position: absolute;
		left: calc(var(--lvl, 0) * 1.6em);
		width: 1.4em;
		text-align: right;
		color: var(--text-soft);
	}

	.paper :global(.li-bullet::before) {
		content: '•';
	}

	.paper :global(.li-bullet[data-level='1']::before),
	.paper :global(.li-bullet[data-level='4']::before) {
		content: '◦';
	}

	.paper :global(.li-number::before) {
		content: attr(data-n);
		font-variant-numeric: tabular-nums;
	}

	.paper :global(.check-box) {
		position: absolute;
		left: calc(var(--lvl, 0) * 1.6em + 0.15em);
		top: 0.3em;
		width: 1em;
		height: 1em;
		padding: 0;
		border: 1.5px solid var(--border-strong);
		border-radius: 4px;
		background: var(--surface);
		cursor: pointer;
	}

	.paper :global(.li-check[data-checked='true'] .check-box) {
		background: var(--accent);
		border-color: var(--accent);
		box-shadow: inset 0 0 0 2px var(--surface-paper);
	}

	.paper :global(.li-check[data-checked='true']) {
		color: var(--text-muted);
		text-decoration: line-through;
	}

	.paper :global(table) {
		width: 100%;
		border-collapse: collapse;
		margin: 0.4em 0 0.8em;
		font-size: 0.92em;
		line-height: 1.45;
	}

	.paper :global(td),
	.paper :global(th) {
		padding: 8px 12px;
		border: 1px solid var(--border-strong);
		vertical-align: top;
		text-align: left;
	}

	.paper :global(th) {
		background: var(--surface-sunken);
		font-weight: 600;
	}

	.paper :global(td > *),
	.paper :global(th > *) {
		margin: 0;
	}

	.paper :global(.selectedCell) {
		background: var(--selection);
	}

	.paper :global(img) {
		max-width: 100%;
		height: auto;
		vertical-align: bottom;
	}

	.paper :global(.image-placeholder) {
		display: inline-block;
		padding: 6px 10px;
		border: 1px dashed var(--border-strong);
		border-radius: 6px;
		font-family: var(--font-sans);
		font-size: 12px;
		color: var(--text-muted);
	}

	.paper :global(a) {
		color: var(--accent);
	}

	.paper :global(a.unsafe-link) {
		color: var(--text-soft);
		text-decoration: underline dotted;
	}

	.paper :global(.locked) {
		margin: 0.4em 0 0.8em;
		padding: 10px 14px;
		border: 1px dashed var(--warn-line);
		border-radius: 8px;
		background: var(--warn-soft);
		cursor: default;
		user-select: none;
	}

	.paper :global(.locked-label) {
		display: inline-block;
		margin-bottom: 4px;
		font-family: var(--font-sans);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--warn-ink);
	}

	.paper :global(.locked-label::after) {
		content: ' · kept as it was, not editable here';
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
	}

	.paper :global(.locked-text) {
		white-space: pre-wrap;
		color: var(--text-soft);
	}

	.paper :global(.ProseMirror-selectednode) {
		outline: 2px solid var(--accent);
	}

	.paper :global(.find-hit) {
		background: var(--warn-soft);
		border-radius: 2px;
	}

	.paper :global(.find-hit.current) {
		background: var(--warn);
		color: var(--text-strong);
	}

	.paper :global(.page-break) {
		display: block;
		content: '';
		border-top: 1px dashed var(--border-strong);
		margin: 0.6em 0;
	}

	.paper :global(.ProseMirror-gapcursor) {
		display: none;
		pointer-events: none;
		position: absolute;
	}

	.paper :global(.ProseMirror-focused .ProseMirror-gapcursor) {
		display: block;
	}

	.paper :global(.ProseMirror-gapcursor::after) {
		content: '';
		display: block;
		position: absolute;
		top: -2px;
		width: 20px;
		border-top: 1px solid var(--text-strong);
	}

	/* One continuous sheet: printing lets the browser lay out the pages. */
	@media print {
		.top,
		.outline,
		.foot,
		.notice,
		.note,
		.sidewrap,
		.scrim {
			display: none !important;
		}

		.screen,
		.main {
			background: #fff;
			padding: 0;
		}

		.paper {
			zoom: 1;
			box-shadow: none;
			padding: 0;
			min-height: 0;
			color: #000;
			background: #fff;
		}

		.paper :global(.locked) {
			border: 0;
			background: none;
			padding: 0;
		}

		.paper :global(.locked-label) {
			display: none;
		}
	}
</style>
