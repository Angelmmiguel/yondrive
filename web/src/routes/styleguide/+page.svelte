<!--
  The visual check for the component library: every component and variant, drawn
  twice side by side, once forced light and once forced dark. It holds no data
  and calls nothing.
-->
<script lang="ts">
	import Gallery from './Gallery.svelte';
</script>

<svelte:head>
	<title>Styleguide · YonDrive</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="boards">
	{#each ['light', 'dark'] as const as scheme (scheme)}
		<div class="board" style:color-scheme={scheme}>
			<h1>{scheme === 'light' ? 'Light' : 'Dark'}</h1>
			<Gallery />
		</div>
	{/each}
</main>

<style>
	.boards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 640px), 1fr));
	}

	.board {
		min-width: 0;
		padding: 24px;
		background: var(--surface-page);
		color: var(--text-body);
		font-size: 14px;
	}

	h1 {
		margin: 0 0 16px;
		font-size: 26px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}
</style>
