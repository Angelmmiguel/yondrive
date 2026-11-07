<!--
  A small group of mutually exclusive toggle buttons (list or grid view).
  Each option is a real button with aria-pressed; icon-only options need a label.
-->
<script lang="ts">
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	export interface Segment {
		value: string;
		/** Visible text; for icon-only options it is the accessible name. */
		label: string;
		icon?: IconName;
		iconOnly?: boolean;
	}

	interface Props {
		label: string;
		options: readonly Segment[];
		value?: string;
		onchange?: (value: string) => void;
	}

	let { label, options, value = $bindable(), onchange }: Props = $props();

	function pick(next: string) {
		if (next === value) return;
		value = next;
		onchange?.(next);
	}
</script>

<div class="group" role="group" aria-label={label}>
	{#each options as o (o.value)}
		<button
			type="button"
			class="seg"
			class:icon-only={o.iconOnly}
			aria-pressed={value === o.value}
			aria-label={o.iconOnly ? o.label : undefined}
			title={o.iconOnly ? o.label : undefined}
			onclick={() => pick(o.value)}
		>
			{#if o.icon}<Icon name={o.icon} size={16} strokeWidth={1.9} />{/if}
			{#if !o.iconOnly}{o.label}{/if}
		</button>
	{/each}
</div>

<style>
	.group {
		display: inline-flex;
		gap: 2px;
		padding: 3px;
		border-radius: 11px;
		background: var(--surface-hover);
	}

	.seg {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 30px;
		padding: 0 12px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-soft);
		font-weight: 500;
		cursor: pointer;
	}

	.seg.icon-only {
		width: 36px;
		padding: 0;
	}

	.seg[aria-pressed='true'] {
		background: var(--surface);
		color: var(--text-strong);
		box-shadow: var(--shadow-sm);
	}

	/* The pressed one's shadow must not hide where the focus is. */
	.seg:focus-visible {
		box-shadow: var(--focus-ring);
	}
</style>
