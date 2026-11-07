<!--
  A transient message. The caller owns the timing and removes it; here it is
  only drawn, announced (danger at once, the rest politely) and dismissible.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	type Tone = 'info' | 'ok' | 'warn' | 'danger';

	interface Props {
		tone?: Tone;
		ondismiss?: () => void;
		action?: Snippet;
		children: Snippet;
	}

	let { tone = 'info', ondismiss, action, children }: Props = $props();

	const ICON: Record<Tone, IconName> = { info: 'info', ok: 'check', warn: 'warn', danger: 'warn' };
</script>

<div class="toast {tone}" role={tone === 'danger' ? 'alert' : 'status'}>
	<span class="icon"><Icon name={ICON[tone]} size={18} /></span>
	<span class="text">{@render children()}</span>
	{#if action}<span class="action">{@render action()}</span>{/if}
	{#if ondismiss}
		<button type="button" class="close" aria-label="Dismiss" onclick={ondismiss}>
			<Icon name="close" size={15} strokeWidth={2} />
		</button>
	{/if}
</div>

<style>
	.toast {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 260px;
		max-width: 420px;
		padding: 10px 10px 10px 14px;
		border: 1px solid var(--border-strong);
		border-radius: 12px;
		background: var(--surface);
		color: var(--text-body);
		box-shadow: 0 16px 40px -16px var(--shadow-ink);
	}

	.icon {
		display: inline-flex;
	}

	.info .icon {
		color: var(--accent);
	}

	.ok .icon {
		color: var(--ok);
	}

	.warn .icon {
		color: var(--warn);
	}

	.danger .icon {
		color: var(--danger);
	}

	.text {
		flex: 1;
		min-width: 0;
	}

	.close {
		width: 32px;
		height: 32px;
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
