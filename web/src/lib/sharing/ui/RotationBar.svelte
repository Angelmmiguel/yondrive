<!-- Keys being replaced: it can take a while on a large folder, and should not be cut short. -->
<script lang="ts">
	import { Banner, Button, ProgressBar } from '$lib/components';
	import { sharing } from '$lib/state/sharing.svelte';
	import { unrekeyedText } from '../rotation';
</script>

{#if sharing.unrekeyedCount > 0}
	<div class="warning" data-testid="rotation-unrekeyed">
		<Banner tone="warn" title={unrekeyedText(sharing.unrekeyedCount)}>
			Their keys do not open, so nobody can read them from here. They were left as they were, under
			keys the person who lost access may hold. Someone with edit access, or the server, wrote them
			like that. Everything else has new keys.
			{#snippet actions()}
				<Button size="sm" onclick={() => sharing.dismissUnrekeyed()}>Dismiss</Button>
			{/snippet}
		</Banner>
	</div>
{/if}

{#if sharing.rotation}
	<div class="bar" data-testid="rotation-progress">
		<span class="text">
			Replacing keys after a revocation: {sharing.rotation.done} of {sharing.rotation.total}. Keep
			this tab open until it finishes.
		</span>
		<ProgressBar
			label="Replacing keys"
			value={sharing.rotation.done}
			max={Math.max(sharing.rotation.total, 1)}
		/>
	</div>
{/if}

<style>
	.warning {
		margin-bottom: 16px;
	}

	.bar {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 16px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--surface);
	}

	.text {
		font-size: 13px;
		color: var(--text-soft);
	}
</style>
