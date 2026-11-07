<!-- One file or folder in the grid view: a tinted preview over its name, with a star on top. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { FILE_KINDS, type FileKind } from './fileKinds';
	import Icon from './Icon.svelte';

	interface Props {
		name: string;
		kind: FileKind;
		modified: string;
		size?: string;
		starred?: boolean;
		selected?: boolean;
		href?: string;
		/** An image to draw instead of the kind's icon. */
		thumbnail?: string | null;
		/** Sits over the preview at the top left, usually a checkbox. */
		leading?: Snippet;
		/** Sits under the star, usually a menu. */
		actions?: Snippet;
		onselect?: () => void;
		onstar?: (starred: boolean) => void;
	}

	let {
		name,
		kind,
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

<div class="tile" class:sel={selected}>
	{#snippet content()}
		<span class="preview" style:background={style.soft} style:color={style.ink}>
			{#if thumbnail}
				<img src={thumbnail} alt="" />
			{:else}
				<Icon name={style.icon} size={40} strokeWidth={1.4} />
			{/if}
		</span>
		<span class="info">
			<span class="title">{name}</span>
			<span class="meta">{modified}{size ? ` · ${size}` : ''}</span>
		</span>
	{/snippet}

	{#if href}
		<a class="main" {href} aria-current={selected ? 'true' : undefined} onclick={onselect}
			>{@render content()}</a
		>
	{:else}
		<button
			type="button"
			class="main"
			aria-current={selected ? 'true' : undefined}
			onclick={onselect}>{@render content()}</button
		>
	{/if}
	<button
		type="button"
		class="star"
		class:on={starred}
		aria-label="Favorite {name}"
		aria-pressed={starred}
		onclick={() => onstar?.(!starred)}
	>
		<Icon name="star" size={16} strokeWidth={1.7} filled={starred} />
	</button>
	{#if leading}<span class="lead">{@render leading()}</span>{/if}
	{#if actions}<span class="more">{@render actions()}</span>{/if}
</div>

<style>
	.tile {
		position: relative;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: 16px;
		background: var(--surface);
		overflow: hidden;
		transition:
			transform 0.18s ease,
			box-shadow 0.18s ease,
			border-color 0.18s;
	}

	.tile:hover {
		transform: translateY(-2px);
		border-color: var(--border-strong);
		box-shadow: var(--shadow-lg);
	}

	.tile.sel {
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}

	.main {
		display: flex;
		flex-direction: column;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-strong);
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}

	.preview {
		position: relative;
		flex: none;
		width: 100%;
		height: 116px;
		display: grid;
		place-items: center;
		overflow: hidden;
	}

	.preview img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.lead {
		position: absolute;
		top: 14px;
		left: 12px;
	}

	.more {
		position: absolute;
		top: 44px;
		right: 6px;
		background: var(--surface);
		border-radius: 10px;
	}

	.info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		padding: 10px 12px 12px;
		background: var(--surface);
	}

	.title {
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.meta {
		font-size: 12px;
		color: var(--text-muted);
	}

	.star {
		position: absolute;
		top: 6px;
		right: 6px;
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 10px;
		background: var(--surface);
		color: var(--star-off);
		cursor: pointer;
	}

	.star.on {
		color: var(--star);
	}

	.star.on :global(path) {
		stroke: var(--star-line);
	}

	@media (prefers-reduced-motion: reduce) {
		.tile {
			transition: none;
		}

		.tile:hover {
			transform: none;
		}
	}
</style>
