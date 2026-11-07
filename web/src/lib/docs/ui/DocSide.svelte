<!-- The details column of the editor board: the file's facts and the format it is saved in, or its versions. -->
<script lang="ts">
	import { formatBytes, formatWhen } from '$lib/app/format';
	import { Button, Tabs, Tag } from '$lib/components';
	import { FORMAT_NAMES, type DocFormat, type SaveFormat } from '$lib/formats/document';
	import type { VersionEntry } from '$lib/drive/versions';

	interface Props {
		tab: 'details' | 'versions';
		details: { k: string; v: string }[];
		format: DocFormat;
		saveFormat: SaveFormat;
		canEdit: boolean;
		versions: VersionEntry[];
		versionsError: string;
		onconvert: (f: SaveFormat) => void;
		onrestore: (v: VersionEntry) => void;
		ondownload: (v: VersionEntry) => void;
	}

	let {
		tab = $bindable(),
		details,
		format,
		saveFormat,
		canEdit,
		versions,
		versionsError,
		onconvert,
		onrestore,
		ondownload
	}: Props = $props();

	const TARGETS: SaveFormat[] = ['docx', 'odt', 'rtf', 'md', 'txt'];
</script>

<aside class="side" aria-label="Document details">
	<Tabs
		label="Panel"
		tabs={[
			{ id: 'details', label: 'Details' },
			{ id: 'versions', label: 'Versions' }
		]}
		bind:value={tab}
	>
		{#snippet children(id)}
			{#if id === 'details'}
				<div class="details">
					<dl>
						{#each details as d (d.k)}
							<dt>{d.k}</dt>
							<dd>{d.v}</dd>
						{/each}
					</dl>
					{#if canEdit}
						<div class="saveas">
							<label for="doc-saveas">Save changes as</label>
							<select
								id="doc-saveas"
								value={saveFormat}
								onchange={(e) => {
									const next = e.currentTarget.value as SaveFormat;
									e.currentTarget.value = saveFormat;
									if (next !== saveFormat) onconvert(next);
								}}
							>
								{#each TARGETS as f (f)}
									<option value={f}>
										{FORMAT_NAMES[f]} (.{f}){f === format ? ' — original' : ''}
									</option>
								{/each}
							</select>
							<span class="hint">Converting keeps a copy of the original in Versions.</span>
						</div>
					{/if}
				</div>
			{:else}
				{#if versionsError}<p class="failed">{versionsError}</p>{/if}
				<ol class="versions">
					{#each versions as v (v.id)}
						<li data-testid="doc-version" class:current={v.current}>
							<span class="dot" aria-hidden="true"></span>
							<span class="what">
								<span class="when">{formatWhen(v.createdAt)}</span>
								<span class="note">{formatBytes(v.size)}{v.restored ? ' · restored' : ''}</span>
							</span>
							{#if v.current}
								<Tag tone="green">Current</Tag>
							{:else}
								<Button size="sm" variant="ghost" onclick={() => ondownload(v)}>Download</Button>
								{#if canEdit}
									<Button
										size="sm"
										onclick={() => onrestore(v)}
										label="Restore version from {formatWhen(v.createdAt)}">Restore</Button
									>
								{/if}
							{/if}
						</li>
					{/each}
				</ol>
			{/if}
		{/snippet}
	</Tabs>
</aside>

<style>
	.side {
		flex: 1 1 300px;
		max-width: 100%;
		box-sizing: border-box;
		background: var(--surface-page);
		border-left: 1px solid var(--border);
	}

	.details {
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 22px;
	}

	dl {
		margin: 0;
		display: grid;
		grid-template-columns: 92px minmax(0, 1fr);
		gap: 10px 12px;
		font-size: 14px;
	}

	dt {
		color: var(--text-muted);
	}

	dd {
		margin: 0;
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}

	.saveas {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.saveas label {
		font-size: 13px;
		color: var(--text-muted);
	}

	.saveas select {
		height: 40px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: 10px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
	}

	.hint {
		font-size: 12px;
		color: var(--text-muted);
	}

	.versions {
		list-style: none;
		margin: 0;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.versions li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px;
		border-radius: 10px;
	}

	.versions li.current {
		background: var(--surface);
	}

	.dot {
		width: 9px;
		height: 9px;
		flex: none;
		border-radius: 99px;
		background: var(--border-strong);
	}

	.current .dot {
		background: var(--ok);
	}

	.what {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.when {
		font-weight: 500;
		color: var(--text-strong);
	}

	.note {
		font-size: 12px;
		color: var(--text-muted);
	}

	.failed {
		margin: 12px 20px 0;
		color: var(--danger-ink);
	}
</style>
