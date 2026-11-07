<!-- The header of the content column: a leading slot (usually the search) and actions at the end. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		leading?: Snippet;
		children?: Snippet;
	}

	let { leading, children }: Props = $props();
</script>

<header class="bar">
	{#if leading}<div class="lead">{@render leading()}</div>{/if}
	{#if children}<div class="actions">{@render children()}</div>{/if}
</header>

<style>
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		padding: 14px 32px;
		border-bottom: 1px solid var(--divider);
		background: var(--surface-page);
	}

	.lead {
		flex: 1 1 320px;
		max-width: 600px;
	}

	.actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	@media (max-width: 640px) {
		.bar {
			padding: 12px 16px;
		}
	}
</style>
