<!-- The details column beside an editor or a file list. Compose Tabs inside it. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		label: string;
		side?: 'start' | 'end';
		width?: number;
		children: Snippet;
	}

	let { label, side = 'end', width = 300, children }: Props = $props();
</script>

<aside class="panel {side}" aria-label={label} style:width="min({width}px, 100%)">
	{@render children()}
</aside>

<style>
	.panel {
		flex: none;
		max-width: 100%;
		display: flex;
		flex-direction: column;
		background: var(--surface-page);
	}

	.end {
		border-left: 1px solid var(--border);
	}

	.start {
		border-right: 1px solid var(--border);
	}
</style>
