<!-- A single-line text input at the board's size. Readonly drops to the sunken tone. -->
<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	interface Props extends Omit<HTMLInputAttributes, 'value'> {
		value?: string;
		/** Monospace at 13px, for URLs and paths. */
		mono?: boolean;
		element?: HTMLInputElement;
	}

	let {
		value = $bindable(''),
		type = 'text',
		mono = false,
		element = $bindable(),
		class: klass,
		...rest
	}: Props = $props();
</script>

<input {...rest} {type} bind:value bind:this={element} class={['input', { mono }, klass]} />

<style>
	.input {
		width: 100%;
		height: 42px;
		padding: 0 12px;
		border: 1px solid var(--border-field);
		border-radius: 10px;
		background: var(--surface);
		color: var(--text-strong);
		transition:
			border-color 0.12s,
			box-shadow 0.12s;
	}

	.input.mono {
		font-family: var(--font-mono);
		font-size: 13px;
	}

	.input::placeholder {
		color: var(--text-muted);
	}

	.input:focus-visible {
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}

	.input[readonly] {
		background: var(--surface-sunken);
		color: var(--text-soft);
	}

	.input:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.input[aria-invalid='true'] {
		border-color: var(--danger);
	}
</style>
