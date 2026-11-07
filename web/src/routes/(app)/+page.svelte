<!-- Home, as on the board: a greeting, what to make, what to go back to, and My files. -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { readDisplayName } from '$lib/account/display-name';
	import { greeting } from '$lib/app/format';
	import { Banner } from '$lib/components';
	import CreatorTiles from '$lib/drive/ui/CreatorTiles.svelte';
	import FileBrowser from '$lib/drive/ui/FileBrowser.svelte';
	import RecentTiles from '$lib/drive/ui/RecentTiles.svelte';
	import { drive } from '$lib/state/drive.svelte';
	import { session } from '$lib/state/session.svelte';
	import { getContext } from 'svelte';
	import type { ShellActions } from './shell';

	const shell = getContext<ShellActions>('shell');
	const name = $derived(readDisplayName(localStorage) || session.account?.user.username || '');
	const hello = greeting(new Date().getHours());
	const root = $derived(drive.rootId);
	const nodes = $derived(root === null ? [] : drive.children(root));
	const recent = $derived(drive.recent(3));

	$effect(() => {
		drive.folder = root;
	});

	let making = false;
	/** A new, empty document in My files, opened in the editor. */
	async function newDoc() {
		const core = drive.core;
		if (core === null || root === null || making) return;
		making = true;
		try {
			const { createDocument } = await import('$lib/docs/create');
			const made = await drive.run(() =>
				createDocument({ tree: core.tree, engine: core.engine }, root)
			);
			if (made) await goto(resolve(`/doc/${made.id}`));
		} finally {
			making = false;
		}
	}

	/** A new, empty spreadsheet in My files, opened in the editor. */
	async function newSheet() {
		const core = drive.core;
		if (core === null || root === null || making) return;
		making = true;
		try {
			const { createSpreadsheet } = await import('$lib/sheets/ui/create');
			const made = await drive.run(() =>
				createSpreadsheet({ tree: core.tree, engine: core.engine }, root)
			);
			if (made) await goto(resolve(`/sheet/${made.id}`));
		} finally {
			making = false;
		}
	}
</script>

<svelte:head><title>Home · YonDrive</title></svelte:head>

<div class="home">
	<h1>{hello}{name ? `, ${name}` : ''}</h1>

	<CreatorTiles
		onnewfolder={() => shell.newFolder()}
		onupload={() => shell.uploadFiles()}
		onnewdoc={newDoc}
		onnewsheet={newSheet}
	/>

	{#if drive.status === 'failed'}
		<Banner tone="danger" title="Your files could not be opened">{drive.error}</Banner>
	{/if}

	{#if recent.length > 0}
		<section aria-labelledby="recent-h" class="recent">
			<div class="line">
				<h2 id="recent-h">Jump back in</h2>
				<a href={resolve('/recent')}>View all recent</a>
			</div>
			<RecentTiles nodes={recent} />
		</section>
	{/if}

	<FileBrowser
		{nodes}
		label="My files"
		emptyTitle="Nothing here yet"
		loading={drive.status !== 'ready'}
	>
		{#snippet header()}
			<div class="files-title">
				<h2>My files</h2>
				<span>· {nodes.length} {nodes.length === 1 ? 'item' : 'items'}</span>
			</div>
		{/snippet}
		{#snippet empty()}
			Drop files here, or use Upload, to get started.
		{/snippet}
	</FileBrowser>
</div>

<style>
	.home {
		display: flex;
		flex-direction: column;
		gap: 36px;
		min-width: 0;
	}

	h1 {
		margin: 0;
		font-size: 30px;
		font-weight: 600;
		letter-spacing: -0.025em;
		color: var(--text-strong);
	}

	h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text-strong);
	}

	.recent {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.line {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}

	.line a {
		font-size: 13px;
		font-weight: 500;
		text-decoration: none;
	}

	.files-title {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.files-title span {
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
