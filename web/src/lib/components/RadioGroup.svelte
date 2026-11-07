<!--
  A radio group for RadioCard options. One option is in the tab order (the
  checked one, else the first); the arrow keys move the choice, as for native
  radios.
-->
<script lang="ts">
	import { setContext, type Snippet } from 'svelte';
	import { RADIO_GROUP, type RadioGroupContext } from './radio';

	interface Props {
		label: string;
		value?: string;
		onchange?: (value: string) => void;
		children: Snippet;
		columns?: string;
	}

	let {
		label,
		value = $bindable(''),
		onchange,
		children,
		columns = 'repeat(auto-fit, minmax(220px, 1fr))'
	}: Props = $props();

	let root = $state<HTMLElement>();

	const context: RadioGroupContext = {
		get value() {
			return value;
		},
		select(next) {
			if (next === value) return;
			value = next;
			onchange?.(next);
		}
	};
	setContext(RADIO_GROUP, context);

	function radios(): HTMLElement[] {
		return Array.from(root?.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)') ?? []);
	}

	// With nothing chosen, the first option takes the tab stop.
	$effect(() => {
		void value;
		const all = radios();
		if (all.length && !all.some((r) => r.getAttribute('aria-checked') === 'true')) {
			all[0].tabIndex = 0;
		}
	});

	function onkeydown(event: KeyboardEvent) {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (!step) return;
		const all = radios();
		const at = all.indexOf(event.target as HTMLElement);
		if (at < 0) return;
		event.preventDefault();
		const next = all[(at + step + all.length) % all.length];
		next.focus();
		next.click();
	}
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
	bind:this={root}
	class="group"
	role="radiogroup"
	aria-label={label}
	style:grid-template-columns={columns}
	{onkeydown}
>
	{@render children()}
</div>

<style>
	.group {
		display: grid;
		gap: 12px;
	}
</style>
