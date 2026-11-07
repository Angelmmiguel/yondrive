<!--
  The slim dark rail of apps: Drive and Notes (PLAN section 3: no Media), a
  divider and the theme toggle. The toggle flips between light and dark through
  the theme state; "system" is shown as whichever the browser resolves to.
-->
<script lang="ts">
	import { theme } from '$lib/state/theme.svelte';
	import Icon from './Icon.svelte';
	import Logo from './Logo.svelte';

	interface Props {
		current?: 'drive' | 'notes';
		hrefs?: { drive: string; notes: string };
		productName?: string;
	}

	let {
		current = 'drive',
		hrefs = { drive: '/', notes: '/notes' },
		productName = 'YonDrive'
	}: Props = $props();

	const apps = [
		{ id: 'drive', label: 'Drive', icon: 'folder' },
		{ id: 'notes', label: 'Notes', icon: 'note' }
	] as const;

	let systemDark = $state(false);
	$effect(() => {
		if (typeof matchMedia !== 'function') return;
		const query = matchMedia('(prefers-color-scheme: dark)');
		systemDark = query.matches;
		const update = (e: MediaQueryListEvent) => (systemDark = e.matches);
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});

	const dark = $derived(theme.choice === 'dark' || (theme.choice === 'system' && systemDark));
	const toggleLabel = $derived(dark ? 'Switch to light theme' : 'Switch to dark theme');
</script>

<nav class="rail" aria-label="Apps">
	<span class="logo"><Logo label={productName} /></span>
	{#each apps as app (app.id)}
		<a
			class="app"
			class:on={current === app.id}
			href={hrefs[app.id]}
			aria-current={current === app.id ? 'page' : undefined}
		>
			<Icon name={app.icon} size={22} />
			{app.label}
		</a>
	{/each}
	<span class="rule" aria-hidden="true"></span>
	<button
		type="button"
		class="app toggle"
		aria-label={toggleLabel}
		title={toggleLabel}
		onclick={() => theme.choose(dark ? 'light' : 'dark')}
	>
		<Icon name={dark ? 'sun' : 'moon'} size={20} />
	</button>
</nav>

<style>
	.rail {
		width: 64px;
		flex: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 14px 6px;
		background: var(--surface-rail);
		--focus-ring: var(--focus-ring-rail);
	}

	.logo {
		width: 52px;
		height: 44px;
		display: grid;
		place-items: center;
		margin-bottom: 6px;
	}

	.app {
		width: 52px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		padding: 7px 0 6px;
		border: 0;
		border-radius: 12px;
		background: transparent;
		color: var(--on-rail);
		font-size: 11px;
		font-weight: 500;
		text-decoration: none;
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}

	.app:hover {
		background: var(--rail-hover);
		color: var(--rail-strong);
	}

	.app.on {
		background: var(--rail-active);
		color: var(--rail-strong);
	}

	.app.on :global(svg) {
		color: var(--rail-accent);
	}

	.toggle {
		height: 44px;
		justify-content: center;
		padding: 0;
	}

	.rule {
		width: 32px;
		height: 1px;
		margin: 6px 10px;
		background: var(--rail-line);
	}
</style>
