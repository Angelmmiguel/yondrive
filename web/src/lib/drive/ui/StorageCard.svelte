<!--
  "Your space": what is used of the quota, split by kind where the client can tell,
  and the time of the last backup if an administrator can see it. The server knows
  no file types, so the split comes from the tree and falls back to the total.
-->
<script lang="ts">
	import { formatBytes, formatWhen } from '$lib/app/format';
	import { ProgressBar, type ProgressSegment } from '$lib/components';
	import { drive } from '$lib/state/drive.svelte';

	const storage = $derived(drive.storage);
	const used = $derived(storage?.used_bytes ?? 0);
	const quota = $derived(storage?.quota_bytes ?? 0);
	const categories = $derived(drive.categories);
	const known = $derived(
		categories.images + categories.video + categories.documents + categories.other
	);
	const scale = $derived(Math.max(quota, used, 1));

	const segments = $derived.by<ProgressSegment[]>(() => {
		if (known === 0 || known > used) return [{ value: used, color: 'var(--accent)' }];
		return [
			{ value: categories.images, color: 'var(--file-image)' },
			{ value: categories.video, color: 'var(--file-video)' },
			{ value: categories.documents, color: 'var(--drive)' },
			{
				value: Math.max(used - categories.images - categories.video - categories.documents, 0),
				color: 'var(--star-off)'
			}
		];
	});

	const summary = $derived(
		quota === 0 ? `${formatBytes(used)} used` : `${formatBytes(used)} of ${formatBytes(quota)}`
	);
	const description = $derived(
		known === 0 || known > used
			? `Storage: ${summary}`
			: `Storage: images ${formatBytes(categories.images)}, video ${formatBytes(categories.video)}, documents ${formatBytes(categories.documents)}, other ${formatBytes(categories.other)}`
	);
</script>

{#if storage}
	<div class="card" data-testid="storage">
		<div class="line">
			<span class="title">Your space</span>
			<span class="figures">{summary}</span>
		</div>
		<ProgressBar label={description} {segments} max={scale} />
		{#if drive.lastBackup}
			<div class="health">
				<span class="dot" aria-hidden="true"></span>
				Server healthy · backed up {formatWhen(Date.parse(drive.lastBackup))}
			</div>
		{/if}
	</div>
{/if}

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: 14px;
		background: var(--surface);
	}

	.line {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 8px;
	}

	.title {
		font-weight: 500;
		color: var(--text-strong);
	}

	.figures,
	.health {
		font-size: 12px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.health {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 99px;
		background: var(--ok);
	}
</style>
