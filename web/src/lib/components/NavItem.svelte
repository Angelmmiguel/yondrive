<!--
  One entry of the sidebar navigation: a link when it has an href, otherwise a
  button. `current` marks the page you are on. Tag rows use `dot` instead of an icon.
-->
<script lang="ts">
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	interface Props {
		label: string;
		icon?: IconName;
		/** A colour token for a tag dot, e.g. 'var(--dot-blue)'. */
		dot?: string;
		count?: number | string;
		/** An accent pill, for unread items. */
		badge?: number | string;
		current?: boolean;
		href?: string;
		onclick?: () => void;
	}

	let { label, icon, dot, count, badge, current = false, href, onclick }: Props = $props();
</script>

{#snippet content()}
	{#if icon}
		<span class="ico"><Icon name={icon} size={18} strokeWidth={1.7} /></span>
	{:else if dot}
		<span class="dot" style:background={dot} aria-hidden="true"></span>
	{/if}
	<span class="label">{label}</span>
	{#if count !== undefined}<span class="count">{count}</span>{/if}
	{#if badge !== undefined}<span class="pill">{badge}</span>{/if}
{/snippet}

{#if href}
	<a
		class={['nav', { on: current, small: !!dot }]}
		{href}
		aria-current={current ? 'page' : undefined}
		{onclick}
	>
		{@render content()}
	</a>
{:else}
	<button
		type="button"
		class={['nav', { on: current, small: !!dot }]}
		aria-current={current ? 'page' : undefined}
		{onclick}
	>
		{@render content()}
	</button>
{/if}

<style>
	.nav {
		display: flex;
		align-items: center;
		gap: 11px;
		min-height: 38px;
		padding: 0 10px;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: var(--text-soft);
		font-weight: 500;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		transition: background 0.15s;
	}

	.nav.small {
		min-height: 34px;
		font-weight: 400;
	}

	.nav:hover {
		background: var(--surface-hover);
		color: var(--text-soft);
	}

	.nav.on {
		background: var(--surface);
		box-shadow: var(--shadow-sm);
	}

	.ico {
		display: inline-flex;
		color: var(--icon);
	}

	.dot {
		width: 9px;
		height: 9px;
		margin: 0 4px;
		border-radius: 3px;
	}

	.label {
		flex: 1;
		min-width: 0;
	}

	.count {
		font-size: 12px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.pill {
		font-size: 11px;
		font-weight: 600;
		color: var(--on-accent);
		background: var(--accent);
		border-radius: 999px;
		padding: 1px 7px;
	}
</style>
