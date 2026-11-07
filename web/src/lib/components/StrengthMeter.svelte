<!--
  Four bars and a word for a password's strength. It scores nothing itself:
  the caller passes the score (0 to 4), so the policy stays with the screen.
-->
<script lang="ts">
	interface Props {
		score: number;
		labels?: readonly string[];
	}

	let { score, labels = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'] }: Props = $props();

	const clamped = $derived(Math.max(0, Math.min(4, Math.round(score))));
	const tone = $derived(clamped <= 1 ? 'danger' : clamped === 2 ? 'warn' : 'ok');
</script>

<div class="meter" role="status">
	<span class="bars" aria-hidden="true">
		{#each [0, 1, 2, 3] as i (i)}
			<span class="bar" class:on={i < clamped} data-tone={tone}></span>
		{/each}
	</span>
	<span class="word" data-tone={clamped === 0 ? 'none' : tone}>{labels[clamped]}</span>
</div>

<style>
	.meter {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.bars {
		flex: 1;
		display: flex;
		gap: 4px;
	}

	.bar {
		flex: 1;
		height: 4px;
		border-radius: 99px;
		background: var(--track);
	}

	.bar.on[data-tone='danger'] {
		background: var(--danger);
	}

	.bar.on[data-tone='warn'] {
		background: var(--warn);
	}

	.bar.on[data-tone='ok'] {
		background: var(--ok);
	}

	.word {
		font-weight: 500;
	}

	.word[data-tone='danger'] {
		color: var(--danger-ink);
	}

	.word[data-tone='warn'] {
		color: var(--warn-ink);
	}

	.word[data-tone='ok'] {
		color: var(--ok);
	}
</style>
