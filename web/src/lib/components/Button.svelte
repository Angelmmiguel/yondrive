<!--
  A real button in four forms: primary (the one action), secondary (bordered),
  ghost (bare) and icon (square, needs a `label` for its accessible name).
  With an `href` it is a link drawn the same way.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	interface Props extends Omit<HTMLButtonAttributes, 'children'> {
		variant?: 'primary' | 'secondary' | 'ghost' | 'icon';
		size?: 'md' | 'sm';
		/** Icon drawn before the label; the only content of an icon button. */
		icon?: IconName;
		/** Icon drawn after the label. */
		trailingIcon?: IconName;
		/** Accessible name; required for the icon variant. */
		label?: string;
		href?: string;
		busy?: boolean;
		children?: Snippet;
	}

	let {
		variant = 'secondary',
		size = 'md',
		icon,
		trailingIcon,
		label,
		href,
		busy = false,
		disabled = false,
		type = 'button',
		children,
		class: klass,
		...rest
	}: Props = $props();

	const iconSize = $derived(size === 'sm' ? 15 : 18);
</script>

{#snippet content()}
	{#if icon}<Icon name={icon} size={variant === 'icon' ? iconSize + 2 : iconSize} />{/if}
	{@render children?.()}
	{#if trailingIcon}<Icon name={trailingIcon} size={iconSize} strokeWidth={2.2} />{/if}
{/snippet}

{#if href && !disabled}
	<a
		{href}
		class={['btn', variant, size, klass]}
		aria-label={label}
		title={variant === 'icon' ? label : undefined}
	>
		{@render content()}
	</a>
{:else}
	<button
		{...rest}
		{type}
		class={['btn', variant, size, klass]}
		disabled={disabled || busy}
		aria-busy={busy || undefined}
		aria-label={label}
		title={rest.title ?? (variant === 'icon' ? label : undefined)}
	>
		{@render content()}
	</button>
{/if}

<style>
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 44px;
		padding: 0 16px;
		border: 1px solid transparent;
		border-radius: 12px;
		font-weight: 500;
		line-height: 1;
		text-decoration: none;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background 0.12s,
			filter 0.12s,
			opacity 0.12s;
	}

	.btn.sm {
		height: 36px;
		padding: 0 12px;
		border-radius: 10px;
		font-size: 13px;
	}

	.primary {
		background: var(--primary);
		color: var(--on-primary);
		padding: 0 20px;
		font-weight: 600;
	}

	.primary.sm {
		padding: 0 14px;
	}

	.primary:hover {
		filter: brightness(1.08);
	}

	.secondary {
		background: var(--surface);
		color: var(--text-strong);
		border-color: var(--border-strong);
	}

	.secondary:hover,
	.ghost:hover,
	.icon:hover {
		background: var(--surface-hover);
	}

	.ghost,
	.icon {
		background: transparent;
		color: var(--text-soft);
	}

	.icon {
		width: 44px;
		padding: 0;
	}

	.icon.sm {
		width: 36px;
	}

	.btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.btn:disabled:hover {
		filter: none;
	}

	.btn[aria-busy='true'] {
		cursor: progress;
	}

	@media (prefers-reduced-motion: reduce) {
		.btn {
			transition: none;
		}
	}
</style>
