<!-- What has a star. -->
<script lang="ts">
	import FileBrowser from '$lib/drive/ui/FileBrowser.svelte';
	import { drive } from '$lib/state/drive.svelte';

	const nodes = $derived(drive.favorites);

	$effect(() => {
		drive.folder = drive.rootId;
	});
</script>

<svelte:head><title>Favorites · YonDrive</title></svelte:head>

<FileBrowser
	{nodes}
	label="Favorites"
	emptyTitle="No favorites yet"
	emptyIcon="star"
	loading={drive.status !== 'ready'}
>
	{#snippet header()}<h1>Favorites</h1>{/snippet}
	{#snippet empty()}Star a file or folder to keep it close.{/snippet}
</FileBrowser>

<style>
	h1 {
		margin: 0;
		font-size: 24px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}
</style>
