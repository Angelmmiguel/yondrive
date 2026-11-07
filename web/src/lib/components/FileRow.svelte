<!--
  One file or folder in the list view. The name is a link (with an href) or a
  button that selects it; the star is its own toggle button. Meant to sit in a FileList.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Avatar from './Avatar.svelte';
	import { FILE_KINDS, type FileKind } from './fileKinds';
	import { FILE_COLUMNS } from './fileColumns';
	import Icon from './Icon.svelte';
	import Tag from './Tag.svelte';

	export interface FileTag {
		name: string;
		tone?: 'green' | 'blue' | 'orange' | 'rose' | 'grey';
	}

	interface Props {
		name: string;
		kind: FileKind;
		/** Replaces the kind's default caption under the name. */
		caption?: string;
		tags?: readonly FileTag[];
		/** People it is shared with; none reads as "Only you". */
		people?: readonly string[];
		modified: string;
		size: string;
		starred?: boolean;
		selected?: boolean;
		href?: string;
		/** An image to draw instead of the kind's icon. */
		thumbnail?: string | null;
		/** Sits in the first column, usually a checkbox. */
		leading?: Snippet;
		/** Sits in the last column, usually a menu. */
		actions?: Snippet;
		onselect?: () => void;
		onstar?: (starred: boolean) => void;
	}

	let {
		name,
		kind,
		caption,
		tags = [],
		people = [],
		modified,
		size,
		starred = false,
		selected = false,
		href,
		thumbnail,
		leading,
		actions,
		onselect,
		onstar
	}: Props = $props();

	const style = $derived(FILE_KINDS[kind]);
</script>

<div
	class="row"
	class:sel={selected}
	role="row"
	aria-selected={selected}
	style:--cols={FILE_COLUMNS}
>
	<span role="cell" class="lead">{@render leading?.()}</span>
	<span role="cell" class="name-cell">
		{#snippet content()}
			<span class="badge" style:background={style.soft} style:color={style.ink}>
				{#if thumbnail}
					<img src={thumbnail} alt="" />
				{:else}
					<Icon name={style.icon} size={18} />
				{/if}
			</span>
			<span class="text">
				<span class="title">{name}</span>
				<span class="caption">{caption ?? style.label}</span>
			</span>
		{/snippet}

		{#if href}
			<a class="name" {href} aria-current={selected ? 'true' : undefined} onclick={onselect}
				>{@render content()}</a
			>
		{:else}
			<button
				type="button"
				class="name"
				aria-current={selected ? 'true' : undefined}
				onclick={onselect}>{@render content()}</button
			>
		{/if}
	</span>
	<span role="cell" class="tags">
		{#each tags as tag (tag.name)}<Tag tone={tag.tone ?? 'grey'}>{tag.name}</Tag>{/each}
	</span>
	<span role="cell" class="people">
		{#each people as person (person)}<span class="overlap"
				><Avatar name={person} size={24} ring /></span
			>{/each}
		{#if people.length === 0}<span class="solo">Only you</span>{/if}
	</span>
	<span role="cell" class="meta">{modified}</span>
	<span role="cell" class="meta size">{size}</span>
	<span role="cell" class="star-cell">
		<button
			type="button"
			class="star"
			class:on={starred}
			aria-label="Favorite {name}"
			aria-pressed={starred}
			onclick={() => onstar?.(!starred)}
		>
			<Icon name="star" size={17} strokeWidth={1.7} filled={starred} />
		</button>
	</span>
	<span role="cell" class="more">{@render actions?.()}</span>
</div>

<style>
	.row {
		display: grid;
		grid-template-columns: var(--cols);
		align-items: center;
		gap: 12px;
		min-height: 56px;
		padding: 0 16px;
		border-bottom: 1px solid var(--divider);
		transition: background 0.12s;
	}

	.row:last-child {
		border-bottom: 0;
	}

	.row:hover {
		background: var(--surface-sunken);
	}

	.row.sel {
		background: var(--surface-selected);
	}

	.name-cell {
		min-width: 0;
	}

	.name {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 44px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-strong);
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}

	.badge {
		width: 34px;
		height: 34px;
		flex: none;
		display: grid;
		place-items: center;
		border-radius: 9px;
		overflow: hidden;
	}

	.badge img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.lead {
		display: flex;
		align-items: center;
	}

	.more {
		display: flex;
		justify-content: center;
	}

	.text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.title {
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.caption,
	.solo {
		font-size: 12px;
		color: var(--text-muted);
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.people {
		display: flex;
		align-items: center;
	}

	.overlap {
		display: inline-flex;
		margin-right: -7px;
	}

	.meta {
		font-size: 13px;
		color: var(--text-soft);
	}

	.size {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.star {
		width: 44px;
		height: 44px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: var(--star-off);
		cursor: pointer;
	}

	.star:hover {
		background: var(--surface-hover);
	}

	.star.on {
		color: var(--star);
	}

	.star.on :global(path) {
		stroke: var(--star-line);
	}
</style>
