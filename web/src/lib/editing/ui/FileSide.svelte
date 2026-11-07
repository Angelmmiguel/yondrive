<!--
  The details column of the editor boards: the file's facts and the format it is
  saved in, or its versions. Documents and spreadsheets each give their formats.
-->
<script lang="ts">
	import { formatBytes, formatWhen } from '$lib/app/format';
	import { Button, Icon, Tabs, Tag } from '$lib/components';
	import type { VersionEntry } from '$lib/drive/versions';

	interface Props {
		/** The panel's accessible name. */
		label: string;
		tab: 'details' | 'versions';
		details: { k: string; v: string }[];
		/** The format the file came in, marked as the original. */
		format: string;
		saveFormat: string;
		/** What the file may be saved as, with each format's name. */
		targets: { id: string; name: string }[];
		hint: string;
		canEdit: boolean;
		versions: VersionEntry[];
		versionsError: string;
		onconvert: (f: string) => void;
		onrestore: (v: VersionEntry) => void;
		ondownload: (v: VersionEntry) => void;
		/** Given when the panel lies over the page, as on a phone: a button closes it. */
		onclose?: () => void;
	}

	let {
		label,
		tab = $bindable(),
		details,
		format,
		saveFormat,
		targets,
		hint,
		canEdit,
		versions,
		versionsError,
		onconvert,
		onrestore,
		ondownload,
		onclose
	}: Props = $props();
	const uid = $props.id();
</script>

<aside class="side" aria-label={label}>
	{#if onclose}
		<button type="button" class="close" aria-label="Close details" onclick={onclose}
			><Icon name="close" size={16} /></button
		>
	{/if}
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
							<label for="{uid}-saveas">Save changes as</label>
							<select
								id="{uid}-saveas"
								value={saveFormat}
								onchange={(e) => {
									const next = e.currentTarget.value;
									e.currentTarget.value = saveFormat;
									if (next !== saveFormat) onconvert(next);
								}}
							>
								{#each targets as f (f.id)}
									<option value={f.id}>
										{f.name} (.{f.id}){f.id === format ? ' — original' : ''}
									</option>
								{/each}
							</select>
							<span class="hint">{hint}</span>
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
		position: relative;
		flex: 1 1 300px;
		max-width: 100%;
		box-sizing: border-box;
		background: var(--surface-page);
		border-left: 1px solid var(--border);
	}

	.close {
		position: absolute;
		top: 8px;
		right: 8px;
		z-index: 1;
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.close:hover {
		background: var(--surface-hover);
		color: var(--text-strong);
	}

	.close:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
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
