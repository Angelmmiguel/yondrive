<!--
  A notice in the page flow. Danger is announced at once (role=alert); the
  others politely (role=status). A dismissible banner hides itself and tells
  the caller.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	type Tone = 'info' | 'ok' | 'warn' | 'danger' | 'neutral';

	interface Props {
		tone?: Tone;
		title?: string;
		dismissible?: boolean;
		ondismiss?: () => void;
		/** Overrides the icon of the tone. */
		icon?: IconName;
		actions?: Snippet;
		children: Snippet;
	}

	let {
		tone = 'info',
		title,
		dismissible = false,
		ondismiss,
		icon,
		actions,
		children
	}: Props = $props();

	const ICON: Record<Tone, IconName> = {
		info: 'info',
		ok: 'check',
		neutral: 'info',
		warn: 'warn',
		danger: 'warn'
	};
	let hidden = $state(false);
</script>

{#if !hidden}
	<div class="banner {tone}" role={tone === 'danger' ? 'alert' : 'status'}>
		<span class="icon"><Icon name={icon ?? ICON[tone]} size={18} /></span>
		<div class="body">
			{#if title}<strong class="title">{title}</strong>{/if}
			<div class="text">{@render children()}</div>
			{#if actions}<div class="actions">{@render actions()}</div>{/if}
		</div>
		{#if dismissible}
			<button
				type="button"
				class="close"
				aria-label="Dismiss"
				onclick={() => {
					hidden = true;
					ondismiss?.();
				}}
			>
				<Icon name="close" size={15} strokeWidth={2} />
			</button>
		{/if}
	</div>
{/if}

<style>
	.banner {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px 14px;
		border: 1px solid transparent;
		border-radius: 12px;
		font-size: 13px;
	}

	.info {
		background: var(--info-soft);
		color: var(--info-ink);
	}

	.ok {
		background: var(--ok-soft);
		color: var(--ok-ink);
	}

	.ok .icon {
		color: var(--ok);
	}

	.warn {
		background: var(--warn-soft);
		color: var(--warn-ink);
		border-color: var(--warn-line);
	}

	.danger {
		background: var(--danger-soft);
		color: var(--danger-ink);
	}

	.neutral {
		background: var(--surface);
		color: var(--text-soft);
		border-color: var(--border-strong);
	}

	.neutral .icon {
		color: var(--accent);
	}

	.icon {
		display: inline-flex;
		padding-top: 1px;
	}

	.body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.title {
		font-weight: 600;
	}

	.text {
		color: var(--text-soft);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 6px;
	}

	.close {
		width: 32px;
		height: 32px;
		margin: -6px -6px -6px 0;
		flex: none;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
	}

	.close:hover {
		background: var(--surface-hover);
	}
</style>
