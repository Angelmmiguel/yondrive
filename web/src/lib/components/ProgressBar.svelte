<!--
  A progress bar. With `value` it is a progressbar; without, it is indeterminate.
  With `segments` it is a stacked bar (storage by kind) described by `label`.
-->
<script lang="ts">
	export interface Segment {
		value: number;
		/** A colour token, e.g. 'var(--file-image)'. */
		color: string;
	}

	interface Props {
		label: string;
		value?: number;
		max?: number;
		segments?: readonly Segment[];
		height?: 4 | 6 | 8;
		tone?: 'accent' | 'ok' | 'warn' | 'danger';
	}

	let { label, value, max = 100, segments, height = 6, tone = 'accent' }: Props = $props();

	const pct = $derived(value === undefined ? 0 : Math.max(0, Math.min(100, (value / max) * 100)));
</script>

{#if segments}
	<div class="bar stacked" role="img" aria-label={label} style:height="{height}px">
		{#each segments as s, i (i)}
			<span class="fill" style:width="{(s.value / max) * 100}%" style:background={s.color}></span>
		{/each}
	</div>
{:else}
	<div
		class="bar"
		role="progressbar"
		aria-label={label}
		aria-valuemin="0"
		aria-valuemax={max}
		aria-valuenow={value}
		style:height="{height}px"
	>
		<span
			class="fill {tone}"
			class:indeterminate={value === undefined}
			style:width={value === undefined ? undefined : `${pct}%`}
		></span>
	</div>
{/if}

<style>
	.bar {
		display: flex;
		border-radius: 99px;
		overflow: hidden;
		background: var(--track);
	}

	.stacked {
		gap: 2px;
		background: var(--surface-hover);
	}

	.fill {
		display: block;
		height: 100%;
		border-radius: 99px;
		transition: width 0.3s ease;
	}

	.accent {
		background: var(--accent);
	}

	.ok {
		background: var(--ok);
	}

	.warn {
		background: var(--warn);
	}

	.danger {
		background: var(--danger);
	}

	.indeterminate {
		width: 35%;
		animation: slide 1.2s ease-in-out infinite alternate;
	}

	@keyframes slide {
		from {
			margin-left: 0;
		}
		to {
			margin-left: 65%;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.fill {
			transition: none;
		}

		.indeterminate {
			animation: none;
			width: 100%;
			opacity: 0.5;
		}
	}
</style>
