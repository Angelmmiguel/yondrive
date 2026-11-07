<!--
  A menu at a point, for a right click on the grid or its sheet tabs. The arrows,
  Home and End move, Enter chooses, and Escape, Tab or a click elsewhere close it,
  giving the focus back to where it was.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { Icon, type MenuItem } from '$lib/components';

	interface Props {
		label: string;
		items: readonly MenuItem[];
		at: { x: number; y: number };
		onselect: (id: string) => void;
		onclose: () => void;
	}

	let { label, items, at, onselect, onclose }: Props = $props();

	let list = $state<HTMLElement>();
	let pos = $state({ left: 0, top: 0 });
	const back = document.activeElement as HTMLElement | null;

	const buttons = () =>
		Array.from(list?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

	$effect(() => {
		void tick().then(() => {
			if (!list) return;
			const r = list.getBoundingClientRect();
			pos = {
				left: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)),
				top: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8))
			};
			buttons()[0]?.focus({ preventScroll: true });
		});
	});

	$effect(() => {
		const away = (e: PointerEvent) => {
			if (!list?.contains(e.target as Node)) close();
		};
		document.addEventListener('pointerdown', away, true);
		return () => document.removeEventListener('pointerdown', away, true);
	});

	function close() {
		onclose();
		back?.focus({ preventScroll: true });
	}

	/** Does what was chosen, then closes; the focus goes back unless the choice moved it, as to a dialog. */
	function choose(id: string) {
		onselect(id);
		const at = document.activeElement;
		onclose();
		if (!at || at === document.body || list?.contains(at)) back?.focus({ preventScroll: true });
	}

	function onkeydown(e: KeyboardEvent) {
		const all = buttons();
		const i = all.indexOf(document.activeElement as HTMLButtonElement);
		const go = (n: number) => {
			e.preventDefault();
			all[(n + all.length) % all.length]?.focus();
		};
		if (e.key === 'ArrowDown') go(i + 1);
		else if (e.key === 'ArrowUp') go(i - 1);
		else if (e.key === 'Home') go(0);
		else if (e.key === 'End') go(all.length - 1);
		else if (e.key === 'Escape' || e.key === 'Tab') {
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	}
</script>

<div
	bind:this={list}
	class="ctx"
	role="menu"
	aria-label={label}
	tabindex="-1"
	style:left="{pos.left}px"
	style:top="{pos.top}px"
	{onkeydown}
>
	{#each items as item (item.id)}
		<button
			type="button"
			role="menuitem"
			class="item"
			disabled={item.disabled}
			onclick={() => choose(item.id)}
		>
			{#if item.icon}<Icon name={item.icon} size={16} />{/if}
			<span class="label">{item.label}</span>
			{#if item.note}<span class="note">{item.note}</span>{/if}
		</button>
	{/each}
</div>

<style>
	.ctx {
		position: fixed;
		z-index: 60;
		min-width: 220px;
		padding: 6px;
		display: flex;
		flex-direction: column;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 14px;
		box-shadow: var(--shadow-lg);
		outline: none;
	}

	.item {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 36px;
		padding: 0 10px;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: var(--text-strong);
		font: inherit;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}

	.item:hover:not(:disabled),
	.item:focus-visible {
		background: var(--surface-hover);
		outline: none;
	}

	.item:disabled {
		color: var(--text-muted);
		cursor: default;
	}

	.label {
		flex: 1;
	}

	.note {
		font-size: 11px;
		color: var(--text-muted);
	}
</style>
