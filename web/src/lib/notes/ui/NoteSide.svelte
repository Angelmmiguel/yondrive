<!--
  The Links and info panel of the note editor board. Links: the notes that link
  here with their context, what this note links to, and notes that mention its
  title without a link, which "Link it" turns into one. Info: where and how the
  note is kept, its numbers, exports and versions.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { formatBytes, formatWhen } from '$lib/app/format';
	import { Icon, Tabs } from '$lib/components';
	import { backlinks, NoteRefs, unlinkedMentions } from '$lib/notes/index';
	import type { NoteItem } from '$lib/notes/list';
	import { isNoteFile, notebookColor, titleOf } from '$lib/notes/model';
	import { drive } from '$lib/state/drive.svelte';
	import { notes } from '$lib/state/notes.svelte';
	import { session } from '$lib/state/session.svelte';

	interface Props {
		item: NoteItem;
		items: readonly NoteItem[];
		words: number;
		tab: 'links' | 'info' | 'comments';
		/** The note's comments, in a tab of their own. */
		comments?: Snippet;
		onopen: (id: string) => void;
		onexport: (kind: 'md' | 'pdf' | 'html' | 'doc') => void;
		onversions: () => void;
		onlinked: () => void;
		onclose?: () => void;
	}

	let {
		item,
		items,
		words,
		tab = $bindable(),
		onopen,
		onexport,
		onversions,
		onlinked,
		onclose,
		comments
	}: Props = $props();

	const refs = $derived(new NoteRefs(items));
	const byId = $derived(new Map(items.map((i) => [i.id, i])));
	const index = $derived(notes.index);
	const back = $derived(index ? backlinks(index, item.id, refs) : []);
	const mentions = $derived(
		index && !item.shared ? unlinkedMentions(index, { id: item.id, title: item.title }, refs) : []
	);
	const out = $derived.by(() => {
		void drive.rev;
		const list: { id: string; title: string; where: string; kind: 'note' | 'file' }[] = [];
		for (const link of item.entry?.links ?? []) {
			const id = refs.resolve(link);
			if (id === null || id === item.id || list.some((l) => l.id === id)) continue;
			const note = byId.get(id);
			if (note) {
				list.push({
					id,
					title: note.title,
					where: `Notes · ${note.notebook?.name ?? 'No notebook'}`,
					kind: 'note'
				});
				continue;
			}
			const node = drive.node(id);
			if (node === undefined) continue;
			const trail = drive.core?.tree.breadcrumbs(id) ?? [];
			list.push({
				id,
				title: isNoteFile(node) ? titleOf(node.name) : node.name,
				where: ['Drive', ...trail.slice(1, -1).map((t) => t.name)].join(' · '),
				kind: isNoteFile(node) ? 'note' : 'file'
			});
		}
		return list;
	});
	const attachments = $derived.by(() => {
		void drive.rev;
		const folder = item.node.parentId;
		if (folder === null) return [];
		return drive
			.children(folder)
			.filter((n) => (n.raw.attachment as { note?: string } | undefined)?.note === item.id);
	});
	const path = $derived(
		['Notes', ...(item.notebook ? [item.notebook.name] : []), item.node.name].join(' / ')
	);
	const storedAs = $derived(session.sealer?.storedAs('Markdown') ?? 'Markdown');
	const info = $derived([
		{ k: 'Notebook', v: item.notebook?.name ?? (item.shared ? 'Shared with you' : 'None') },
		{ k: 'Created', v: formatWhen(item.node.created) },
		{ k: 'Edited', v: formatWhen(item.node.updatedAt) },
		{ k: 'Words', v: `${words} · ${Math.max(1, Math.round(words / 200))} min read` },
		{
			k: 'Attachments',
			v:
				attachments.length === 0
					? 'None'
					: `${attachments.length} · ${formatBytes(attachments.reduce((n, a) => n + a.size, 0))}`
		},
		{ k: 'Stored as', v: `${storedAs}, ${path}` }
	]);

	const linked = new SvelteSet<string>();

	async function linkIt(from: string) {
		const node = drive.node(from);
		if (!node || !notes.core) return;
		const ok = await notes.run((core) => core.linkMention(node, item.title, item.id));
		if (ok) {
			linked.add(from);
			onlinked();
		}
	}

	const TABS = $derived([
		{ id: 'links', label: 'Links' },
		{ id: 'info', label: 'Info' },
		...(comments ? [{ id: 'comments', label: 'Comments' }] : [])
	]);
</script>

<aside class="side" aria-label="Links and info" data-testid="note-side">
	{#if onclose}
		<button type="button" class="close" aria-label="Close the panel" onclick={onclose}
			><Icon name="close" size={18} /></button
		>
	{/if}
	<Tabs label="Panel" tabs={TABS} bind:value={tab} height={57}>
		{#snippet children(id)}
			{#if id === 'comments'}
				{@render comments?.()}
			{:else if id === 'links'}
				<div class="pane">
					<section aria-labelledby="backlinks-h">
						<h3 id="backlinks-h">Backlinks · {back.length}</h3>
						{#each back as b (b.from)}
							{@const from = byId.get(b.from)}
							<button type="button" class="card" onclick={() => onopen(b.from)}>
								<span class="card-title">
									{#if from?.notebook}<span
											class="square"
											style:background="var(--notebook-{notebookColor(from.notebook.raw)})"
										></span>{/if}
									{from?.title ?? 'A note'}
								</span>
								<span class="context">{b.context}</span>
							</button>
						{:else}
							<p class="empty">No note links here yet.</p>
						{/each}
					</section>
					<section aria-labelledby="out-h">
						<h3 id="out-h">Links in this note · {out.length}</h3>
						{#each out as l (l.id)}
							<button type="button" class="link" onclick={() => onopen(l.id)}>
								<span class="ico {l.kind}"
									><Icon name={l.kind === 'note' ? 'note' : 'doc'} size={15} /></span
								>
								<span class="link-text"
									><span class="link-title">{l.title}</span><span class="where">{l.where}</span
									></span
								>
							</button>
						{:else}
							<p class="empty">Type [[ to link a note or a file.</p>
						{/each}
					</section>
					{#if !item.shared}
						<section aria-labelledby="mentions-h">
							<h3 id="mentions-h">Unlinked mentions · {mentions.length}</h3>
							{#each mentions as m (m.from)}
								<div class="mention">
									<span class="card-title">{byId.get(m.from)?.title ?? 'A note'}</span>
									<span class="context">{m.context}</span>
									{#if linked.has(m.from)}
										<span class="done">Linked — now a backlink</span>
									{:else}
										<button type="button" class="small" onclick={() => void linkIt(m.from)}
											>Link it</button
										>
									{/if}
								</div>
							{:else}
								<p class="empty">No other note mentions “{item.title}”.</p>
							{/each}
						</section>
					{/if}
				</div>
			{:else}
				<div class="pane">
					<dl>
						{#each info as d (d.k)}
							<dt>{d.k}</dt>
							<dd>{d.v}</dd>
						{/each}
					</dl>
					<div class="export">
						<span class="label">Export</span>
						<div class="buttons">
							<button type="button" class="small" onclick={() => onexport('md')}>Markdown</button>
							<button type="button" class="small" onclick={() => onexport('pdf')}>PDF</button>
							<button type="button" class="small" onclick={() => onexport('html')}>HTML</button>
							<button type="button" class="small" onclick={() => onexport('doc')}
								>Save to Drive as Doc</button
							>
						</div>
					</div>
					<button type="button" class="history" onclick={onversions}>View version history</button>
				</div>
			{/if}
		{/snippet}
	</Tabs>
</aside>

<style>
	.side {
		position: relative;
		flex: 1 1 300px;
		max-width: 360px;
		box-sizing: border-box;
		background: var(--surface-page);
		border-left: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		overflow-y: auto;
	}

	.close {
		position: absolute;
		top: 10px;
		right: 10px;
		z-index: 1;
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
	}

	.pane {
		display: flex;
		flex-direction: column;
		gap: 22px;
		padding: 18px 16px;
	}

	section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	h3 {
		margin: 0 4px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.card,
	.mention {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
		text-align: left;
	}

	.card {
		cursor: pointer;
	}

	.card:hover {
		border-color: var(--border-strong);
	}

	.mention {
		border-style: dashed;
		gap: 8px;
		background: transparent;
	}

	.card-title {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		font-size: 13px;
	}

	.square {
		width: 8px;
		height: 8px;
		border-radius: 2px;
	}

	.context {
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.link {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: var(--text-strong);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.link:hover {
		background: var(--surface-hover);
	}

	.ico {
		width: 28px;
		height: 28px;
		flex: none;
		display: grid;
		place-items: center;
		border-radius: 8px;
	}

	.ico.note {
		background: var(--notes-soft);
		color: var(--notes);
	}

	.ico.file {
		background: var(--drive-soft);
		color: var(--drive);
	}

	.link-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.link-title {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.where {
		font-size: 12px;
		color: var(--text-muted);
	}

	.empty {
		margin: 0 4px;
		font-size: 13px;
		color: var(--text-muted);
	}

	.small {
		align-self: flex-start;
		height: 30px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
	}

	.small:hover {
		background: var(--surface-hover);
	}

	.done {
		font-size: 12px;
		font-weight: 500;
		color: var(--ok);
	}

	dl {
		margin: 0;
		display: grid;
		grid-template-columns: 96px minmax(0, 1fr);
		gap: 10px 12px;
		font-size: 13px;
	}

	dt {
		color: var(--text-muted);
	}

	dd {
		margin: 0;
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}

	.export {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.label {
		font-size: 13px;
		color: var(--text-muted);
	}

	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.history {
		align-self: flex-start;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
	}
</style>
