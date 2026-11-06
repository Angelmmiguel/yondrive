<!--
  A segmented control for the colour theme. It draws the choices and owns the
  interaction: picking one tells the theme state, which stores and paints it.
-->
<script lang="ts">
	import { THEMES, theme } from '$lib/state/theme.svelte';
</script>

<div class="toggle" role="radiogroup" aria-label="Theme">
	{#each THEMES as t (t.id)}
		<button
			type="button"
			role="radio"
			aria-checked={theme.choice === t.id}
			class:on={theme.choice === t.id}
			onclick={() => theme.choose(t.id)}
		>
			{t.label}
		</button>
	{/each}
</div>

<style>
	.toggle {
		display: inline-flex;
		padding: 2px;
		gap: 2px;
		background: var(--surface-sunken);
		border-radius: var(--radius-md);
		box-shadow: 0 0 0 1px var(--border);
	}

	button {
		border: 0;
		background: transparent;
		color: var(--text-muted);
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	button.on {
		background: var(--surface);
		color: var(--text-strong);
		box-shadow: var(--shadow-sm);
	}
</style>
