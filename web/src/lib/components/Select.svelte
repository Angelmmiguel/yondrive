<!-- A native select drawn like a text input, so the platform picker and keyboard stay. -->
<script lang="ts">
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import Icon from './Icon.svelte';

	export interface SelectOption {
		value: string;
		label: string;
		disabled?: boolean;
	}

	interface Props extends Omit<HTMLSelectAttributes, 'value' | 'children'> {
		options: readonly SelectOption[];
		value?: string;
	}

	let { options, value = $bindable(''), class: klass, ...rest }: Props = $props();
</script>

<span class="wrap">
	<select {...rest} bind:value class={['select', klass]}>
		{#each options as o (o.value)}
			<option value={o.value} disabled={o.disabled}>{o.label}</option>
		{/each}
	</select>
	<span class="chev"><Icon name="chevron-down" size={16} /></span>
</span>

<style>
	.wrap {
		position: relative;
		display: flex;
	}

	.select {
		width: 100%;
		height: 42px;
		padding: 0 38px 0 12px;
		border: 1px solid var(--border-strong);
		border-radius: 10px;
		background: var(--surface);
		color: var(--text-strong);
		appearance: none;
		cursor: pointer;
		transition:
			border-color 0.12s,
			box-shadow 0.12s;
	}

	.select:focus-visible {
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}

	.select:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.select[aria-invalid='true'] {
		border-color: var(--danger);
	}

	.chev {
		position: absolute;
		right: 12px;
		top: 0;
		bottom: 0;
		display: grid;
		place-items: center;
		color: var(--icon);
		pointer-events: none;
	}
</style>
