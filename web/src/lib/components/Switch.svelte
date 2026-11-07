<!--
  An on/off switch: a button with role=switch, so Space and Enter toggle it
  and a screen reader hears the state. The name comes from `label`; the row
  that shows a visible label and hint around it is the screen's.
-->
<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';

	interface Props extends Omit<HTMLButtonAttributes, 'children' | 'onchange'> {
		checked?: boolean;
		label: string;
		onchange?: (checked: boolean) => void;
	}

	let { checked = $bindable(false), label, onchange, disabled, ...rest }: Props = $props();

	function toggle() {
		if (disabled) return;
		checked = !checked;
		onchange?.(checked);
	}
</script>

<button
	{...rest}
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={label}
	{disabled}
	class="switch"
	onclick={toggle}
>
	<span class="knob"></span>
</button>

<style>
	.switch {
		width: 44px;
		height: 26px;
		flex: none;
		padding: 3px;
		border: 0;
		border-radius: 99px;
		background: var(--switch-off);
		cursor: pointer;
		transition: background 0.15s;
	}

	.switch[aria-checked='true'] {
		background: var(--accent);
	}

	.knob {
		display: block;
		width: 20px;
		height: 20px;
		border-radius: 99px;
		background: var(--knob);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
		transition: transform 0.15s;
	}

	.switch[aria-checked='true'] .knob {
		transform: translateX(18px);
	}

	.switch:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	@media (prefers-reduced-motion: reduce) {
		.switch,
		.knob {
			transition: none;
		}
	}
</style>
