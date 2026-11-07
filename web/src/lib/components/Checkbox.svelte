<!-- A native checkbox with its label, at the board's 18px. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';

	interface Props extends Omit<HTMLInputAttributes, 'type' | 'checked' | 'children'> {
		checked?: boolean;
		children: Snippet;
	}

	let { checked = $bindable(false), children, ...rest }: Props = $props();
</script>

<label class="check">
	<input {...rest} type="checkbox" bind:checked />
	<span>{@render children()}</span>
</label>

<style>
	.check {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		font-size: 13px;
		color: var(--text-strong);
		cursor: pointer;
	}

	input {
		flex: none;
		width: 18px;
		height: 18px;
		margin: 1px 0 0;
		accent-color: var(--accent);
		cursor: pointer;
	}

	input:disabled,
	input:disabled + span {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
