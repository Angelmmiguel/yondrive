<!-- The single centred card of a screen outside the app: signing in, unlocking, a link's form. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Logo from './Logo.svelte';

	interface Props {
		title: string;
		lede?: string;
		width?: number;
		children: Snippet;
	}

	let { title, lede, width = 440, children }: Props = $props();
</script>

<main class="wrap">
	<div class="card" style:max-width="{width}px">
		<span class="brand"><Logo size={28} /> YonDrive</span>
		<h1>{title}</h1>
		{#if lede}<p class="lede">{lede}</p>{/if}
		<div class="body">{@render children()}</div>
	</div>
</main>

<style>
	.wrap {
		flex: 1;
		display: grid;
		place-items: center;
		padding: 32px 16px;
		background: var(--surface-side);
	}

	.card {
		width: 100%;
		min-width: 0;
		padding: 28px 32px 32px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 20px;
		box-shadow: 0 20px 50px -36px var(--shadow-ink);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 18px;
		font-size: 15px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}

	h1 {
		margin: 0;
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}

	.lede {
		margin: 6px 0 0;
		color: var(--text-muted);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 16px;
		margin-top: 22px;
	}

	.body :global(form) {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	@media (max-width: 480px) {
		.card {
			padding: 22px 18px 24px;
		}
	}
</style>
