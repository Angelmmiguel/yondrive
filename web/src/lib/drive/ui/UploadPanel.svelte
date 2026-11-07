<!-- The upload queue, in the corner of the app while there is anything on it. -->
<script lang="ts">
	import { formatBytes } from '$lib/app/format';
	import { Button, Icon, ProgressBar } from '$lib/components';
	import { drive } from '$lib/state/drive.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import { uploadPanel } from '$lib/state/uploadPanel.svelte';
	import { describeDriveError } from '../errors';
	import type { UploadItem, UploadStatus } from '../upload/queue';

	const items = $derived(drive.uploads);
	const moving = $derived(items.filter((i) => i.status === 'uploading' || i.status === 'queued'));
	const finished = $derived(items.some((i) => i.status === 'done' || i.status === 'cancelled'));
	let folded = $state(false);

	$effect(() => {
		uploadPanel.sync(items);
	});
	$effect(() => () => uploadPanel.dispose());
	let picker = $state<HTMLInputElement>();
	let resuming: number | null = null;

	const STATUS: Record<UploadStatus, string> = {
		queued: 'Waiting',
		uploading: 'Uploading',
		done: 'Done',
		failed: 'Failed',
		cancelled: 'Cancelled',
		paused: 'Interrupted. Choose the file again to go on.'
	};

	function pickFor(item: UploadItem) {
		resuming = item.id;
		picker?.click();
	}

	function picked(event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = '';
		if (file === undefined || resuming === null) return;
		if (!drive.core?.queue.resumeWith(resuming, file)) {
			toasts.push('warn', 'That is not the same file: its name, size or date differ.');
		}
	}

	const percent = (item: UploadItem) =>
		Math.min(100, Math.floor((item.done / Math.max(item.size, 1)) * 100));

	const heading = $derived(
		moving.length > 0
			? `Uploading ${moving.length} ${moving.length === 1 ? 'file' : 'files'}`
			: 'Uploads'
	);
</script>

{#if items.length > 0 && uploadPanel.phase === 'pill'}
	<button
		type="button"
		class="pill"
		data-testid="upload-pill"
		aria-label="{uploadPanel.count} uploaded. Show uploads"
		onclick={() => uploadPanel.expand()}
	>
		<Icon name="check" size={16} strokeWidth={2} />
		{uploadPanel.count} uploaded
	</button>
{:else if items.length > 0}
	<section class="panel" aria-label="Uploads" data-testid="upload-panel">
		<header class="head">
			<h2>{heading}</h2>
			{#if finished}
				<Button size="sm" variant="ghost" onclick={() => drive.core?.queue.clearFinished()}
					>Clear</Button
				>
			{/if}
			<button
				type="button"
				class="fold"
				class:folded
				aria-label={folded ? 'Show uploads' : 'Hide uploads'}
				aria-expanded={!folded}
				onclick={() => (folded = !folded)}
			>
				<Icon name="chevron-down" size={16} />
			</button>
		</header>
		{#if !folded}
			<ul>
				{#each items as item (item.id)}
					<li data-status={item.status}>
						<div class="row">
							<span class="name" title={item.name}>{item.name}</span>
							{#if item.status === 'failed'}
								<Button size="sm" variant="ghost" onclick={() => drive.core?.queue.retry(item.id)}
									>Retry</Button
								>
							{/if}
							{#if item.status === 'paused'}
								<Button size="sm" variant="ghost" onclick={() => pickFor(item)}>Choose file</Button>
							{/if}
							{#if item.status !== 'done' && item.status !== 'cancelled'}
								<button
									type="button"
									class="cancel"
									aria-label="Cancel {item.name}"
									onclick={() => drive.core?.queue.cancel(item.id)}
								>
									<Icon name="close" size={14} strokeWidth={2} />
								</button>
							{/if}
						</div>
						{#if item.status === 'uploading' || item.status === 'queued'}
							<ProgressBar
								label="Progress of {item.name}"
								value={item.done}
								max={Math.max(item.size, 1)}
								height={4}
							/>
						{/if}
						<span class="status" class:bad={item.status === 'failed'}>
							{#if item.status === 'failed'}
								{describeDriveError(item.error)}
							{:else if item.status === 'uploading'}
								{formatBytes(item.done)} of {formatBytes(item.size)} · {percent(item)}%
							{:else}
								{STATUS[item.status]}
							{/if}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
		<input
			bind:this={picker}
			type="file"
			hidden
			data-testid="upload-resume-input"
			onchange={picked}
		/>
	</section>
{/if}

<style>
	.panel {
		position: fixed;
		right: 16px;
		bottom: 16px;
		z-index: 25;
		width: min(380px, calc(100vw - 32px));
		max-height: min(420px, 60vh);
		display: flex;
		flex-direction: column;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 16px;
		box-shadow: 0 16px 40px -16px var(--shadow-ink);
	}

	.pill {
		position: fixed;
		right: 16px;
		bottom: 16px;
		z-index: 25;
		height: 36px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0 14px;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		background: var(--surface);
		box-shadow: 0 8px 24px -12px var(--shadow-ink);
		color: var(--text-strong);
		font-weight: 500;
		cursor: pointer;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 10px 10px 10px 16px;
		border-bottom: 1px solid var(--divider);
	}

	h2 {
		flex: 1;
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--text-strong);
	}

	.fold,
	.cancel {
		width: 32px;
		height: 32px;
		flex: none;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
	}

	.fold:hover,
	.cancel:hover {
		background: var(--surface-hover);
	}

	.fold.folded {
		transform: rotate(180deg);
	}

	ul {
		margin: 0;
		padding: 4px 0;
		list-style: none;
		overflow-y: auto;
	}

	li {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 12px 8px 16px;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
	}

	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
		color: var(--text-strong);
	}

	.status {
		font-size: 12px;
		color: var(--text-muted);
	}

	.status.bad {
		color: var(--danger-ink);
	}
</style>
