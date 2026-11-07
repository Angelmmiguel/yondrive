<!-- What a list shows when there is nothing in it, with an optional next step. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	interface Props {
		title: string;
		icon?: IconName;
		children?: Snippet;
		action?: Snippet;
	}

	let { title, icon = 'folder', children, action }: Props = $props();
</script>

<div class="empty">
	<span class="art"><Icon name={icon} size={28} strokeWidth={1.5} /></span>
	<h3>{title}</h3>
	{#if children}<p>{@render children()}</p>{/if}
	{#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 48px 24px;
		text-align: center;
	}

	.art {
		width: 56px;
		height: 56px;
		display: grid;
		place-items: center;
		margin-bottom: 8px;
		border-radius: 16px;
		background: var(--surface-hover);
		color: var(--icon);
	}

	h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--text-strong);
	}

	p {
		margin: 0;
		max-width: 360px;
		color: var(--text-muted);
	}

	.action {
		margin-top: 12px;
	}
</style>
