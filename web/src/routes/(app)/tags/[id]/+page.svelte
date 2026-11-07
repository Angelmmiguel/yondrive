<!-- Everything with one tag. The address holds its id, as the name must not reach the server. -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Button } from '$lib/components';
	import FileBrowser from '$lib/drive/ui/FileBrowser.svelte';
	import { drive } from '$lib/state/drive.svelte';

	const id = $derived(page.params.id as string);
	const tag = $derived(drive.tags.find((t) => t.id === id));
	const nodes = $derived(drive.tagged(id));

	async function remove(tagId: string) {
		await drive.deleteTag(tagId);
		await goto(resolve('/'));
	}

	$effect(() => {
		drive.folder = drive.rootId;
	});
</script>

<svelte:head><title>{tag?.name ?? 'Tag'} · YonDrive</title></svelte:head>

<FileBrowser
	{nodes}
	label={tag?.name ?? 'Tag'}
	emptyTitle="Nothing has this tag"
	emptyIcon="tag"
	loading={drive.status !== 'ready'}
>
	{#snippet header()}
		<div class="title">
			<h1>{tag?.name ?? 'Tag'}</h1>
			{#if tag}
				<Button size="sm" variant="ghost" onclick={() => remove(tag.id)}>Delete tag</Button>
			{/if}
		</div>
	{/snippet}
	{#snippet empty()}Add this tag to a file or folder from its menu.{/snippet}
</FileBrowser>

<style>
	.title {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	h1 {
		margin: 0;
		font-size: 24px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}
</style>
