<!--
  The search input of the top bar: a magnifier, a visible keyboard hint and an
  invisible label. Enter submits, Escape clears.
-->
<script lang="ts">
	import Icon from './Icon.svelte';

	interface Props {
		value?: string;
		label?: string;
		placeholder?: string;
		/** The shortcut that focuses it elsewhere, shown at the end. */
		shortcut?: string;
		onsubmit?: (value: string) => void;
	}

	let {
		value = $bindable(''),
		label = 'Search',
		placeholder = 'Search…',
		shortcut,
		onsubmit
	}: Props = $props();

	const uid = $props.id();
</script>

<div class="search" role="search">
	<label for="{uid}-q" class="sr">{label}</label>
	<span class="glass"><Icon name="search" size={18} /></span>
	<input
		id="{uid}-q"
		type="search"
		bind:value
		{placeholder}
		onkeydown={(e) => {
			if (e.key === 'Enter') onsubmit?.(value);
			else if (e.key === 'Escape' && value) {
				e.preventDefault();
				value = '';
			}
		}}
	/>
	{#if shortcut}<kbd>{shortcut}</kbd>{/if}
</div>

<style>
	.search {
		position: relative;
		display: flex;
		align-items: center;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.glass {
		position: absolute;
		left: 14px;
		display: inline-flex;
		color: var(--text-muted);
		pointer-events: none;
	}

	input {
		width: 100%;
		height: 44px;
		padding: 0 64px 0 42px;
		border: 1px solid var(--border-strong);
		border-radius: 12px;
		background: var(--surface);
		color: var(--text-strong);
		transition:
			border-color 0.12s,
			box-shadow 0.12s;
	}

	input:focus-visible {
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}

	input::placeholder {
		color: var(--text-muted);
	}

	kbd {
		position: absolute;
		right: 12px;
		padding: 2px 6px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--surface-sunken);
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 11px;
		pointer-events: none;
	}
</style>
