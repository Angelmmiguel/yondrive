<!--
  The home page. For now it only proves the pipeline end to end: the typed
  client calls the Go server and the answer is drawn.
-->
<script lang="ts">
	import { getHealth } from '$lib/api/client';
	import type { Health } from '$lib/api/types';
	import { HealthStatus, ThemeToggle } from '$lib/components';

	let health = $state<Health | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		getHealth()
			.then((h) => (health = h))
			.catch((e: unknown) => (error = e instanceof Error ? e.message : 'unknown'));
	});
</script>

<main>
	<h1>YonDrive</h1>
	<p class="lede">Your files, documents and notes on your own server, readable only by you.</p>
	<HealthStatus {health} {error} />
	<ThemeToggle />
</main>

<style>
	main {
		display: grid;
		justify-items: start;
		gap: var(--space-4);
		padding: var(--space-8) var(--space-4);
		max-width: 40rem;
		margin: 0 auto;
	}

	h1 {
		margin: 0;
		font-family: var(--font-serif);
		font-size: var(--text-display);
		color: var(--text-strong);
	}

	.lede {
		margin: 0;
		color: var(--text-muted);
	}
</style>
