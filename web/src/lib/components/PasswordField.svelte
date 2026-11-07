<!--
  A password input with a show/hide toggle and a slot for a strength meter,
  which is wired as the input's description. The meter is whatever the screen
  passes, usually a StrengthMeter.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import Icon from './Icon.svelte';
	import TextInput from './TextInput.svelte';

	interface Props extends Omit<HTMLInputAttributes, 'value' | 'type'> {
		value?: string;
		meter?: Snippet;
	}

	let { value = $bindable(''), meter, 'aria-describedby': describedBy, ...rest }: Props = $props();

	const uid = $props.id();
	let shown = $state(false);
	const describedByAll = $derived(
		[describedBy, meter ? `${uid}-meter` : undefined].filter(Boolean).join(' ') || undefined
	);
</script>

<div class="wrap">
	<div class="box">
		<TextInput
			{...rest}
			bind:value
			type={shown ? 'text' : 'password'}
			aria-describedby={describedByAll}
			class="pw"
		/>
		<button
			type="button"
			class="toggle"
			aria-label={shown ? 'Hide password' : 'Show password'}
			aria-pressed={shown}
			onclick={() => (shown = !shown)}
		>
			<Icon name={shown ? 'eye-off' : 'eye'} size={18} />
		</button>
	</div>
	{#if meter}
		<div id="{uid}-meter">{@render meter()}</div>
	{/if}
</div>

<style>
	.wrap {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.box {
		position: relative;
		display: flex;
	}

	.box :global(.pw) {
		padding-right: 44px;
	}

	.toggle {
		position: absolute;
		top: 0;
		right: 0;
		width: 42px;
		height: 42px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
	}

	.toggle:hover {
		color: var(--text-strong);
	}
</style>
