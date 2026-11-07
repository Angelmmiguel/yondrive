<!-- The dialogs of the drive: new folder, rename, move, tags, and the two that ask first. -->
<script lang="ts">
	import { untrack } from 'svelte';
	import { formatDay } from '$lib/app/format';
	import { Banner, Button, Checkbox, Dialog, Field, Icon, TextInput } from '$lib/components';
	import { drive } from '$lib/state/drive.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import { describeDriveError } from '../errors';
	import type { DriveNode } from '../tree';
	import { isApiError } from '$lib/api/types';
	import { session } from '$lib/state/session.svelte';

	const dialog = $derived(drive.dialog);
	let name = $state('');
	let error = $state('');
	let busy = $state(false);
	let target = $state<string | null>(null);
	let browsing = $state<string | null>(null);

	$effect(() => {
		// Only a new dialog starts over: the tree changes under an open one.
		const open = drive.dialog;
		untrack(() => {
			error = '';
			busy = false;
			name = open?.kind === 'rename' ? open.node.name : '';
			target = null;
			browsing = drive.rootId;
			if (open?.kind === 'move') void drive.core?.tree.loadFolder(drive.rootId as string);
		});
	});

	function close() {
		drive.dialog = null;
	}

	/** Runs the dialog's action, and stays open with the sentence if it fails. */
	async function attempt(action: () => Promise<unknown>) {
		busy = true;
		error = '';
		try {
			await action();
			close();
		} catch (e) {
			if (isApiError(e, 'unauthorized')) session.signedOut();
			error = describeDriveError(e);
		} finally {
			busy = false;
		}
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		const open = drive.dialog;
		const core = drive.core;
		if (open === null || core === null) return;
		if (open.kind === 'new-folder') {
			void attempt(() => core.tree.createFolder(open.parentId, name));
		} else if (open.kind === 'rename') {
			void attempt(() => core.tree.rename(open.node.id, name));
		} else if (open.kind === 'new-tag') {
			void attempt(() => core.tree.createTag(name));
		}
	}

	const movable = (nodes: readonly DriveNode[], folder: DriveNode) =>
		!nodes.some((node) => drive.core?.tree.isWithin(folder.id, node.id));

	async function openFolder(id: string) {
		browsing = id;
		target = id;
		await drive.core?.tree.loadFolder(id).catch(() => {});
	}

	const here = $derived(browsing === null ? undefined : drive.node(browsing));
	const folders = $derived(
		browsing === null
			? []
			: drive
					.children(browsing)
					.filter((node) => node.kind === 'folder')
					.sort((a, b) => a.name.localeCompare(b.name))
	);

	function move(nodes: readonly DriveNode[]) {
		const destination = target ?? browsing;
		const core = drive.core;
		if (destination === null || core === null) return;
		void attempt(async () => {
			for (const node of nodes) await core.tree.move(node.id, destination);
			toasts.push('ok', nodes.length === 1 ? 'Moved.' : `${nodes.length} items moved.`);
		});
	}

	function hasTag(nodes: readonly DriveNode[], tag: string): boolean {
		return nodes.every((node) => (drive.node(node.id) ?? node).tags.includes(tag));
	}

	function setTag(nodes: readonly DriveNode[], tag: string, on: boolean) {
		void drive.run(async (core) => {
			for (const node of nodes) {
				const current = drive.node(node.id) ?? node;
				const without = current.tags.filter((id) => id !== tag);
				await core.tree.patch(node.id, { tags: on ? [...without, tag] : without });
			}
		});
	}

	async function createAndAssign(nodes: readonly DriveNode[], event: SubmitEvent) {
		event.preventDefault();
		const core = drive.core;
		if (core === null) return;
		try {
			const tag = await core.tree.createTag(name);
			name = '';
			error = '';
			setTag(nodes, tag.id, true);
		} catch (e) {
			error = describeDriveError(e);
		}
	}

	function purge(node: DriveNode) {
		const core = drive.core;
		if (core === null) return;
		void attempt(async () => {
			const marked = await core.tree.purge(node.id);
			await drive.loadTrash();
			if (marked.removeAt !== null) {
				toasts.push(
					'info',
					`It will be removed for good on ${formatDay(marked.removeAt)}. You can restore it until then.`
				);
			}
		});
	}

	function emptyTrash() {
		const core = drive.core;
		if (core === null) return;
		void attempt(async () => {
			await core.tree.emptyTrash();
			await drive.loadTrash();
		});
	}
</script>

{#if dialog?.kind === 'new-folder' || dialog?.kind === 'rename' || dialog?.kind === 'new-tag'}
	<Dialog
		open
		title={dialog.kind === 'new-folder'
			? 'New folder'
			: dialog.kind === 'rename'
				? 'Rename'
				: 'New tag'}
		width={420}
		onclose={close}
	>
		<form id="name-form" onsubmit={submit}>
			<Field label="Name" {error}>
				{#snippet children(field)}
					<TextInput {...field} bind:value={name} data-autofocus autocomplete="off" />
				{/snippet}
			</Field>
		</form>
		{#snippet footer()}
			<Button variant="ghost" onclick={close}>Cancel</Button>
			<Button variant="primary" type="submit" form="name-form" {busy}>
				{dialog.kind === 'rename' ? 'Rename' : 'Create'}
			</Button>
		{/snippet}
	</Dialog>
{:else if dialog?.kind === 'move'}
	<Dialog
		open
		title={dialog.nodes.length === 1
			? `Move ${dialog.nodes[0].name}`
			: `Move ${dialog.nodes.length} items`}
		width={460}
		onclose={close}
	>
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		<div class="picker" role="group" aria-label="Destination">
			{#if here && here.parentId !== null}
				<button type="button" class="folder up" onclick={() => openFolder(here.parentId as string)}>
					<Icon name="arrow-right" size={16} /> Back
				</button>
			{/if}
			<p class="where">
				Into <strong>{here && here.id !== drive.rootId ? here.name : 'My files'}</strong>
			</p>
			{#each folders as folder (folder.id)}
				<button
					type="button"
					class="folder"
					disabled={!movable(dialog.nodes, folder)}
					onclick={() => openFolder(folder.id)}
				>
					<Icon name="folder" size={16} />
					{folder.name}
				</button>
			{/each}
			{#if folders.length === 0}<p class="none">No folders in here.</p>{/if}
		</div>
		{#snippet footer()}
			<Button variant="ghost" onclick={close}>Cancel</Button>
			<Button variant="primary" {busy} onclick={() => move(dialog.nodes)}>Move here</Button>
		{/snippet}
	</Dialog>
{:else if dialog?.kind === 'tags'}
	<Dialog
		open
		title={dialog.nodes.length === 1
			? `Tags of ${dialog.nodes[0].name}`
			: `Tags of ${dialog.nodes.length} items`}
		width={420}
		onclose={close}
	>
		<div class="tags">
			{#each drive.tags as tag (tag.id)}
				<Checkbox
					checked={hasTag(dialog.nodes, tag.id)}
					onchange={(event) => setTag(dialog.nodes, tag.id, event.currentTarget.checked)}
				>
					{tag.name}
				</Checkbox>
			{/each}
			{#if drive.tags.length === 0}<p class="none">You have no tags yet.</p>{/if}
		</div>
		<form class="add" onsubmit={(event) => createAndAssign(dialog.nodes, event)}>
			<Field label="New tag" {error}>
				{#snippet children(field)}
					<TextInput {...field} bind:value={name} autocomplete="off" />
				{/snippet}
			</Field>
			<Button type="submit" size="sm">Add</Button>
		</form>
		{#snippet footer()}
			<Button variant="primary" onclick={close}>Done</Button>
		{/snippet}
	</Dialog>
{:else if dialog?.kind === 'purge'}
	<Dialog open title="Delete forever?" width={460} onclose={close}>
		<p class="text">
			<strong>{dialog.node.name}</strong> is marked for removal, and the server's grace period starts
			now. It keeps counting against your storage until then, and you can restore it from the trash at
			any point before it goes.
		</p>
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		{#snippet footer()}
			<Button variant="ghost" onclick={close}>Cancel</Button>
			<Button variant="primary" {busy} onclick={() => purge(dialog.node)}>Delete forever</Button>
		{/snippet}
	</Dialog>
{:else if dialog?.kind === 'empty-trash'}
	<Dialog open title="Empty the trash?" width={460} onclose={close}>
		<p class="text">
			Everything in the trash is marked for removal, and the server's grace period starts now. You
			can restore any of it until then.
		</p>
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		{#snippet footer()}
			<Button variant="ghost" onclick={close}>Cancel</Button>
			<Button variant="primary" {busy} onclick={emptyTrash}>Empty trash</Button>
		{/snippet}
	</Dialog>
{/if}

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 320px;
		overflow-y: auto;
	}

	.where {
		margin: 0 0 8px;
		color: var(--text-soft);
	}

	.none,
	.text {
		margin: 0;
		color: var(--text-muted);
	}

	.text {
		color: var(--text-soft);
	}

	.folder {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 40px;
		padding: 0 10px;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: var(--text-strong);
		text-align: left;
		cursor: pointer;
	}

	.folder:hover:not(:disabled) {
		background: var(--surface-hover);
	}

	.folder:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.up :global(svg) {
		transform: rotate(180deg);
	}

	.tags {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 16px;
	}

	.add {
		display: flex;
		align-items: flex-end;
		gap: 8px;
	}

	.add :global(.field) {
		flex: 1;
	}
</style>
