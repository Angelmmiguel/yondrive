<!-- The left column of an app: a title, the primary action, navigation and a footer. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		/** A small outlined label next to the title, such as the server name. */
		badge?: string;
		label?: string;
		children: Snippet;
		footer?: Snippet;
	}

	let { title, badge, label = 'Sidebar', children, footer }: Props = $props();
</script>

<aside class="side" aria-label={label}>
	<div class="head">
		<span class="title">{title}</span>
		{#if badge}<span class="badge">{badge}</span>{/if}
	</div>
	{@render children()}
	{#if footer}
		<div class="spacer"></div>
		{@render footer()}
	{/if}
</aside>

<style>
	.side {
		width: 240px;
		flex: none;
		max-width: 100%;
		display: flex;
		flex-direction: column;
		gap: 22px;
		padding: 20px 14px 18px;
		background: var(--surface-side);
		border-right: 1px solid var(--border);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 32px;
		padding: 2px 8px;
	}

	.title {
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}

	.badge {
		margin-left: auto;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-muted);
		padding: 2px 6px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
	}

	.spacer {
		flex-grow: 1;
	}
</style>
