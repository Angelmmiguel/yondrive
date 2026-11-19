<!--
  The sheet tabs of the Sheets board, with a button to add one. A right click (or
  the context menu key) on a tab offers renaming, moving, hiding and deleting it,
  and showing a hidden sheet again; a double click renames it in place. The
  arrows move between tabs.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { Icon, type MenuItem } from '$lib/components';
	import type { SheetMeta } from '../service';
	import ContextMenu from './ContextMenu.svelte';

	export type TabAction = 'rename' | 'left' | 'right' | 'hide' | 'delete' | `show:${number}`;

	interface Props {
		sheets: SheetMeta[];
		current: number;
		editable: boolean;
		/** Whether this file may hold more than one sheet. */
		canAdd: boolean;
		onpick: (id: number) => void;
		onadd: () => void;
		onaction: (id: number, action: TabAction) => void;
		/** Renames a sheet: null when it was, else why not ('' when that was said already). */
		onrename: (id: number, name: string) => Promise<string | null>;
	}

	let { sheets, current, editable, canAdd, onpick, onadd, onaction, onrename }: Props = $props();

	const uid = $props.id();
	/** The tab being renamed in place. */
	let naming = $state<{ id: number; name: string; error: string } | null>(null);
	let busy = false;

	async function startNaming(id: number) {
		const s = sheets.find((x) => x.id === id);
		if (!editable || !s) return;
		naming = { id, name: s.name, error: '' };
		await tick();
		const field = list?.querySelector<HTMLInputElement>('input.naming');
		field?.focus();
		field?.select();
	}

	async function stopNaming(refocus: boolean) {
		const id = naming?.id;
		naming = null;
		if (!refocus || id === undefined) return;
		await tick();
		list?.querySelector<HTMLElement>(`[data-sheet="${id}"]`)?.focus();
	}

	async function saveNaming(refocus: boolean) {
		const n = naming;
		if (!n || busy) return;
		if (n.name === sheets.find((s) => s.id === n.id)?.name) return stopNaming(refocus);
		busy = true;
		try {
			const error = await onrename(n.id, n.name);
			if (error === null) await stopNaming(refocus);
			else if (naming) naming = { ...naming, error: error || 'That name cannot be used.' };
		} finally {
			busy = false;
		}
	}

	function onnamingkey(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === 'Enter') {
			e.preventDefault();
			void saveNaming(true);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			void stopNaming(true);
		}
	}

	const shown = $derived(sheets.filter((s) => !s.hidden));
	const hidden = $derived(sheets.filter((s) => s.hidden));
	let menu = $state<{ id: number; x: number; y: number; items: MenuItem[] } | null>(null);
	let list = $state<HTMLElement>();

	function open(id: number, x: number, y: number) {
		if (!editable) return;
		const at = shown.findIndex((s) => s.id === id);
		const items: MenuItem[] = [
			{ id: 'rename', label: 'Rename…', icon: 'pencil' },
			{ id: 'left', label: 'Move left', disabled: at <= 0 },
			{ id: 'right', label: 'Move right', disabled: at >= shown.length - 1 },
			{ id: 'hide', label: 'Hide', icon: 'eye-off', disabled: shown.length <= 1 },
			{ id: 'delete', label: 'Delete…', icon: 'trash', disabled: sheets.length <= 1 },
			...hidden.map((s) => ({
				id: `show:${s.id}`,
				label: `Show “${s.name}”`,
				icon: 'eye' as const
			}))
		];
		menu = { id, x, y, items };
	}

	function onkeydown(e: KeyboardEvent) {
		if (naming) return;
		const at = shown.findIndex((s) => s.id === current);
		let next = -1;
		if (e.key === 'ArrowRight') next = Math.min(shown.length - 1, at + 1);
		else if (e.key === 'ArrowLeft') next = Math.max(0, at - 1);
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = shown.length - 1;
		else return;
		e.preventDefault();
		onpick(shown[next].id);
		requestAnimationFrame(() =>
			list?.querySelector<HTMLElement>(`[data-sheet="${shown[next].id}"]`)?.focus()
		);
	}
</script>

<div class="tabs">
	{#if editable && canAdd}
		<button type="button" class="add" aria-label="Add sheet" title="Add sheet" onclick={onadd}
			><Icon name="plus" size={14} /></button
		>
	{/if}
	<div class="list" role="tablist" aria-label="Sheets" bind:this={list} tabindex="-1" {onkeydown}>
		{#each shown as s (s.id)}
			{#if naming?.id === s.id}
				<input
					class="tab naming"
					aria-label="Sheet name"
					aria-invalid={naming.error ? true : undefined}
					aria-describedby={naming.error ? `${uid}-error` : undefined}
					spellcheck="false"
					autocomplete="off"
					bind:value={naming.name}
					onkeydown={onnamingkey}
					onblur={() => void saveNaming(false)}
				/>
				{#if naming.error}
					<span id="{uid}-error" class="error" role="alert">{naming.error}</span>
				{/if}
			{:else}
				<button
					type="button"
					role="tab"
					class="tab"
					data-sheet={s.id}
					aria-selected={s.id === current}
					tabindex={s.id === current ? 0 : -1}
					title={editable ? 'Double-click to rename' : undefined}
					onclick={() => onpick(s.id)}
					ondblclick={() => void startNaming(s.id)}
					oncontextmenu={(e) => {
						e.preventDefault();
						onpick(s.id);
						open(s.id, e.clientX, e.clientY - 8);
					}}>{s.name}</button
				>
			{/if}
		{/each}
	</div>
</div>

{#if menu}
	{@const id = menu.id}
	<ContextMenu
		label="Sheet actions"
		items={menu.items}
		at={menu}
		onselect={(a) => onaction(id, a as TabAction)}
		onclose={() => (menu = null)}
	/>
{/if}

<style>
	.tabs {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		flex: 0 1 auto;
	}

	.list {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
		outline: none;
	}

	.list::-webkit-scrollbar {
		display: none;
	}

	.tab.naming {
		width: 14ch;
		border: 1px solid var(--border-field);
		background: var(--surface);
		color: var(--text-strong);
		cursor: text;
	}

	.tab.naming[aria-invalid='true'] {
		border-color: var(--danger);
	}

	.error {
		flex: none;
		color: var(--danger-ink);
		font-size: 12px;
		white-space: nowrap;
	}

	.add {
		width: 30px;
		height: 30px;
		flex: none;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
	}

	.add:hover {
		background: var(--surface-hover);
	}

	.tab {
		flex: none;
		height: 30px;
		padding: 0 14px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
	}

	.tab:hover {
		background: var(--surface-hover);
	}

	.tab[aria-selected='true'] {
		background: var(--surface);
		color: var(--text-strong);
		box-shadow:
			0 0 0 1px var(--border-strong),
			var(--shadow-sm);
	}
</style>
