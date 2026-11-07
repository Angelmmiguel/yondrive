<!--
  A list of nodes, in the list or grid of the Home board, with its sort, filter,
  multi-select toolbar and each node's menu. It fills in thumbnails as they open.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import { formatBytes, formatDay, formatWhen } from '$lib/app/format';
	import {
		Button,
		EmptyState,
		FILE_KINDS,
		FileList,
		FileRow,
		FileTile,
		Menu,
		SegmentedControl,
		type FileTag,
		type IconName,
		type MenuItem
	} from '$lib/components';
	import { canChangePlace, canWrite, isOwner } from '$lib/sharing/roles';
	import { drive } from '$lib/state/drive.svelte';
	import { sharing } from '$lib/state/sharing.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import { fileKindOf } from '../kinds';
	import type { KindFilter, SortKey } from '../sort';
	import type { DriveNode } from '../tree';
	import { formatOf } from '$lib/formats/document';
	import { viewerFor } from '../viewers/kinds';

	/** Whether a file opens in the app: in a viewer, or in the editor. */
	const opensHere = (node: DriveNode) => viewerFor(node) !== null || formatOf(node.name) !== null;

	interface Props {
		nodes: readonly DriveNode[];
		label: string;
		/** A trash list has other actions, and shows when things go. */
		trash?: boolean;
		emptyTitle: string;
		emptyIcon?: IconName;
		empty?: Snippet;
		/** The left end of the header: a heading or breadcrumbs. */
		header?: Snippet;
		/** Whether the list is still arriving. */
		loading?: boolean;
	}

	let {
		nodes,
		label,
		trash = false,
		emptyTitle,
		emptyIcon = 'folder',
		empty,
		header,
		loading = false
	}: Props = $props();

	const shown = $derived(drive.arrange(nodes));
	let selected = $state.raw<string[]>([]);
	const chosen = $derived(shown.filter((node) => selected.includes(node.id)));
	const allChosen = $derived(shown.length > 0 && chosen.length === shown.length);

	$effect(() => {
		// What left the list, moved or trashed say, is not selected any more.
		const kept = selected.filter((id) => shown.some((node) => node.id === id));
		if (kept.length !== selected.length) selected = kept;
	});

	function toggle(id: string, on: boolean) {
		selected = on ? [...selected, id] : selected.filter((other) => other !== id);
	}

	function toggleAll(on: boolean) {
		selected = on ? shown.map((node) => node.id) : [];
	}

	const SORTS: { id: SortKey; label: string }[] = [
		{ id: 'modified', label: 'Last modified' },
		{ id: 'name', label: 'Name' },
		{ id: 'size', label: 'Size' }
	];
	const FILTERS: { id: KindFilter; label: string }[] = [
		{ id: 'all', label: 'Everything' },
		{ id: 'folders', label: 'Folders' },
		{ id: 'documents', label: 'Documents' },
		{ id: 'images', label: 'Images' },
		{ id: 'video', label: 'Video' },
		{ id: 'other', label: 'Other files' }
	];
	const sortLabel = $derived(SORTS.find((s) => s.id === drive.sort)?.label ?? '');
	const filterLabel = $derived(
		drive.filter === 'all' ? 'Filter' : (FILTERS.find((f) => f.id === drive.filter)?.label ?? '')
	);

	const VIEWS = [
		{ value: 'list', label: 'List view', icon: 'list', iconOnly: true },
		{ value: 'grid', label: 'Grid view', icon: 'grid', iconOnly: true }
	] as const;

	const href = (node: DriveNode) =>
		node.kind === 'folder' && !trash ? resolve(`/files/${node.id}`) : undefined;

	/** A click on the name: a folder is a link, and a file opens or downloads. */
	function activate(node: DriveNode) {
		if (node.kind === 'folder' || trash || !node.readable) return;
		if (opensHere(node)) drive.open(node);
		else void drive.download(node);
	}

	const captionFor = (node: DriveNode): string => {
		if (trash) {
			return node.removeAt !== null
				? `Removed for good on ${formatDay(node.removeAt)}`
				: `Trashed ${formatWhen(node.trashedAt ?? 0)}`;
		}
		if (node.kind === 'folder') {
			if (!drive.folderLoaded(node.id)) return 'Folder';
			const count = drive.children(node.id).length;
			return `Folder · ${count} ${count === 1 ? 'item' : 'items'}`;
		}
		return FILE_KINDS[fileKindOf(node)].label;
	};

	const tagsOf = (node: DriveNode): FileTag[] =>
		node.tags.flatMap((id) => {
			const tag = drive.tags.find((t) => t.id === id);
			return tag === undefined ? [] : [{ name: tag.name, tone: tag.tone }];
		});

	/** The role over the folder it lives in, if that is known here. */
	const movable = (node: DriveNode) =>
		canChangePlace(node, node.parentId === null ? undefined : drive.node(node.parentId));

	const peopleOf = (node: DriveNode) => {
		void drive.rev;
		return sharing.peopleOf(drive.core?.tree.breadcrumbs(node.id) ?? []);
	};

	function itemsOf(node: DriveNode): MenuItem[] {
		if (trash) {
			return [
				{ id: 'restore', label: 'Restore' },
				...(node.removeAt === null ? [{ id: 'purge', label: 'Delete forever' }] : [])
			];
		}
		const place = movable(node);
		const holding = sharing.entryOf(node.id);
		const leave: MenuItem[] =
			holding === undefined ? [] : [{ id: 'leave', label: 'Remove from shared', icon: 'close' }];
		if (!node.readable) {
			return [
				...(place ? [{ id: 'trash', label: 'Move to trash', icon: 'trash' as const }] : []),
				...leave
			];
		}
		const file = node.kind === 'file';
		return [
			...(file && opensHere(node) ? [{ id: 'open', label: 'Open', icon: 'eye' as const }] : []),
			// Text that opens in the viewer can also be edited as a document.
			...(file && canWrite(node) && viewerFor(node) !== null && formatOf(node.name) !== null
				? [{ id: 'edit', label: 'Edit', icon: 'pencil' as const }]
				: []),
			...(file ? [{ id: 'download', label: 'Download', icon: 'download' as const }] : []),
			...(isOwner(node) ? [{ id: 'share', label: 'Share', icon: 'shared' as const }] : []),
			...(place
				? [
						{ id: 'rename', label: 'Rename', icon: 'pencil' as const },
						{ id: 'move', label: 'Move', icon: 'move' as const }
					]
				: []),
			...(isOwner(node) ? [{ id: 'tags', label: 'Tags', icon: 'tag' as const }] : []),
			...(file ? [{ id: 'versions', label: 'Versions', icon: 'history' as const }] : []),
			...(place ? [{ id: 'trash', label: 'Move to trash', icon: 'trash' as const }] : []),
			...leave
		];
	}

	async function act(node: DriveNode, id: string) {
		switch (id) {
			case 'open':
				drive.open(node);
				break;
			case 'edit':
				drive.edit(node);
				break;
			case 'download':
				await drive.download(node);
				break;
			case 'share':
				drive.dialog = { kind: 'share', node };
				break;
			case 'leave': {
				const entry = sharing.entryOf(node.id);
				if (entry === undefined) break;
				await drive.run(async (core) => {
					await core.sharing.leave(entry.grant.id, node.id);
					core.tree.drop(node.id);
					sharing.publish();
				});
				break;
			}
			case 'rename':
				drive.dialog = { kind: 'rename', node };
				break;
			case 'move':
				drive.dialog = { kind: 'move', nodes: [node] };
				break;
			case 'tags':
				drive.dialog = { kind: 'tags', nodes: [node] };
				break;
			case 'versions':
				drive.versionsOf = node;
				break;
			case 'trash':
				await moveToTrash([node]);
				break;
			case 'restore':
				await restore([node]);
				break;
			case 'purge':
				drive.dialog = { kind: 'purge', node };
				break;
		}
	}

	async function moveToTrash(list: readonly DriveNode[]) {
		await drive.run(async (core) => {
			for (const node of list) await core.tree.trash(node.id);
			await drive.loadTrash();
		});
		toasts.push(
			'info',
			list.length === 1 ? 'Moved to trash.' : `${list.length} items moved to trash.`
		);
	}

	async function restore(list: readonly DriveNode[]) {
		await drive.run(async (core) => {
			for (const node of list) await core.tree.restore(node.id);
			await drive.loadTrash();
		});
		void drive.refreshStorage();
	}

	const setFavorite = (node: DriveNode, favorite: boolean) =>
		drive.run((core) => core.tree.patch(node.id, { favorite }));

	async function downloadChosen() {
		for (const node of chosen) if (node.kind === 'file') await drive.download(node);
	}

	/** Reads thumbnails once they scroll near. */
	let thumbs = $state<Record<string, string | null>>({});

	function lazyThumb(element: HTMLElement, node: DriveNode) {
		const load = (current: DriveNode) => {
			const blobId = current.thumbBlobId;
			if (blobId === null || blobId in thumbs) return;
			void drive.core?.thumbs.urlFor(current).then((url) => {
				thumbs = { ...thumbs, [blobId]: url };
			});
		};
		let current = node;
		let seen = false;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					seen = true;
					load(current);
					observer.disconnect();
				}
			},
			{ rootMargin: '200px' }
		);
		observer.observe(element);
		return {
			update(next: DriveNode) {
				current = next;
				if (seen) load(next);
			},
			destroy: () => observer.disconnect()
		};
	}

	const thumbOf = (node: DriveNode) =>
		node.thumbBlobId === null ? null : (thumbs[node.thumbBlobId] ?? null);
</script>

{#snippet check(node: DriveNode)}
	<input
		type="checkbox"
		class="pick"
		aria-label="Select {node.name}"
		checked={selected.includes(node.id)}
		onchange={(event) => toggle(node.id, event.currentTarget.checked)}
	/>
{/snippet}

{#snippet more(node: DriveNode)}
	<Menu
		label="Actions for {node.name}"
		items={itemsOf(node)}
		floating
		width={200}
		onselect={(id) => void act(node, id)}
	>
		{#snippet trigger(attrs)}
			<button type="button" class="more" aria-label="Actions for {node.name}" {...attrs}>
				<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
					<circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle
						cx="19"
						cy="12"
						r="1.8"
					/>
				</svg>
			</button>
		{/snippet}
	</Menu>
{/snippet}

<section class="browser" aria-label={label}>
	<div class="head">
		<div class="title">{@render header?.()}</div>
		<div class="controls">
			<Menu
				label="Filter by kind"
				triggerLabel={filterLabel}
				triggerIcon="filter"
				width={180}
				items={FILTERS}
				onselect={(id) => (drive.filter = id as KindFilter)}
			/>
			<Menu
				label="Sort by"
				triggerLabel={sortLabel}
				width={180}
				items={SORTS}
				onselect={(id) => drive.setSort(id as SortKey)}
			/>
			<SegmentedControl
				label="View"
				options={VIEWS}
				value={drive.viewMode}
				onchange={(value) => drive.setView(value as 'list' | 'grid')}
			/>
		</div>
	</div>

	{#if chosen.length > 0}
		<div class="toolbar" role="toolbar" aria-label="Selected items">
			<span class="count">{chosen.length} selected</span>
			{#if trash}
				<Button size="sm" onclick={() => restore(chosen)}>Restore</Button>
			{:else}
				{#if chosen.some((n) => n.kind === 'file')}
					<Button size="sm" icon="download" onclick={downloadChosen}>Download</Button>
				{/if}
				{#if chosen.every(movable)}
					<Button
						size="sm"
						icon="move"
						onclick={() => (drive.dialog = { kind: 'move', nodes: chosen })}>Move</Button
					>
				{/if}
				{#if chosen.every(isOwner)}
					<Button
						size="sm"
						icon="tag"
						onclick={() => (drive.dialog = { kind: 'tags', nodes: chosen })}>Tags</Button
					>
				{/if}
				{#if chosen.every(movable)}
					<Button size="sm" icon="trash" onclick={() => moveToTrash(chosen)}>Move to trash</Button>
				{/if}
			{/if}
			<Button size="sm" variant="ghost" onclick={() => toggleAll(false)}>Clear</Button>
		</div>
	{/if}

	{#if shown.length === 0}
		{#if !loading}
			<EmptyState title={emptyTitle} icon={emptyIcon}>{@render empty?.()}</EmptyState>
		{/if}
	{:else if drive.viewMode === 'list'}
		<FileList {label}>
			{#snippet selectAll()}
				<input
					type="checkbox"
					class="pick"
					aria-label="Select all"
					checked={allChosen}
					onchange={(event) => toggleAll(event.currentTarget.checked)}
				/>
			{/snippet}
			{#each shown as node (node.id)}
				<div class="item" use:lazyThumb={node}>
					<FileRow
						name={node.name}
						kind={fileKindOf(node)}
						caption={captionFor(node)}
						tags={tagsOf(node)}
						people={peopleOf(node)}
						modified={formatWhen(node.modified || node.updatedAt)}
						size={node.kind === 'file' ? formatBytes(node.size) : '—'}
						starred={node.favorite}
						selected={selected.includes(node.id)}
						href={href(node)}
						thumbnail={thumbOf(node)}
						onselect={() => activate(node)}
						onstar={isOwner(node) ? (on) => void setFavorite(node, on) : undefined}
					>
						{#snippet leading()}{@render check(node)}{/snippet}
						{#snippet actions()}{@render more(node)}{/snippet}
					</FileRow>
				</div>
			{/each}
		</FileList>
	{:else}
		<div class="grid">
			{#each shown as node (node.id)}
				<div use:lazyThumb={node}>
					<FileTile
						name={node.name}
						kind={fileKindOf(node)}
						modified={trash ? captionFor(node) : formatWhen(node.modified || node.updatedAt)}
						size={node.kind === 'file' ? formatBytes(node.size) : undefined}
						starred={node.favorite}
						selected={selected.includes(node.id)}
						href={href(node)}
						thumbnail={thumbOf(node)}
						onselect={() => activate(node)}
						onstar={isOwner(node) ? (on) => void setFavorite(node, on) : undefined}
					>
						{#snippet leading()}{@render check(node)}{/snippet}
						{#snippet actions()}{@render more(node)}{/snippet}
					</FileTile>
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	.browser {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
	}

	.title {
		min-width: 0;
	}

	.controls {
		margin-left: auto;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border: 1px solid var(--accent-ring);
		border-radius: 12px;
		background: var(--surface-selected);
	}

	.count {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-strong);
		margin-right: 4px;
	}

	/* A row draws no border as the last child of its wrapper, so the list draws them. */
	.item + .item {
		border-top: 1px solid var(--divider);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
		gap: 14px;
	}

	.pick {
		width: 16px;
		height: 16px;
		margin: 0;
		accent-color: var(--accent);
		cursor: pointer;
	}

	.more {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
	}

	.more:hover {
		background: var(--surface-hover);
	}
</style>
