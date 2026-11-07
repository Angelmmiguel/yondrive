<!--
  Tabs with the roving tabindex pattern: Left and Right (and Home, End) move
  between tabs and select them. The panel for the selected tab is rendered by
  the `children` snippet, which receives the tab's id.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	export interface Tab {
		id: string;
		label: string;
	}

	interface Props {
		label: string;
		tabs: readonly Tab[];
		value?: string;
		height?: number;
		children: Snippet<[string]>;
	}

	let { label, tabs, value = $bindable(), height = 48, children }: Props = $props();

	const uid = $props.id();
	const selected = $derived(tabs.some((t) => t.id === value) ? value! : tabs[0]?.id);
	let list = $state<HTMLElement>();

	function onkeydown(event: KeyboardEvent) {
		const at = tabs.findIndex((t) => t.id === selected);
		let next = -1;
		if (event.key === 'ArrowRight') next = (at + 1) % tabs.length;
		else if (event.key === 'ArrowLeft') next = (at - 1 + tabs.length) % tabs.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = tabs.length - 1;
		if (next < 0) return;
		event.preventDefault();
		value = tabs[next].id;
		list?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
	}
</script>

<div class="tabs">
	<div bind:this={list} class="list" role="tablist" aria-label={label}>
		{#each tabs as tab (tab.id)}
			<button
				type="button"
				role="tab"
				id="{uid}-tab-{tab.id}"
				aria-selected={selected === tab.id}
				aria-controls="{uid}-panel-{tab.id}"
				tabindex={selected === tab.id ? 0 : -1}
				class="tab"
				{onkeydown}
				style:height="{height}px"
				onclick={() => (value = tab.id)}
			>
				{tab.label}
			</button>
		{/each}
	</div>
	{#if selected}
		<div
			id="{uid}-panel-{selected}"
			role="tabpanel"
			aria-labelledby="{uid}-tab-{selected}"
			class="panel"
		>
			{@render children(selected)}
		</div>
	{/if}
</div>

<style>
	.tabs {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.list {
		display: flex;
		gap: 18px;
		padding: 0 20px;
		border-bottom: 1px solid var(--divider);
	}

	.tab {
		padding: 0 2px;
		border: 0;
		background: transparent;
		color: var(--text-muted);
		font-weight: 500;
		cursor: pointer;
	}

	.tab:hover {
		color: var(--text-strong);
	}

	.tab[aria-selected='true'] {
		color: var(--text-strong);
		box-shadow: inset 0 -2px 0 var(--text-strong);
	}

	.tab:focus-visible {
		box-shadow:
			inset 0 -2px 0 var(--text-strong),
			var(--focus-ring);
		border-radius: 6px;
	}

	.panel {
		min-height: 0;
	}
</style>
