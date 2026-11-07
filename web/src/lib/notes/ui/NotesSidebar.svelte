<!--
  The left column of Notes, from the list board: a new note, the sections with
  their counts, notebooks with their colours, tags in use, and where notes are
  kept. Choosing anything here shows it in the list.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { formatBytes } from '$lib/app/format';
	import { Icon, Menu, NavItem, type IconName, type MenuItem } from '$lib/components';
	import type { Section } from '$lib/notes/list';
	import { notebookColor } from '$lib/notes/model';
	import { drive } from '$lib/state/drive.svelte';
	import { notes } from '$lib/state/notes.svelte';
	import { session } from '$lib/state/session.svelte';

	const items = $derived.by(() => {
		void drive.rev;
		return notes.items();
	});
	const trashed = $derived(notes.trashed(drive.allTrash));
	const counts = $derived(notes.counts(items, trashed.length));
	const notebooks = $derived.by(() => {
		void drive.rev;
		return notes.notebooks();
	});
	const tags = $derived(notes.tags(items).slice(0, 24));
	const own = $derived(items.filter((i) => !i.shared));
	const bytes = $derived(own.reduce((n, i) => n + i.node.size, 0));
	const storedAs = $derived(session.sealer?.storedAs('Markdown') ?? 'Markdown');
	const onList = $derived(page.url.pathname === '/notes');

	const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
		{ id: 'all', label: 'All notes', icon: 'note' },
		{ id: 'today', label: 'Today', icon: 'calendar' },
		{ id: 'pinned', label: 'Pinned', icon: 'pin' },
		{ id: 'tasks', label: 'Tasks', icon: 'list-check' },
		{ id: 'shared', label: 'Shared', icon: 'shared' },
		{ id: 'archive', label: 'Archive', icon: 'archive' },
		{ id: 'trash', label: 'Trash', icon: 'trash' }
	];

	function show(section: Section) {
		notes.section = section;
		notes.notebook = null;
		notes.tag = null;
		if (!onList) void goto(resolve('/notes'));
	}

	function showNotebook(id: string) {
		notes.notebook = notes.notebook === id ? null : id;
		notes.section = 'all';
		if (!onList) void goto(resolve('/notes'));
	}

	function showTag(tag: string) {
		notes.tag = notes.tag === tag ? null : tag;
		if (!onList) void goto(resolve('/notes'));
	}

	async function newNote() {
		const made = await notes.newNote(notes.notebook);
		if (made) await goto(resolve(`/notes/${made.id}`));
	}

	const notebookMenu: MenuItem[] = [
		{ id: 'rename', label: 'Rename or recolour…', icon: 'pencil' },
		{ id: 'share', label: 'Share…', icon: 'shared' },
		{ id: 'delete', label: 'Move to trash', icon: 'trash' }
	];

	function chooseNotebook(id: string, action: string) {
		const node = drive.node(id);
		if (node === undefined) return;
		if (action === 'rename') notes.dialog = { kind: 'notebook', node };
		else if (action === 'share') drive.dialog = { kind: 'share', node };
		else notes.dialog = { kind: 'delete-notebook', node };
	}
</script>

<button type="button" class="new" onclick={() => void newNote()}>
	<Icon name="plus" size={18} strokeWidth={2} />
	New note
	<span class="key" aria-hidden="true">N</span>
</button>

<nav class="sections" aria-label="Notes sections">
	{#each SECTIONS as s (s.id)}
		<NavItem
			label={s.label}
			icon={s.icon}
			count={s.id === 'trash' ? counts.trash || undefined : counts[s.id]}
			current={onList && notes.notebook === null && notes.section === s.id}
			onclick={() => show(s.id)}
		/>
	{/each}
</nav>

<section class="group" aria-labelledby="notebooks-heading">
	<div class="group-head">
		<h2 id="notebooks-heading">Notebooks</h2>
		<button
			type="button"
			class="tiny"
			aria-label="New notebook"
			onclick={() => (notes.dialog = { kind: 'notebook', node: null })}
		>
			<Icon name="plus" size={14} strokeWidth={2} />
		</button>
	</div>
	{#each notebooks as nb (nb.id)}
		{@const color = notebookColor(nb.raw)}
		<div class="notebook" class:on={notes.notebook === nb.id}>
			<button
				type="button"
				class="nb"
				aria-pressed={notes.notebook === nb.id}
				onclick={() => showNotebook(nb.id)}
			>
				<span class="nb-icon" style:color="var(--notebook-{color})"
					><Icon name="notebook" size={17} strokeWidth={1.9} /></span
				>
				<span class="nb-name">{nb.name}</span>
				<span class="count">{items.filter((i) => i.notebook?.id === nb.id).length}</span>
			</button>
			<Menu
				label="{nb.name} notebook"
				items={notebookMenu}
				width={220}
				floating
				onselect={(action) => chooseNotebook(nb.id, action)}
			>
				{#snippet trigger(attrs)}
					<button type="button" class="tiny more" aria-label="{nb.name} options" {...attrs}>
						<Icon name="more" size={16} />
					</button>
				{/snippet}
			</Menu>
		</div>
	{:else}
		<p class="hint">Group notes in notebooks.</p>
	{/each}
</section>

{#if tags.length > 0}
	<section class="group" aria-labelledby="tags-heading">
		<h2 id="tags-heading" class="pad">Tags</h2>
		<div class="tags">
			{#each tags as t (t.tag)}
				<button
					type="button"
					class="chip"
					class:on={notes.tag === t.tag}
					aria-pressed={notes.tag === t.tag}
					onclick={() => showTag(t.tag)}>#{t.tag}</button
				>
			{/each}
		</div>
	</section>
{/if}

<div class="spacer"></div>

<div class="storage" data-testid="notes-storage">
	<span class="strong"
		>{own.length} {own.length === 1 ? 'note' : 'notes'} · {formatBytes(bytes)}</span
	>
	<span>{storedAs} files, counted in your storage.</span>
	<button
		type="button"
		class="export"
		disabled={notes.exporting}
		onclick={() => void notes.exportAll()}
	>
		<Icon name="download" size={14} />
		{notes.exporting ? 'Exporting…' : 'Export all notes'}
	</button>
</div>

<style>
	.new {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		padding: 0 14px;
		border: 0;
		border-radius: 12px;
		background: var(--primary);
		color: var(--on-primary);
		font: inherit;
		font-weight: 500;
		cursor: pointer;
	}

	.key {
		margin-left: auto;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--primary-sub);
		padding: 1px 6px;
		border: 1px solid var(--primary-line);
		border-radius: 5px;
	}

	.sections,
	.group {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.group-head {
		display: flex;
		align-items: center;
		padding: 0 10px 6px;
	}

	h2 {
		margin: 0;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	h2.pad {
		padding: 0 10px 6px;
	}

	.tiny {
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		margin-left: auto;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
	}

	.tiny:hover {
		background: var(--surface-hover);
	}

	.notebook {
		display: flex;
		align-items: center;
		border-radius: 9px;
	}

	.notebook:hover {
		background: var(--surface-hover);
	}

	.notebook.on {
		background: var(--surface);
		box-shadow: var(--shadow-sm);
	}

	.nb {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 11px;
		min-height: 36px;
		padding: 0 4px 0 10px;
		border: 0;
		background: transparent;
		color: var(--text-body);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.nb-icon {
		display: grid;
	}

	.nb-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.count {
		font-size: 12px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.more {
		margin: 0 4px 0 0;
		opacity: 0;
	}

	.notebook:hover .more,
	.notebook.on .more,
	.more:focus-visible,
	.more[aria-expanded='true'] {
		opacity: 1;
	}

	@media (hover: none) {
		.more {
			opacity: 1;
		}
	}

	.hint {
		margin: 0;
		padding: 0 10px;
		font-size: 13px;
		color: var(--text-muted);
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 0 10px;
	}

	.chip {
		height: 28px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: 99px;
		background: var(--surface);
		color: var(--text-soft);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.chip.on {
		background: var(--notes-soft);
		border-color: var(--notes-line);
		color: var(--notes-ink);
	}

	.spacer {
		flex-grow: 1;
	}

	.storage {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: 14px;
		background: var(--surface);
		font-size: 12px;
		color: var(--text-muted);
	}

	.strong {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-strong);
	}

	.export {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 6px;
		height: 30px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text-body);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
	}

	.export:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
