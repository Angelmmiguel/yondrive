<!-- "Jump back in": the files last changed, as large tiles. -->
<script lang="ts">
	import { formatWhen } from '$lib/app/format';
	import { FILE_KINDS, Icon } from '$lib/components';
	import { drive } from '$lib/state/drive.svelte';
	import { fileKindOf } from '../kinds';
	import type { DriveNode } from '../tree';
	import { viewerFor } from '../viewers/kinds';

	interface Props {
		nodes: readonly DriveNode[];
	}

	let { nodes }: Props = $props();

	let urls = $state<Record<string, string | null>>({});

	$effect(() => {
		for (const node of nodes) {
			const blobId = node.thumbBlobId;
			if (blobId !== null && !(blobId in urls)) {
				void drive.core?.thumbs.urlFor(node).then((url) => {
					urls = { ...urls, [blobId]: url };
				});
			}
		}
	});

	function open(node: DriveNode) {
		if (viewerFor(node) !== null) drive.open(node);
		else void drive.download(node);
	}
</script>

<div class="tiles">
	{#each nodes as node (node.id)}
		{@const style = FILE_KINDS[fileKindOf(node)]}
		{@const thumb = node.thumbBlobId === null ? null : urls[node.thumbBlobId]}
		<button type="button" class="tile" onclick={() => open(node)}>
			<span class="preview" style:background={style.soft} style:color={style.ink}>
				{#if thumb}
					<img src={thumb} alt="" />
				{:else}
					<Icon name={style.icon} size={40} strokeWidth={1.4} />
				{/if}
			</span>
			<span class="info">
				<span class="line">
					<span style:color={style.ink}><Icon name={style.icon} size={16} strokeWidth={1.9} /></span
					>
					<span class="name">{node.name}</span>
				</span>
				<span class="when">Changed {formatWhen(node.updatedAt).toLowerCase()}</span>
			</span>
		</button>
	{/each}
</div>

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 14px;
	}

	.tile {
		display: flex;
		flex-direction: column;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 16px;
		background: var(--surface);
		color: var(--text-strong);
		text-align: left;
		overflow: hidden;
		cursor: pointer;
		transition:
			transform 0.18s ease,
			box-shadow 0.18s ease,
			border-color 0.18s;
	}

	.tile:hover {
		transform: translateY(-2px);
		border-color: var(--border-strong);
		box-shadow: var(--shadow-lg);
	}

	.preview {
		height: 128px;
		display: grid;
		place-items: center;
	}

	.preview img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.info {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 14px 14px;
		border-top: 1px solid var(--divider);
	}

	.line {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.name {
		min-width: 0;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.when {
		font-size: 12px;
		color: var(--text-muted);
	}

	@media (prefers-reduced-motion: reduce) {
		.tile {
			transition: none;
		}

		.tile:hover {
			transform: none;
		}
	}
</style>
