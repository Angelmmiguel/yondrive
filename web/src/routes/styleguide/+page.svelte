<!--
  The visual check for the component library: every component and variant, in the
  theme the page is in. Use the toggle at the top to see the other one. It holds
  no data and calls nothing.
-->
<script lang="ts">
	import { ThemeToggle } from '$lib/components';
	import Gallery from './Gallery.svelte';
</script>

<svelte:head>
	<title>Styleguide · YonDrive</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="board">
	<header>
		<h1>Styleguide</h1>
		<ThemeToggle />
	</header>
	<Gallery />
</main>

<style>
	.board {
		min-width: 0;
		padding: 24px;
		background: var(--surface-page);
		color: var(--text-body);
		font-size: 14px;
	}

	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 16px;
	}

	h1 {
		margin: 0;
		font-size: 26px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}
</style>
