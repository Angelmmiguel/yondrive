<!-- The corner where toasts pile up. Always in the page, so announcements reach screen readers. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** Draws in the page instead of fixed to the corner (the styleguide). */
		inline?: boolean;
		children?: Snippet;
	}

	let { inline = false, children }: Props = $props();
</script>

<div class="stack" class:inline aria-live="polite" aria-relevant="additions">
	{@render children?.()}
</div>

<style>
	.stack {
		position: fixed;
		right: 20px;
		bottom: 20px;
		z-index: 60;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 8px;
		pointer-events: none;
	}

	.stack :global(> *) {
		pointer-events: auto;
	}

	.inline {
		position: static;
		align-items: flex-start;
	}
</style>
