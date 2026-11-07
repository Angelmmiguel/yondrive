<!--
  One option of a RadioGroup, drawn as a card: an icon, a title, an optional
  badge and a description. Used for the encryption mode choice.
-->
<script lang="ts">
	import { getContext, type Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';
	import { RADIO_GROUP, type RadioGroupContext } from './radio';

	interface Props {
		value: string;
		title: string;
		icon?: IconName;
		/** A short highlight at the right of the title, such as "Recommended". */
		badge?: string;
		disabled?: boolean;
		children?: Snippet;
	}

	let { value, title, icon, badge, disabled = false, children }: Props = $props();

	const group = getContext<RadioGroupContext>(RADIO_GROUP);
	const checked = $derived(group.value === value);
</script>

<button
	type="button"
	role="radio"
	aria-checked={checked}
	{disabled}
	tabindex={checked ? 0 : -1}
	class="card"
	onclick={() => group.select(value)}
>
	<span class="head">
		{#if icon}<span class="icon"><Icon name={icon} size={20} /></span>{/if}
		<span class="title">{title}</span>
		{#if badge}<span class="badge">{badge}</span>{/if}
	</span>
	{#if children}<span class="desc">{@render children()}</span>{/if}
</button>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 16px;
		border: 1px solid var(--border-strong);
		border-radius: 14px;
		background: var(--surface);
		text-align: left;
		cursor: pointer;
		transition:
			border-color 0.12s,
			box-shadow 0.12s,
			background 0.12s;
	}

	.card:hover {
		border-color: var(--accent-ring);
	}

	.card[aria-checked='true'] {
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
		background: var(--accent-soft);
	}

	.card:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.icon {
		display: inline-flex;
		color: var(--accent);
	}

	.title {
		font-weight: 600;
		color: var(--text-strong);
	}

	.badge {
		margin-left: auto;
		font-size: 11px;
		font-weight: 600;
		color: var(--ok-ink);
		background: var(--ok-soft);
		padding: 2px 8px;
		border-radius: 99px;
	}

	.desc {
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
