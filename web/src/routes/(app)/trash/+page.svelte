<!--
  The trash. Deleting forever only marks something: the server keeps the bytes for its
  grace period, so that a stolen session cannot destroy anything, and it can be
  restored until then.
-->
<script lang="ts">
	import { Button } from '$lib/components';
	import FileBrowser from '$lib/drive/ui/FileBrowser.svelte';
	import { drive } from '$lib/state/drive.svelte';

	$effect(() => {
		if (drive.status === 'ready') void drive.loadTrash();
		drive.folder = drive.rootId;
	});
</script>

<svelte:head><title>Trash · YonDrive</title></svelte:head>

<FileBrowser
	nodes={drive.trash}
	label="Trash"
	trash
	emptyTitle="The trash is empty"
	emptyIcon="trash"
	loading={!drive.trashLoaded}
>
	{#snippet header()}
		<div class="title">
			<h1>Trash</h1>
			{#if drive.trash.some((node) => node.removeAt === null)}
				<Button size="sm" onclick={() => (drive.dialog = { kind: 'empty-trash' })}
					>Empty trash</Button
				>
			{/if}
		</div>
	{/snippet}
	{#snippet empty()}What you delete stays here until you remove it for good.{/snippet}
</FileBrowser>

<p class="note">
	Deleting forever starts a grace period set by your administrator. Until it ends, everything still
	counts against your storage and can be restored.
</p>

<style>
	.title {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	h1 {
		margin: 0;
		font-size: 24px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}

	.note {
		margin: 16px 0 0;
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
