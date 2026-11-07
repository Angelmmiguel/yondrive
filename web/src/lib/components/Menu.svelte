<!--
  A dropdown menu. The trigger opens it with a click, Enter, Space or the Down
  arrow; inside, the arrows, Home, End and typing a letter move the focus, Enter
  and Space choose, and Escape or Tab close it. Focus goes back to the trigger.
-->
<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import Button from './Button.svelte';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	export interface MenuItem {
		id: string;
		label: string;
		/** A short lead-in, such as a file extension. */
		lead?: string;
		/** A trailing note, such as "Original". */
		note?: string;
		icon?: IconName;
		disabled?: boolean;
	}

	export interface TriggerAttrs {
		id: string;
		'aria-haspopup': 'menu';
		'aria-expanded': boolean;
		'aria-controls': string | undefined;
		onclick: () => void;
		onkeydown: (event: KeyboardEvent) => void;
	}

	interface Props {
		/** The menu's accessible name. */
		label: string;
		items: readonly MenuItem[];
		/** A small uppercase heading inside the menu. */
		heading?: string;
		/** The text of the default trigger button. */
		triggerLabel?: string;
		triggerIcon?: IconName;
		/** Replaces the default trigger; spread the attributes on a button. */
		trigger?: Snippet<[TriggerAttrs]>;
		align?: 'start' | 'end';
		width?: number;
		/**
		 * Draws in the top layer at the trigger, for a menu inside something that
		 * clips or transforms, such as a row of a scrolling list.
		 */
		floating?: boolean;
		onselect?: (id: string) => void;
	}

	let {
		label,
		items,
		heading,
		triggerLabel,
		triggerIcon,
		trigger,
		align = 'end',
		width = 260,
		floating = false,
		onselect
	}: Props = $props();

	const uid = $props.id();
	let open = $state(false);
	let root = $state<HTMLElement>();
	let list = $state<HTMLElement>();
	let typed = '';
	let typedAt = 0;
	let at = $state<{ left: number; top: number } | null>(null);

	/** Next to the trigger, kept on screen, above it if there is more room there. */
	function place() {
		if (!floating || !list || !root) return;
		list.showPopover?.();
		const trigger = root.getBoundingClientRect();
		const menu = list.getBoundingClientRect();
		const margin = 8;
		const left = align === 'end' ? trigger.right - menu.width : trigger.left;
		const below = trigger.bottom + margin;
		const fits = below + menu.height + margin <= window.innerHeight;
		at = {
			left: Math.max(margin, Math.min(left, window.innerWidth - menu.width - margin)),
			top: fits ? below : Math.max(margin, trigger.top - menu.height - margin)
		};
	}

	const buttons = () =>
		Array.from(list?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

	async function show(which: 'first' | 'last' | 'none' = 'first') {
		open = true;
		await tick();
		place();
		await tick();
		// Moving the focus must not scroll a list the menu only floats over.
		const all = buttons();
		if (which === 'first') all[0]?.focus({ preventScroll: true });
		else if (which === 'last') all[all.length - 1]?.focus({ preventScroll: true });
		else list?.focus({ preventScroll: true });
	}

	function hide(refocus = true) {
		if (!open) return;
		open = false;
		if (refocus) root?.querySelector<HTMLElement>(`#${CSS.escape(uid)}-trigger`)?.focus();
	}

	function choose(id: string) {
		hide();
		onselect?.(id);
	}

	const attrs: TriggerAttrs = $derived({
		id: `${uid}-trigger`,
		'aria-haspopup': 'menu',
		'aria-expanded': open,
		'aria-controls': open ? `${uid}-menu` : undefined,
		onclick: () => (open ? hide() : void show('none')),
		onkeydown: (event) => {
			if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				void show('first');
			} else if (event.key === 'ArrowUp') {
				event.preventDefault();
				void show('last');
			}
		}
	});

	function onmenukeydown(event: KeyboardEvent) {
		const all = buttons();
		const at = all.indexOf(document.activeElement as HTMLButtonElement);
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				all[(at + 1) % all.length]?.focus();
				break;
			case 'ArrowUp':
				event.preventDefault();
				all[(at - 1 + all.length) % all.length]?.focus();
				break;
			case 'Home':
				event.preventDefault();
				all[0]?.focus();
				break;
			case 'End':
				event.preventDefault();
				all[all.length - 1]?.focus();
				break;
			case 'Escape':
				event.preventDefault();
				event.stopPropagation();
				hide();
				break;
			case 'Tab':
				hide(false);
				break;
			default:
				if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
					const now = Date.now();
					typed = now - typedAt > 700 ? event.key : typed + event.key;
					typedAt = now;
					const hit = all.find((b) =>
						b.textContent?.trim().toLowerCase().startsWith(typed.toLowerCase())
					);
					hit?.focus();
				}
		}
	}

	function onfocusout(event: FocusEvent) {
		const next = event.relatedTarget as Node | null;
		if (open && next && !root?.contains(next)) hide(false);
	}

	$effect(() => {
		if (!open) return;
		const away = (event: PointerEvent) => {
			if (!root?.contains(event.target as Node)) hide(false);
		};
		// A floating menu follows its trigger: it is not part of what scrolls.
		document.addEventListener('pointerdown', away);
		if (floating) window.addEventListener('scroll', place, { capture: true, passive: true });
		return () => {
			document.removeEventListener('pointerdown', away);
			window.removeEventListener('scroll', place, { capture: true });
		};
	});
</script>

<div bind:this={root} class="menu" {onfocusout}>
	{#if trigger}
		{@render trigger(attrs)}
	{:else}
		<Button variant="secondary" size="sm" icon={triggerIcon} trailingIcon="chevron-down" {...attrs}>
			{triggerLabel ?? label}
		</Button>
	{/if}
	{#if open}
		<div
			bind:this={list}
			id="{uid}-menu"
			class="list {align}"
			class:floating
			role="menu"
			aria-label={label}
			tabindex="-1"
			popover={floating ? 'manual' : undefined}
			style:width="{width}px"
			style:left={floating && at ? `${at.left}px` : undefined}
			style:top={floating && at ? `${at.top}px` : undefined}
			onkeydown={onmenukeydown}
		>
			{#if heading}<span class="heading" role="presentation">{heading}</span>{/if}
			{#each items as item (item.id)}
				<button
					type="button"
					role="menuitem"
					class="item"
					tabindex="-1"
					disabled={item.disabled}
					onclick={() => choose(item.id)}
				>
					{#if item.icon}<Icon name={item.icon} size={16} />{/if}
					{#if item.lead}<span class="lead">{item.lead}</span>{/if}
					<span class="label">{item.label}</span>
					{#if item.note}<span class="note">{item.note}</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.menu {
		position: relative;
		display: inline-block;
	}

	.list {
		position: absolute;
		top: calc(100% + 8px);
		z-index: 20;
		max-width: calc(100vw - 32px);
		display: flex;
		flex-direction: column;
		padding: 6px;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 14px;
		box-shadow: 0 16px 40px -16px var(--shadow-ink);
	}

	.list:focus {
		outline: none;
	}

	.list.floating {
		position: fixed;
		inset: auto;
		margin: 0;
		color: inherit;
	}

	.list.end {
		right: 0;
	}

	.list.start {
		left: 0;
	}

	.heading {
		padding: 8px 10px 6px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.item {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 40px;
		padding: 0 10px;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: var(--text-strong);
		text-align: left;
		cursor: pointer;
	}

	.item:hover,
	.item:focus-visible {
		background: var(--surface-sunken);
		box-shadow: none;
	}

	.item:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.lead {
		width: 44px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--text-soft);
	}

	.label {
		flex: 1;
	}

	.note {
		font-size: 11px;
		color: var(--text-muted);
	}
</style>
