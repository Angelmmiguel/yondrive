<!-- What changed last, wherever it is. -->
<script lang="ts">
	import FileBrowser from '$lib/drive/ui/FileBrowser.svelte';
	import { drive } from '$lib/state/drive.svelte';

	const nodes = $derived(drive.recent(100));

	$effect(() => {
		drive.folder = drive.rootId;
	});
</script>

<svelte:head><title>Recent · YonDrive</title></svelte:head>

<FileBrowser
	{nodes}
	label="Recent"
	emptyTitle="Nothing recent"
	emptyIcon="recent"
	loading={drive.status !== 'ready'}
>
	{#snippet header()}<h1>Recent</h1>{/snippet}
	{#snippet empty()}Files you upload or change appear here.{/snippet}
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
