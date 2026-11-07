<!--
  One note in the list, as a card or a row: its title, the start of its text or
  its tasks, a picture if it has one, and its notebook, time, reminder and links.
  The pin sits over it, shown on hover, focus, or when pinned.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatWhen } from '$lib/app/format';
	import { Icon } from '$lib/components';
	import { openTasks, type NoteItem } from '$lib/notes/list';
	import { notebookColor } from '$lib/notes/model';
	import { notes } from '$lib/state/notes.svelte';

	interface Props {
		item: NoteItem;
		layout: 'card' | 'row';
		onpin: (item: NoteItem) => void;
	}

	let { item, layout, onpin }: Props = $props();

	const href = $derived(resolve(`/notes/${item.id}`));
	const color = $derived(item.notebook ? notebookColor(item.notebook.raw) : null);
	const tasks = $derived(item.entry?.tasks ?? []);
	const done = $derived(tasks.filter((t) => t.done).length);
	const links = $derived(item.entry?.links.length ?? 0);
	const image = $derived(item.entry?.images[0] ?? null);
	const preview = $derived(
		item.entry?.preview || tasks.map((t) => t.text).join(' · ') || 'No text yet'
	);
	const reminder = $derived(
		item.meta.reminder === null
			? null
			: new Date(item.meta.reminder).toLocaleString(undefined, {
					month: 'short',
					day: 'numeric',
					hour: 'numeric',
					minute: '2-digit'
				})
	);

	let imageUrl = $state<string | null>(null);
	$effect(() => {
		const id = image;
		imageUrl = null;
		if (id === null || layout !== 'card') return;
		let live = true;
		void notes.imageUrl(id).then((url) => {
			if (live) imageUrl = url;
		});
		return () => {
			live = false;
		};
	});
</script>

<div class="wrap {layout}" data-testid="note-card" data-note={item.id}>
	{#if layout === 'card'}
		<a class="card" class:daily={item.meta.daily !== null} {href}>
			{#if imageUrl}
				<img class="art" src={imageUrl} alt="" />
			{/if}
			<span class="title">{item.title}</span>
			{#if tasks.length > 0}
				<span class="tasks">
					{#each tasks.slice(0, 4) as t, i (i)}
						<span class="task" class:done={t.done}>
							<span class="box" aria-hidden="true">
								{#if t.done}<Icon name="check" size={9} strokeWidth={4} />{/if}
							</span>
							{t.text}
						</span>
					{/each}
					<span class="summary" data-testid="task-summary">{done} of {tasks.length} done</span>
				</span>
			{:else}
				<span class="text">{preview}</span>
			{/if}
			<span class="meta">
				{#if item.notebook}
					<span class="nb"
						><span class="square" style:background="var(--notebook-{color})"></span>{item.notebook
							.name}</span
					>
				{:else if item.shared}
					<span class="nb">Shared with you</span>
				{/if}
				<span>{formatWhen(item.node.updatedAt)}</span>
				{#if reminder}
					<span class="reminder"><Icon name="alarm" size={11} strokeWidth={2.2} />{reminder}</span>
				{/if}
				{#if links > 0}
					<span class="links"
						><Icon name="link" size={11} strokeWidth={2.2} />{links}
						{links === 1 ? 'link' : 'links'}</span
					>
				{/if}
				{#if item.tags.length > 0}
					<span class="tags">{item.tags.map((t) => `#${t}`).join(' ')}</span>
				{/if}
			</span>
		</a>
	{:else}
		<a class="row" {href}>
			<span
				class="bar"
				style:background={color ? `var(--notebook-${color})` : 'var(--border-strong)'}
			></span>
			<span class="main">
				<span class="title">{item.title}</span>
				<span class="text">{preview.split('\n')[0]}</span>
			</span>
			<span class="side">
				<span>{item.notebook?.name ?? (item.shared ? 'Shared' : '')}</span>
				<span>{formatWhen(item.node.updatedAt)}</span>
				{#if openTasks(item) > 0}<span>{openTasks(item)} to do</span>{/if}
			</span>
		</a>
	{/if}
	{#if !item.shared}
		<button
			type="button"
			class="pin"
			class:on={item.meta.pinned}
			aria-pressed={item.meta.pinned}
			aria-label={item.meta.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`}
			onclick={() => onpin(item)}
		>
			<Icon name="pin" size={16} strokeWidth={1.8} />
		</button>
	{/if}
</div>

<style>
	.wrap {
		position: relative;
	}

	.wrap.card {
		break-inside: avoid;
		margin: 0 0 14px;
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: 16px;
		background: var(--surface);
		color: var(--text-strong);
		text-decoration: none;
		overflow: hidden;
		transition:
			transform 0.18s ease,
			box-shadow 0.18s ease,
			border-color 0.18s;
	}

	.card.daily {
		background: var(--notes-card-amber);
	}

	.card:hover {
		transform: translateY(-2px);
		border-color: var(--border-strong);
		box-shadow: var(--shadow-lg);
	}

	@media (prefers-reduced-motion: reduce) {
		.card {
			transition: none;
		}
	}

	.art {
		display: block;
		width: calc(100% + 32px);
		max-height: 160px;
		margin: -16px -16px 2px;
		object-fit: cover;
	}

	.title {
		font-weight: 600;
		font-size: 15px;
		letter-spacing: -0.01em;
		padding-right: 30px;
		overflow-wrap: anywhere;
	}

	.text {
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-soft);
		white-space: pre-line;
		overflow-wrap: anywhere;
	}

	.tasks {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.task {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-body);
	}

	.task.done {
		color: var(--text-muted);
		text-decoration: line-through;
	}

	.box {
		width: 14px;
		height: 14px;
		flex: none;
		box-sizing: border-box;
		display: grid;
		place-items: center;
		border-radius: 4px;
		border: 1.5px solid var(--text-muted);
		color: var(--surface);
	}

	.task.done .box {
		border-color: var(--notes);
		background: var(--notes);
	}

	.summary {
		font-size: 12px;
		color: var(--text-muted);
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.nb,
	.links,
	.reminder {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	.square {
		width: 8px;
		height: 8px;
		border-radius: 2px;
	}

	.reminder {
		gap: 4px;
		padding: 1px 7px;
		border-radius: 99px;
		background: var(--notes-soft);
		color: var(--notes-ink);
	}

	.tags {
		color: var(--text-soft);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 12px 56px 12px 16px;
		color: var(--text-strong);
		text-decoration: none;
		border-bottom: 1px solid var(--divider);
	}

	.row:hover {
		background: var(--surface-sunken);
	}

	.bar {
		width: 4px;
		align-self: stretch;
		border-radius: 4px;
	}

	.main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.main .title,
	.main .text {
		padding: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.side {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 12px;
		color: var(--text-muted);
		text-align: right;
	}

	.pin {
		position: absolute;
		top: 8px;
		right: 8px;
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 10px;
		background: var(--surface);
		color: var(--text-muted);
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.row ~ .pin {
		top: 50%;
		transform: translateY(-50%);
		background: transparent;
	}

	.wrap:hover .pin,
	.pin.on,
	.pin:focus-visible {
		opacity: 1;
	}

	.pin.on {
		color: var(--notes);
	}

	.pin.on :global(svg) {
		fill: var(--notes-pin);
	}

	@media (hover: none) {
		.pin {
			opacity: 1;
		}
	}

	@media (max-width: 480px) {
		.side {
			display: none;
		}
	}
</style>
