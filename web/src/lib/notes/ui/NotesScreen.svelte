<!--
  The notes list board: a heading with search and the view, quick capture with
  templates and today's note, filters and sort, then the notes as cards or rows,
  pinned first. Search runs on the device: words through the search index, `#`
  for tags, `[[` for a note by its title.
-->
<script lang="ts" module>
	/**
	 * The toast of the last quick note, kept while the list comes and goes: the next one
	 * replaces it rather than piling up.
	 */
	let captured: number | null = null;
</script>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { formatWhen } from '$lib/app/format';
	import { Button, EmptyState, Icon, Menu, Select, type MenuItem } from '$lib/components';
	import { redraw } from '$lib/docs/images';
	import type { DriveNode } from '$lib/drive/tree';
	import type { Chip, NoteItem, NoteSort } from '$lib/notes/list';
	import { sameTitle, TEMPLATES, titleOf } from '$lib/notes/model';
	import { nodeHref } from '$lib/notes/parse';
	import { BUILTIN_TEMPLATES, fillTemplate, titleFromTemplate } from '$lib/notes/templates';
	import { drive } from '$lib/state/drive.svelte';
	import { notes } from '$lib/state/notes.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import NoteCard from './NoteCard.svelte';
	import NotesDialogs from './NotesDialogs.svelte';

	let query = $state('');
	let matched = $state.raw<Set<string> | null>(null);
	let capture = $state('');
	let checklist = $state(false);
	let picker = $state<HTMLInputElement>();
	let busy = $state(false);

	$effect(() => {
		if (drive.status === 'ready' && notes.rootId === null) void notes.ensureRoot();
	});

	const items = $derived.by(() => {
		void drive.rev;
		return notes.items();
	});
	const trashed = $derived(notes.section === 'trash' ? notes.trashed(drive.allTrash) : []);

	// Words go to the on-device index; `#` and `[[` are handled here.
	const mode = $derived(
		query.startsWith('#') ? 'tag' : query.includes('[[') ? 'title' : query.trim() ? 'words' : 'none'
	);
	$effect(() => {
		const text = query;
		const m = mode;
		if (m !== 'words') {
			matched = null;
			return;
		}
		let live = true;
		const timer = setTimeout(() => {
			void notes.find(text, items).then((found) => {
				if (live) matched = found;
			});
		}, 80);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	});

	const tagQuery = $derived(mode === 'tag' ? query.slice(1).trim().toLowerCase() : '');
	const tagMatches = $derived(
		mode === 'tag' ? notes.tags(items).filter((t) => t.tag.startsWith(tagQuery)) : []
	);
	const titleQuery = $derived(
		mode === 'title'
			? query
					.slice(query.indexOf('[[') + 2)
					.replace(/\]\]$/, '')
					.trim()
					.toLowerCase()
			: ''
	);
	const titleMatches = $derived(
		mode === 'title'
			? items.filter((i) => i.title.toLowerCase().includes(titleQuery)).slice(0, 8)
			: []
	);

	const shown = $derived.by(() => {
		const list = notes.arranged(items, matched);
		if (mode === 'tag' && tagQuery !== '')
			return list.filter((i) => i.tags.some((t) => t.startsWith(tagQuery)));
		if (mode === 'title') return list.filter((i) => titleMatches.some((m) => m.id === i.id));
		return list;
	});
	const pinned = $derived(shown.filter((i) => i.meta.pinned));
	const others = $derived(shown.filter((i) => !i.meta.pinned));

	const notebook = $derived(notes.notebook === null ? undefined : drive.node(notes.notebook));
	const HEADINGS = {
		all: 'All notes',
		today: 'Today',
		pinned: 'Pinned',
		tasks: 'Tasks',
		shared: 'Shared',
		archive: 'Archive',
		trash: 'Trash'
	} as const;
	const heading = $derived(
		notes.tag ? `#${notes.tag}` : (notebook?.name ?? HEADINGS[notes.section])
	);
	const count = $derived(notes.section === 'trash' ? trashed.length : shown.length);

	const CHIPS: { id: Chip; label: string; icon: 'list-check' | 'alarm' | 'link' | 'attach' }[] = [
		{ id: 'tasks', label: 'Has tasks', icon: 'list-check' },
		{ id: 'reminders', label: 'Reminders', icon: 'alarm' },
		{ id: 'linked', label: 'Linked', icon: 'link' },
		{ id: 'attachments', label: 'Attachments', icon: 'attach' }
	];
	const SORTS = [
		{ value: 'edited', label: 'Last edited' },
		{ value: 'created', label: 'Created' },
		{ value: 'title', label: 'Title' }
	];

	/** Templates: those that come with the app, then the notes of the Templates notebook. */
	const templates = $derived.by<MenuItem[]>(() => {
		const own = items.filter(
			(i) => !i.shared && i.notebook !== null && sameTitle(i.notebook.name, TEMPLATES)
		);
		return [
			...BUILTIN_TEMPLATES.map((t) => ({ id: t.id, label: t.title, icon: 'template' as const })),
			...own.map((i) => ({ id: i.id, label: i.title, note: 'Yours' }))
		];
	});

	const folder = () => notes.notebook;

	async function open(made: DriveNode | undefined) {
		if (made) await goto(resolve(`/notes/${made.id}`));
	}

	async function fromTemplate(id: string) {
		const now = new Date();
		const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
		let title: string;
		let body: string;
		if (builtin) {
			title = titleFromTemplate(builtin, now);
			body = fillTemplate(builtin.body ?? '', { title, now });
		} else {
			const node = drive.node(id);
			if (!node || !notes.core) return;
			title = titleOf(node.name);
			body = fillTemplate(await notes.core.readText(node), { title, now });
		}
		await open(await notes.newNote(folder(), title, body));
	}

	async function today() {
		await open(await notes.run((core, root) => core.todayNote(root)));
	}

	/** A quick note: the words become its title, or the first task of a checklist. */
	async function captureNote(event: SubmitEvent) {
		event.preventDefault();
		const text = capture.trim();
		if (text === '' || busy) return;
		busy = true;
		try {
			if (checklist) {
				const made = await notes.newNote(folder(), text, '- [ ] ');
				capture = '';
				await open(made);
				return;
			}
			const firstLine = text.split('\n')[0];
			const title = firstLine.length > 60 ? `${firstLine.slice(0, 60).trimEnd()}…` : firstLine;
			const made = await notes.newNote(folder(), title, title === text ? '' : `${text}\n`);
			if (made) {
				capture = '';
				if (captured !== null) toasts.dismiss(captured);
				captured = toasts.push('ok', `Saved “${title}”.`);
			}
		} finally {
			busy = false;
		}
	}

	/** A note with a picture: the picture is kept as a file beside it, and the note names it. */
	async function captureImage(event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = '';
		if (!file || !notes.core) return;
		busy = true;
		try {
			const img = await redraw(file);
			const title = capture.trim() || file.name.replace(/\.[^.]+$/, '');
			const ext = img.mime === 'image/jpeg' ? 'jpg' : 'png';
			const made = await notes.run(async (core, root) => {
				const target = folder() ?? root;
				const note = await core.createNote(target, title, '');
				const pic = await core.attach(target, `${title}.${ext}`, img.bytes, note.id);
				const markdown = `![${title}](${nodeHref(pic.id)})\n`;
				const version = await core.writeText(note, markdown, note.currentVersion ?? '');
				notes.saved(note.id, version, markdown);
				return note;
			});
			if (made) capture = '';
			await open(made);
		} catch (e) {
			toasts.push('danger', e instanceof Error ? e.message : 'That picture could not be added.');
		} finally {
			busy = false;
		}
	}

	function pin(item: NoteItem) {
		void notes.run((core) => core.setMeta(item.id, { pinned: !item.meta.pinned }));
	}

	async function restore(node: DriveNode) {
		const trash = drive.allTrash;
		await notes.run((core) => core.restore(node.id, trash));
		await drive.loadTrash();
		notes.treeChanged();
	}

	async function purge(node: DriveNode) {
		const trash = drive.allTrash;
		await notes.run((core) => core.purge(node.id, trash));
		await drive.loadTrash();
	}

	function keydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement;
		if (event.key !== 'n' || event.metaKey || event.ctrlKey || event.altKey) return;
		if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
		event.preventDefault();
		void notes.newNote(folder()).then(open);
	}
</script>

<svelte:window onkeydown={keydown} />
<svelte:head><title>{heading} · Notes · YonDrive</title></svelte:head>

<div class="screen">
	<div class="head">
		<div class="titles">
			<h1>{heading}</h1>
			<span class="count">{count} {count === 1 ? 'note' : 'notes'} shown</span>
		</div>
		<div class="tools">
			<div class="search">
				<label for="notes-search" class="sr">Search notes</label>
				<span class="search-icon"><Icon name="search" size={17} /></span>
				<input
					id="notes-search"
					type="search"
					placeholder="Search, # for tags, [[ for links"
					autocomplete="off"
					bind:value={query}
				/>
				{#if (mode === 'tag' && tagMatches.length > 0) || (mode === 'title' && titleMatches.length > 0)}
					<div class="suggest" role="listbox" aria-label="Suggestions">
						{#if mode === 'tag'}
							{#each tagMatches.slice(0, 8) as t (t.tag)}
								<button
									type="button"
									role="option"
									aria-selected="false"
									onclick={() => {
										notes.tag = t.tag;
										query = '';
									}}>#{t.tag} <span class="muted">{t.count}</span></button
								>
							{/each}
						{:else}
							{#each titleMatches as m (m.id)}
								<button
									type="button"
									role="option"
									aria-selected="false"
									onclick={() => void goto(resolve(`/notes/${m.id}`))}
									><Icon name="note" size={14} /> {m.title}</button
								>
							{/each}
						{/if}
					</div>
				{/if}
			</div>
			<div class="seg" role="group" aria-label="View">
				<button
					type="button"
					aria-label="Card view"
					aria-pressed={notes.view === 'cards'}
					class:on={notes.view === 'cards'}
					onclick={() => notes.setView('cards')}><Icon name="cards" size={16} /></button
				>
				<button
					type="button"
					aria-label="List view"
					aria-pressed={notes.view === 'list'}
					class:on={notes.view === 'list'}
					onclick={() => notes.setView('list')}><Icon name="list" size={16} /></button
				>
			</div>
		</div>
	</div>

	{#if notes.section !== 'trash' && notes.section !== 'shared'}
		<form class="capture" onsubmit={captureNote}>
			<label for="capture" class="sr">Quick note</label>
			<input
				id="capture"
				placeholder={checklist ? 'Name a checklist…' : 'Take a note…'}
				autocomplete="off"
				bind:value={capture}
				disabled={busy}
			/>
			<div class="capture-tools">
				<button
					type="button"
					class="ghost"
					class:on={checklist}
					aria-label="New checklist"
					aria-pressed={checklist}
					title="Checklist"
					onclick={() => (checklist = !checklist)}><Icon name="list-check" size={18} /></button
				>
				<button
					type="button"
					class="ghost"
					aria-label="Note with image"
					title="Image"
					onclick={() => picker?.click()}><Icon name="image" size={18} /></button
				>
				<span class="rule" aria-hidden="true"></span>
				<Menu
					label="Templates"
					heading="New from a template"
					items={templates}
					width={260}
					onselect={(id) => void fromTemplate(id)}
				>
					{#snippet trigger(attrs)}
						<button type="button" class="ghost text" {...attrs}
							><Icon name="template" size={16} /> Templates</button
						>
					{/snippet}
				</Menu>
				<button type="button" class="today" onclick={() => void today()}
					><Icon name="calendar" size={16} /> Today’s note</button
				>
			</div>
		</form>
		<input
			bind:this={picker}
			type="file"
			accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
			hidden
			data-testid="capture-image"
			onchange={captureImage}
		/>
	{/if}

	{#if notes.section !== 'trash'}
		<div class="filters" role="group" aria-label="Filters">
			{#each CHIPS as c (c.id)}
				<button
					type="button"
					class="chip"
					class:on={notes.chips.includes(c.id)}
					aria-pressed={notes.chips.includes(c.id)}
					onclick={() => notes.toggleChip(c.id)}
				>
					<Icon name={c.icon} size={14} strokeWidth={1.9} />
					{c.label}
				</button>
			{/each}
			{#if notes.tag}
				<button type="button" class="chip on" onclick={() => (notes.tag = null)}>
					#{notes.tag}
					<Icon name="close" size={12} />
				</button>
			{/if}
			<span class="sort">
				<label for="notes-sort" class="sr">Sort notes</label>
				<Select
					id="notes-sort"
					options={SORTS}
					value={notes.sort}
					onchange={(e) => notes.setSort(e.currentTarget.value as NoteSort)}
				/>
			</span>
		</div>
	{/if}

	{#if notes.failed}
		<p class="problem">{notes.failed}</p>
	{:else if notes.section === 'trash'}
		{#if trashed.length === 0}
			<EmptyState title="The trash is empty" icon="trash">
				Notes and notebooks you delete stay here until the trash is emptied.
			</EmptyState>
		{:else}
			<ul class="trash">
				{#each trashed as node (node.id)}
					<li>
						<Icon name={node.kind === 'folder' ? 'notebook' : 'note'} size={18} />
						<span class="trash-name">{node.kind === 'folder' ? node.name : titleOf(node.name)}</span
						>
						<span class="muted">{formatWhen(node.trashedAt ?? node.updatedAt)}</span>
						{#if node.removeAt === null}
							<Button size="sm" onclick={() => void restore(node)}>Restore</Button>
							<Button size="sm" variant="ghost" onclick={() => void purge(node)}
								>Delete forever</Button
							>
						{:else}
							<span class="muted">Being deleted</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{:else if shown.length === 0}
		{#if items.length === 0 && notes.section === 'all' && notes.notebook === null}
			<EmptyState title="No notes yet" icon="note">
				Take a note above, or start today’s. Notes are Markdown files kept with your files.
			</EmptyState>
		{:else}
			<div class="none">No notes match these filters.</div>
		{/if}
	{:else if notes.view === 'cards'}
		{#if pinned.length > 0}
			<section class="group">
				<h2>Pinned</h2>
				<div class="cards">
					{#each pinned as item (item.id)}<NoteCard {item} layout="card" onpin={pin} />{/each}
				</div>
			</section>
		{/if}
		{#if others.length > 0}
			<section class="group">
				<h2>{pinned.length > 0 ? 'Others' : 'Notes'}</h2>
				<div class="cards">
					{#each others as item (item.id)}<NoteCard {item} layout="card" onpin={pin} />{/each}
				</div>
			</section>
		{/if}
	{:else}
		<div class="rows">
			{#each [...pinned, ...others] as item (item.id)}<NoteCard
					{item}
					layout="row"
					onpin={pin}
				/>{/each}
		</div>
	{/if}
</div>

<NotesDialogs />

<style>
	.screen {
		display: flex;
		flex-direction: column;
		gap: 22px;
		padding: 28px 32px 56px;
		min-width: 0;
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px 16px;
	}

	.titles {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}

	h1 {
		margin: 0;
		font-size: 28px;
		font-weight: 600;
		letter-spacing: -0.025em;
		color: var(--text-strong);
	}

	.count,
	.muted {
		font-size: 13px;
		color: var(--text-muted);
	}

	.tools {
		margin-left: auto;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		flex: 1 1 360px;
	}

	.search {
		position: relative;
		flex: 1 1 260px;
		max-width: 420px;
		display: flex;
		align-items: center;
	}

	.search-icon {
		position: absolute;
		left: 13px;
		display: grid;
		color: var(--text-muted);
	}

	.search input {
		width: 100%;
		box-sizing: border-box;
		height: 42px;
		padding: 0 14px 0 38px;
		border: 1px solid var(--border-field);
		border-radius: 12px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
		outline-color: var(--notes);
	}

	.suggest {
		position: absolute;
		top: 46px;
		left: 0;
		right: 0;
		z-index: 20;
		display: flex;
		flex-direction: column;
		padding: 6px;
		border: 1px solid var(--border-strong);
		border-radius: 12px;
		background: var(--surface);
		box-shadow: var(--shadow-lg);
	}

	.suggest button {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 36px;
		padding: 0 10px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-strong);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.suggest button:hover,
	.suggest button:focus-visible {
		background: var(--surface-sunken);
	}

	.seg {
		display: flex;
		gap: 2px;
		padding: 3px;
		border-radius: 11px;
		background: var(--surface-hover);
	}

	.seg button {
		width: 36px;
		height: 32px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-soft);
		cursor: pointer;
	}

	.seg button.on {
		background: var(--surface);
		box-shadow: var(--shadow-sm);
	}

	.capture {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 8px 8px 8px 16px;
		border: 1px solid var(--border-field);
		border-radius: 16px;
		background: var(--surface);
		box-shadow: var(--shadow-lg);
	}

	.capture input {
		flex: 1 1 240px;
		min-width: 0;
		height: 42px;
		border: 0;
		background: transparent;
		color: var(--text-strong);
		font: inherit;
		font-size: 15px;
		outline: none;
	}

	.capture-tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px;
		color: var(--text-soft);
	}

	.ghost {
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.ghost.text {
		width: auto;
		display: flex;
		gap: 6px;
		padding: 0 12px;
		font: inherit;
		font-size: 13px;
		font-weight: 500;
	}

	.ghost:hover {
		background: var(--surface-hover);
	}

	.ghost.on {
		background: var(--notes-soft);
		color: var(--notes-ink);
	}

	.rule {
		width: 1px;
		height: 22px;
		margin: 0 6px;
		background: var(--border-strong);
	}

	.today {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 40px;
		padding: 0 14px;
		border: 0;
		border-radius: 10px;
		background: var(--notes-soft);
		color: var(--notes-ink);
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
	}

	.today:hover {
		background: var(--notes-soft-2);
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.chip {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 12px;
		border: 1px solid var(--border-strong);
		border-radius: 99px;
		background: var(--surface);
		color: var(--text-soft);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}

	.chip.on {
		background: var(--notes-soft);
		border-color: var(--notes-line);
		color: var(--notes-ink);
	}

	.sort {
		margin-left: auto;
		min-width: 150px;
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	h2 {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.cards {
		columns: 250px;
		column-gap: 14px;
	}

	.rows {
		border: 1px solid var(--border);
		border-radius: 16px;
		background: var(--surface);
		overflow: hidden;
	}

	.none {
		padding: 56px 20px;
		text-align: center;
		border: 1px dashed var(--border-strong);
		border-radius: 16px;
		color: var(--text-muted);
	}

	.problem {
		color: var(--danger-ink);
	}

	.trash {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 16px;
		background: var(--surface);
	}

	.trash li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--divider);
		color: var(--text-strong);
	}

	.trash-name {
		flex: 1;
		min-width: 0;
		font-weight: 500;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	@media (max-width: 720px) {
		.screen {
			padding: 16px 16px 48px;
		}

		.capture {
			padding: 8px;
		}

		.capture input {
			padding-left: 8px;
		}

		.sort {
			margin-left: 0;
		}
	}
</style>
