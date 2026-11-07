<!-- A titled group in the sidebar, with an optional action at the end of the heading. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		action?: Snippet;
		children: Snippet;
	}

	let { title, action, children }: Props = $props();
	const uid = $props.id();
</script>

<section class="section" aria-labelledby="{uid}-h">
	<div class="head">
		<h2 id="{uid}-h">{title}</h2>
		{#if action}<span class="action">{@render action()}</span>{/if}
	</div>
	{@render children()}
</section>

<style>
	.section {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.head {
		display: flex;
		align-items: center;
		padding: 0 10px 6px;
	}

	h2 {
		margin: 0;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.action {
		margin-left: auto;
	}
</style>
