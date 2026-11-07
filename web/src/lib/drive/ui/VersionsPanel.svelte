<!-- A file's versions, beside the list: restore, download, delete, and a new one. -->
<script lang="ts">
	import { formatBytes, formatDay, formatWhen } from '$lib/app/format';
	import { Button, Icon, SidePanel, Tag } from '$lib/components';
	import { drive } from '$lib/state/drive.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import {
		deleteVersion,
		listVersions,
		restoreVersion,
		type VersionDeps,
		type VersionEntry
	} from '../versions';
	import { api } from '$lib/api/client';
	import { session } from '$lib/state/session.svelte';
	import { describeDriveError } from '../errors';

	const node = $derived(
		drive.versionsOf === null ? null : (drive.node(drive.versionsOf.id) ?? drive.versionsOf)
	);
	let versions = $state.raw<VersionEntry[]>([]);
	let failed = $state('');
	let picker = $state<HTMLInputElement>();

	function deps(): VersionDeps | null {
		const core = drive.core;
		if (core === null || session.sealer === null) return null;
		return { api, sealer: session.sealer, tree: core.tree };
	}

	const nodeId = $derived(node?.id ?? null);
	const current = $derived(node?.currentVersion ?? null);

	$effect(() => {
		const id = nodeId;
		const live = current;
		if (id !== null) void load(id, live);
	});

	async function load(id: string, live: string | null) {
		const d = deps();
		if (d === null) return;
		try {
			failed = '';
			versions = await listVersions(id, live, d);
		} catch (e) {
			failed = describeDriveError(e);
		}
	}

	async function restore(version: VersionEntry) {
		const d = deps();
		if (d === null || nodeId === null) return;
		await drive.run(() => restoreVersion(nodeId as string, version, current, d));
		toasts.push('ok', 'Restored as the current version.');
		await drive.refreshStorage();
	}

	async function remove(version: VersionEntry) {
		const d = deps();
		if (d === null || nodeId === null) return;
		await drive.run(() => deleteVersion(nodeId as string, version.id, d));
		await load(nodeId, current);
		toasts.push('info', 'That version is marked for removal. You can restore it until it goes.');
	}

	function upload(event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = '';
		if (file !== undefined && nodeId !== null) drive.core?.queue.addVersion(nodeId, file);
	}

	const close = () => (drive.versionsOf = null);
</script>

<svelte:window
	onkeydown={(event) => {
		if (node !== null && drive.dialog === null && event.key === 'Escape') close();
	}}
/>

{#if node}
	<div class="wrap">
		<SidePanel label="Versions of {node.name}" width={360}>
			<header class="head">
				<div>
					<h2>Versions</h2>
					<p class="name" title={node.name}>{node.name}</p>
				</div>
				<button type="button" class="close" aria-label="Close versions" onclick={close}>
					<Icon name="close" size={16} strokeWidth={2} />
				</button>
			</header>
			<div class="add">
				<Button size="sm" icon="upload" onclick={() => picker?.click()}>Upload new version</Button>
				<input
					bind:this={picker}
					type="file"
					hidden
					data-testid="version-input"
					onchange={upload}
				/>
			</div>
			{#if failed}<p class="failed">{failed}</p>{/if}
			<ul>
				{#each versions as version (version.id)}
					<li data-testid="version">
						<div class="line">
							<span class="when">{formatWhen(version.createdAt)}</span>
							{#if version.current}<Tag tone="blue">Current</Tag>{/if}
							{#if version.restored}<Tag tone="grey">Restored</Tag>{/if}
						</div>
						<span class="meta">{formatBytes(version.size)}</span>
						{#if version.removeAt !== null}
							<span class="meta warn">Removed for good on {formatDay(version.removeAt)}</span>
						{/if}
						<div class="actions">
							<Button
								size="sm"
								variant="ghost"
								onclick={() => node && drive.download(node, version.id)}>Download</Button
							>
							{#if !version.current}
								<Button size="sm" variant="ghost" onclick={() => restore(version)}>Restore</Button>
								{#if version.removeAt === null}
									<Button size="sm" variant="ghost" onclick={() => remove(version)}>Delete</Button>
								{/if}
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</SidePanel>
	</div>
{/if}

<style>
	.wrap {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 24;
		display: flex;
		max-width: 100vw;
		box-shadow: 0 24px 60px -24px var(--shadow-ink);
		overflow-y: auto;
		background: var(--surface-page);
	}

	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 18px 16px 8px 20px;
	}

	h2 {
		margin: 0;
		font-size: 17px;
		font-weight: 600;
		color: var(--text-strong);
	}

	.name {
		margin: 2px 0 0;
		max-width: 260px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		color: var(--text-muted);
	}

	.close {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
	}

	.close:hover {
		background: var(--surface-hover);
	}

	.add {
		padding: 4px 20px 12px;
	}

	.failed {
		margin: 0;
		padding: 0 20px;
		color: var(--danger-ink);
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--divider);
	}

	li {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 12px 20px;
		border-bottom: 1px solid var(--divider);
	}

	.line {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.when {
		font-weight: 500;
		color: var(--text-strong);
	}

	.meta {
		font-size: 12px;
		color: var(--text-muted);
	}

	.warn {
		color: var(--warn-ink);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin: 4px 0 0 -10px;
	}
</style>
