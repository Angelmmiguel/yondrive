<!-- A folder. `root` stands for My files, whose id only the server knows until asked. -->
<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Banner, Button } from '$lib/components';
	import { describeDriveError } from '$lib/drive/errors';
	import Breadcrumbs from '$lib/drive/ui/Breadcrumbs.svelte';
	import FileBrowser from '$lib/drive/ui/FileBrowser.svelte';
	import { canWrite } from '$lib/sharing/roles';
	import { drive } from '$lib/state/drive.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import { getContext, untrack } from 'svelte';
	import type { ShellActions } from '../../shell';

	const shell = getContext<ShellActions>('shell');
	const asked = $derived(page.params.id as string);
	const id = $derived(asked === 'root' ? drive.rootId : asked);
	const here = $derived(id === null ? undefined : drive.node(id));
	const nodes = $derived(id === null ? [] : drive.children(id));
	const trail = $derived.by(() => {
		void drive.rev;
		return id === null ? [] : (drive.core?.tree.breadcrumbs(id) ?? []);
	});
	let problem = $state('');

	$effect(() => {
		const folder = id;
		const ready = drive.status === 'ready';
		if (folder === null || !ready) return;
		problem = '';
		const core = drive.core;
		void (async () => {
			try {
				await core?.tree.resolve(folder);
				await core?.tree.loadFolder(folder);
			} catch (e) {
				problem = describeDriveError(e);
			}
		})();
		drive.folder = folder;
	});

	const title = $derived(id === drive.rootId || here === undefined ? 'My files' : here.name);
	const writable = $derived(here === undefined || canWrite(here));

	// A share that ended while it was on screen: the tree has let go of it.
	let shown = $state<string | null>(null);
	$effect(() => {
		const known = here?.id ?? null;
		untrack(() => {
			if (known !== null) shown = known;
			else if (shown !== null && shown === id && drive.status === 'ready') {
				shown = null;
				toasts.push('info', 'This is no longer shared with you.');
				void goto(resolve('/shared'));
			}
		});
	});
</script>

<svelte:head><title>{title} · YonDrive</title></svelte:head>

{#if problem}
	<Banner tone="danger" title="This folder could not be opened">{problem}</Banner>
{:else}
	<FileBrowser
		{nodes}
		label={title}
		emptyTitle="This folder is empty"
		loading={id === null || !drive.folderLoaded(id)}
	>
		{#snippet header()}
			<Breadcrumbs {trail} rootId={drive.rootId} count={nodes.length} />
		{/snippet}
		{#snippet empty()}
			{writable ? 'Drop files here, or upload some.' : 'Nothing has been put here yet.'}
		{/snippet}
	</FileBrowser>
	{#if id !== null && writable}
		<div class="more">
			<Button size="sm" icon="plus" onclick={() => shell.newFolder(id ?? undefined)}
				>New folder here</Button
			>
		</div>
	{/if}
{/if}

<style>
	.more {
		margin-top: 14px;
	}
</style>
