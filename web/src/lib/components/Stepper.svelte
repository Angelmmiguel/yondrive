<!--
  The setup wizard's step list. The current step is marked aria-current, the
  steps before it show a check, and the ones after stay locked until reached
  (unless `free` lets the user jump anywhere).
-->
<script lang="ts">
	import Icon from './Icon.svelte';

	export interface Step {
		id: string;
		label: string;
		hint?: string;
	}

	interface Props {
		label?: string;
		steps: readonly Step[];
		current: string;
		onselect?: (id: string) => void;
		free?: boolean;
	}

	let { label = 'Steps', steps, current, onselect, free = false }: Props = $props();

	const at = $derived(steps.findIndex((s) => s.id === current));
</script>

<nav aria-label={label} class="stepper">
	{#each steps as step, i (step.id)}
		{@const done = i < at}
		{@const locked = !free && i > at}
		<button
			type="button"
			class="step"
			class:on={i === at}
			aria-current={i === at ? 'step' : undefined}
			aria-disabled={locked || undefined}
			onclick={() => {
				if (!locked && i !== at) onselect?.(step.id);
			}}
		>
			<span class="dot" class:done class:cur={i === at}>
				{#if done}
					<Icon name="check" size={14} strokeWidth={3} />
					<span class="sr">Done: </span>
				{:else}
					{i + 1}
				{/if}
			</span>
			<span class="text">
				<span class="name">{step.label}</span>
				{#if step.hint}<span class="hint">{step.hint}</span>{/if}
			</span>
		</button>
	{/each}
</nav>

<style>
	.stepper {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.step {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 56px;
		padding: 8px 12px;
		border: 0;
		border-radius: 12px;
		background: transparent;
		text-align: left;
		cursor: pointer;
		transition: background 0.12s;
	}

	.step:hover {
		background: var(--surface-hover);
	}

	.step.on {
		background: var(--surface);
		box-shadow: var(--shadow-sm);
	}

	.step[aria-disabled='true'] {
		cursor: not-allowed;
		opacity: 0.7;
	}

	.step[aria-disabled='true']:hover {
		background: transparent;
	}

	.dot {
		width: 28px;
		height: 28px;
		flex: none;
		display: grid;
		place-items: center;
		border-radius: 99px;
		font-size: 13px;
		font-weight: 600;
		color: var(--text-muted);
		box-shadow: inset 0 0 0 1.5px var(--border-strong);
	}

	.dot.cur {
		background: var(--accent);
		color: var(--on-accent);
		box-shadow: inset 0 0 0 1.5px var(--accent);
	}

	.dot.done {
		background: var(--ok-soft);
		color: var(--ok);
		box-shadow: inset 0 0 0 1.5px var(--ok-soft);
	}

	.text {
		display: flex;
		flex-direction: column;
	}

	.name {
		font-weight: 600;
		color: var(--text-strong);
	}

	.hint {
		font-size: 12px;
		color: var(--text-muted);
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
