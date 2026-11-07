<!-- A small pill label. Tones map to the tag colours of the boards. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		tone?: 'neutral' | 'green' | 'blue' | 'orange' | 'rose' | 'grey' | 'ok' | 'warn' | 'danger';
		children: Snippet;
	}

	let { tone = 'neutral', children }: Props = $props();
</script>

<span class="tag {tone}">{@render children()}</span>

<style>
	.tag {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 99px;
		font-size: 11px;
		font-weight: 500;
		line-height: 1.5;
		white-space: nowrap;
		color: var(--text-soft);
		background: var(--surface-hover);
	}

	.green {
		color: var(--tag-green);
		background: var(--tag-green-soft);
	}

	.blue {
		color: var(--tag-blue);
		background: var(--tag-blue-soft);
	}

	.orange {
		color: var(--tag-orange);
		background: var(--tag-orange-soft);
	}

	.rose {
		color: var(--tag-rose);
		background: var(--tag-rose-soft);
	}

	.grey {
		color: var(--tag-grey);
		background: var(--tag-grey-soft);
	}

	.ok {
		color: var(--ok-ink);
		background: var(--ok-soft);
	}

	.warn {
		color: var(--warn-ink);
		background: var(--warn-soft);
	}

	.danger {
		color: var(--danger-ink);
		background: var(--danger-soft);
	}
</style>
