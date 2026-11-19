<!--
  A short text about a control, shown while the pointer is over it or it has the
  focus, and on a tap; Escape hides it. The control describes itself with it, so
  a screen reader says it too. Spread the attributes on the trigger.
-->
<script lang="ts">
	import { tick, type Snippet } from 'svelte';

	export interface TooltipAttrs {
		'aria-describedby': string;
		onpointerenter: () => void;
		onpointerleave: () => void;
		onfocus: () => void;
		onblur: () => void;
		onclick: () => void;
		onkeydown: (event: KeyboardEvent) => void;
	}

	interface Props {
		text: string;
		trigger: Snippet<[TooltipAttrs]>;
	}

	let { text, trigger }: Props = $props();

	const uid = $props.id();
	let open = $state(false);
	let root = $state<HTMLElement>();
	let tip = $state<HTMLElement>();
	let at = $state<{ left: number; top: number } | null>(null);

	/** Below the trigger, in the top layer, kept on screen. */
	async function show() {
		open = true;
		await tick();
		const t = root?.firstElementChild?.getBoundingClientRect();
		if (!tip || !t) return;
		tip.showPopover?.();
		const box = tip.getBoundingClientRect();
		const margin = 8;
		at = {
			left: Math.max(margin, Math.min(t.left, window.innerWidth - box.width - margin)),
			top: t.bottom + 6
		};
	}

	function hide() {
		open = false;
		if (tip?.matches?.(':popover-open')) tip.hidePopover();
	}

	const attrs: TooltipAttrs = {
		'aria-describedby': `${uid}-tip`,
		onpointerenter: () => void show(),
		onpointerleave: hide,
		onfocus: () => void show(),
		onblur: hide,
		onclick: () => (open ? hide() : void show()),
		onkeydown: (event) => {
			if (event.key === 'Escape' && open) {
				event.stopPropagation();
				hide();
			}
		}
	};
</script>

<span class="at" bind:this={root}>
	{@render trigger(attrs)}
	<span
		bind:this={tip}
		id="{uid}-tip"
		role="tooltip"
		class="tip"
		class:open
		popover="manual"
		style:left={at ? `${at.left}px` : undefined}
		style:top={at ? `${at.top}px` : undefined}>{text}</span
	>
</span>

<style>
	.at {
		display: inline-flex;
	}

	.tip {
		position: fixed;
		inset: auto;
		max-width: min(340px, calc(100vw - 16px));
		margin: 0;
		padding: 8px 10px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text-strong);
		box-shadow: var(--shadow-lg);
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 400;
		line-height: 1.45;
		letter-spacing: normal;
		text-transform: none;
		white-space: normal;
		pointer-events: none;
	}

	.tip:not(.open) {
		display: none;
	}
</style>
