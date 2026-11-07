<!-- Where a folder is, from My files down. The last one is the page's heading. -->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { Icon } from '$lib/components';
	import type { DriveNode } from '../tree';

	interface Props {
		trail: readonly DriveNode[];
		rootId: string | null;
		count?: number;
	}

	let { trail, rootId, count }: Props = $props();

	const parents = $derived(trail.slice(0, -1));
	/** A trail that does not start at this user's root is inside something shared with them. */
	const inShare = $derived(trail.length > 0 && trail[0].id !== rootId);
	const here = $derived(trail[trail.length - 1]);
	const name = (node: DriveNode) => (node.id === rootId ? 'My files' : node.name);
	const href = (node: DriveNode) => resolve(`/files/${node.id === rootId ? 'root' : node.id}`);
</script>

<nav aria-label="Breadcrumb" class="crumbs">
	{#if inShare}
		<a href={resolve('/shared')}>Shared with me</a>
		<Icon name="chevron-right" size={14} />
	{/if}
	{#each parents as parent (parent.id)}
		<a href={href(parent)}>{name(parent)}</a>
		<Icon name="chevron-right" size={14} />
	{/each}
	{#if here}
		<h2>{name(here)}</h2>
		{#if count !== undefined}<span class="count">· {count} {count === 1 ? 'item' : 'items'}</span
			>{/if}
	{/if}
</nav>

<style>
	.crumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		color: var(--text-muted);
		min-width: 0;
	}

	a {
		color: var(--text-soft);
		font-size: 14px;
		text-decoration: none;
	}

	a:hover {
		color: var(--accent-ink);
	}

	h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}

	.count {
		font-size: 13px;
	}
</style>
