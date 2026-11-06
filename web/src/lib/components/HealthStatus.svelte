<!--
  Draws the server's health response: whether it is up, its version and
  whether setup is done. It fetches nothing; the page hands it the result.
-->
<script lang="ts">
	import type { Health } from '$lib/api/types';

	let { health, error = null }: { health: Health | null; error?: string | null } = $props();
</script>

<section class="card" aria-live="polite" data-testid="health">
	{#if error}
		<p class="state bad">Server unreachable <span class="code">{error}</span></p>
	{:else if health}
		<p class="state ok">Server is {health.status}</p>
		<dl>
			<dt>Version</dt>
			<dd class="code" data-testid="health-version">{health.version}</dd>
			<dt>Setup</dt>
			<dd data-testid="health-setup">{health.setup ? 'Complete' : 'Not started'}</dd>
		</dl>
	{:else}
		<p class="state">Checking the server</p>
	{/if}
</section>

<style>
	.card {
		background: var(--surface);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
		padding: var(--space-6);
		min-width: min(20rem, 100%);
	}

	.state {
		margin: 0 0 var(--space-3);
		font-weight: 500;
		color: var(--text-strong);
	}

	.ok::before,
	.bad::before {
		content: '';
		display: inline-block;
		width: 0.5rem;
		height: 0.5rem;
		margin-right: var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--ok);
	}

	.bad::before {
		background: var(--danger);
	}

	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--space-1) var(--space-4);
		margin: 0;
	}

	dt {
		color: var(--text-muted);
	}

	dd {
		margin: 0;
	}

	.code {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
</style>
