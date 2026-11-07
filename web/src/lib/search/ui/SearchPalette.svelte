<!--
  Search: what is typed goes to the index on this device and nowhere else, and never
  into the address. A result opens, a folder goes on screen, and a file can also jump
  to the folder it is in.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { formatBytes, formatWhen } from '$lib/app/format';
	import { Button, Dialog, Icon, Select, Tag } from '$lib/components';
	import { FILE_KINDS } from '$lib/components/fileKinds';
	import { describeDriveError } from '$lib/drive/errors';
	import { fileKindOf } from '$lib/drive/kinds';
	import { drive } from '$lib/state/drive.svelte';
	import { search } from '$lib/state/search.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import type { SearchHit } from '../types';

	let active = $state(0);

	const TYPES = [
		{ value: 'all', label: 'Any type' },
		{ value: 'folders', label: 'Folders' },
		{ value: 'documents', label: 'Documents' },
		{ value: 'images', label: 'Images' },
		{ value: 'video', label: 'Video' },
		{ value: 'other', label: 'Other files' }
	];
	const DATES = [
		{ value: 'any', label: 'Any time' },
		{ value: 'day', label: 'Last day' },
		{ value: 'week', label: 'Last week' },
		{ value: 'month', label: 'Last month' },
		{ value: 'year', label: 'Last year' }
	];
	const SHARED = [
		{ value: 'any', label: 'Anyone’s' },
		{ value: 'with-me', label: 'Shared with me' },
		{ value: 'mine', label: 'My own' }
	];
	const tags = $derived([
		{ value: '', label: 'Any tag' },
		...drive.tags.map((tag) => ({ value: tag.id, label: tag.name }))
	]);
	const asked = $derived(
		search.text.trim() !== '' ||
			search.type !== 'all' ||
			search.tag !== '' ||
			search.date !== 'any' ||
			search.shared !== 'any'
	);
	const statusText = $derived.by(() => {
		const { phase, items, pending, unsaved } = search.status;
		if (phase === 'loading') return 'Opening the search index…';
		if (pending > 0) return `Indexing: ${pending} ${pending === 1 ? 'file' : 'files'} to read`;
		if (phase === 'indexing') return 'Indexing…';
		if (phase === 'idle') return 'Starting…';
		const held = `${items.toLocaleString()} ${items === 1 ? 'item' : 'items'} indexed on this device`;
		return unsaved ? `${held}, with no room to save it on the server` : held;
	});

	function changed() {
		active = 0;
		search.ask();
	}

	function close() {
		search.hide();
	}

	async function choose(hit: SearchHit) {
		close();
		try {
			// What lives in Notes opens there: a note in its editor, a notebook in the list.
			if (drive.inNotes(hit.id)) {
				if (hit.kind === 'file' && hit.name.toLowerCase().endsWith('.md')) {
					await goto(resolve(`/notes/${hit.id}`));
					return;
				}
				if (hit.kind === 'folder') {
					await goto(resolve('/notes'));
					return;
				}
			}
			if (hit.kind === 'folder') {
				await goto(resolve(`/files/${hit.id}`));
				return;
			}
			const core = drive.core;
			if (core !== null) drive.open(await core.tree.resolve(hit.id));
		} catch (e) {
			toasts.push('danger', describeDriveError(e));
		}
	}

	async function jump(hit: SearchHit) {
		close();
		if (hit.parent === null) await goto(resolve('/shared'));
		else if (drive.inNotes(hit.parent)) await goto(resolve('/notes'));
		else await goto(resolve(`/files/${hit.parent}`));
	}

	function onkeydown(event: KeyboardEvent) {
		const last = search.hits.length - 1;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			active = Math.min(active + 1, last);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			active = Math.max(active - 1, 0);
		} else if (event.key === 'Enter' && search.hits[active] !== undefined) {
			event.preventDefault();
			void choose(search.hits[active]);
		}
	}

	const where = (hit: SearchHit) => {
		const trail = hit.path.join(' / ');
		if (hit.shared) return trail === '' ? 'Shared with me' : `Shared with me / ${trail}`;
		return trail === '' ? 'My files' : `My files / ${trail}`;
	};
</script>

<Dialog
	open={search.open}
	title="Search"
	description="Searched on this device: nothing you type is sent to the server."
	width={720}
	onclose={close}
>
	<div class="palette" data-testid="search-palette">
		<div class="query">
			<span class="glass"><Icon name="search" size={18} /></span>
			<input
				type="search"
				role="combobox"
				aria-expanded="true"
				aria-controls="search-results"
				aria-autocomplete="list"
				aria-activedescendant={search.hits[active] ? `search-hit-${active}` : undefined}
				aria-label="Search for"
				placeholder="Words from a name, a tag or inside a file"
				autocomplete="off"
				spellcheck="false"
				data-autofocus
				bind:value={search.text}
				oninput={changed}
				{onkeydown}
			/>
		</div>
		<div class="filters">
			<Select aria-label="Type" options={TYPES} bind:value={search.type} onchange={changed} />
			<Select aria-label="Tag" options={tags} bind:value={search.tag} onchange={changed} />
			<Select aria-label="Changed" options={DATES} bind:value={search.date} onchange={changed} />
			<Select aria-label="Whose" options={SHARED} bind:value={search.shared} onchange={changed} />
		</div>
		<ul id="search-results" role="listbox" aria-label="Results" data-testid="search-results">
			{#each search.hits as hit, i (hit.id)}
				{@const kind = fileKindOf(hit)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					id="search-hit-{i}"
					role="option"
					aria-selected={i === active}
					class:active={i === active}
					data-testid="search-hit"
					onclick={() => choose(hit)}
					onmousemove={() => (active = i)}
				>
					<span
						class="tile"
						style:background={FILE_KINDS[kind].soft}
						style:color={FILE_KINDS[kind].ink}
					>
						<Icon name={FILE_KINDS[kind].icon} size={16} />
					</span>
					<span class="text">
						<span class="name">{hit.name}</span>
						<span class="meta">
							{FILE_KINDS[kind].label} · {where(hit)}{hit.kind === 'file'
								? ` · ${formatBytes(hit.size)}`
								: ''} · {formatWhen(hit.modified)}
						</span>
					</span>
					{#if hit.matched === 'text'}<Tag tone="grey">In the text</Tag>{/if}
					{#if hit.matched === 'tag'}<Tag tone="grey">Tag</Tag>{/if}
					{#if hit.shared}<Tag tone="blue">Shared</Tag>{/if}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<span class="go" onclick={(e) => e.stopPropagation()}>
						<Button size="sm" variant="ghost" onclick={() => jump(hit)}>Go to folder</Button>
					</span>
				</li>
			{/each}
		</ul>
		{#if asked && search.answered && search.hits.length === 0}
			<p class="empty" data-testid="search-empty">Nothing found.</p>
		{:else if !asked}
			<p class="empty">Type a word, or choose a filter.</p>
		{/if}
		<p class="status" role="status" data-testid="search-status" data-phase={search.status.phase}>
			{statusText}{search.total > search.hits.length
				? ` · showing ${search.hits.length} of ${search.total.toLocaleString()}`
				: ''}
		</p>
	</div>
</Dialog>

<style>
	.palette {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}

	.query {
		position: relative;
		display: flex;
		align-items: center;
	}

	.glass {
		position: absolute;
		left: 14px;
		display: inline-flex;
		color: var(--text-muted);
		pointer-events: none;
	}

	input {
		width: 100%;
		height: 44px;
		padding: 0 14px 0 42px;
		border: 1px solid var(--border-strong);
		border-radius: 12px;
		background: var(--surface);
		color: var(--text-strong);
	}

	input:focus-visible {
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}

	.filters {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(130px, 100%), 1fr));
		gap: 8px;
	}

	ul {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: min(50vh, 420px);
		margin: 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
	}

	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
		padding: 8px;
		border-radius: 10px;
		cursor: pointer;
	}

	li.active {
		background: var(--surface-hover);
	}

	.tile {
		flex: none;
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		border-radius: 9px;
	}

	.text {
		flex: 1 1 220px;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.name {
		font-weight: 500;
		color: var(--text-strong);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		font-size: 12px;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.empty {
		margin: 8px 0;
		text-align: center;
		color: var(--text-muted);
	}

	.status {
		margin: 0;
		padding-top: 8px;
		border-top: 1px solid var(--divider);
		font-size: 12px;
		color: var(--text-muted);
	}
</style>
