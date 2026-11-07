<!-- A bordered surface. `sunken` is the quiet inset panel, `dashed` the aside note. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		variant?: 'surface' | 'sunken' | 'dashed';
		padding?: 'none' | 'sm' | 'md' | 'lg';
		radius?: 'md' | 'lg' | 'xl';
		as?: 'div' | 'section' | 'article' | 'aside';
		label?: string;
		children: Snippet;
	}

	let {
		variant = 'surface',
		padding = 'md',
		radius = 'lg',
		as = 'div',
		label,
		children
	}: Props = $props();
</script>

<svelte:element this={as} class="card {variant} p-{padding} r-{radius}" aria-label={label}>
	{@render children()}
</svelte:element>

<style>
	.card {
		min-width: 0;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.sunken {
		border-color: transparent;
		background: var(--surface-sunken);
	}

	.dashed {
		border: 1px dashed var(--border-strong);
		background: transparent;
	}

	.p-none {
		padding: 0;
	}

	.p-sm {
		padding: 12px;
	}

	.p-md {
		padding: 14px;
	}

	.p-lg {
		padding: 28px 32px;
	}

	.r-md {
		border-radius: 12px;
	}

	.r-lg {
		border-radius: 14px;
	}

	.r-xl {
		border-radius: 20px;
	}
</style>
