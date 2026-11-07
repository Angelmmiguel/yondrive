<!-- The Home board's sidebar: New, the places, tags, and how much room is left. -->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Icon, Menu, NavItem, NavSection, type MenuItem } from '$lib/components';
	import { drive } from '$lib/state/drive.svelte';
	import { sharing } from '$lib/state/sharing.svelte';

	interface Props {
		onnewfolder: () => void;
		onuploadfiles: () => void;
		onuploadfolder: () => void;
	}

	let { onnewfolder, onuploadfiles, onuploadfolder }: Props = $props();

	const path = $derived(page.url.pathname);
	const items: MenuItem[] = [
		{ id: 'folder', label: 'New folder', icon: 'folder' },
		{ id: 'files', label: 'Upload files', icon: 'upload' },
		{ id: 'tree', label: 'Upload a folder', icon: 'upload' }
	];

	function choose(id: string) {
		if (id === 'folder') onnewfolder();
		else if (id === 'files') onuploadfiles();
		else onuploadfolder();
	}

	const DOTS: Record<string, string> = {
		blue: 'var(--dot-blue)',
		green: 'var(--dot-green)',
		orange: 'var(--dot-orange)',
		rose: 'var(--dot-rose)',
		grey: 'var(--star-off)'
	};
</script>

<Menu label="New" align="start" width={212} {items} onselect={choose}>
	{#snippet trigger(attrs)}
		<button type="button" class="new" {...attrs}>
			<Icon name="plus" size={18} strokeWidth={2} /> New
		</button>
	{/snippet}
</Menu>

<nav aria-label="Main" class="places">
	<NavItem label="Home" icon="home" href={resolve('/')} current={path === '/'} />
	<NavItem
		label="My files"
		icon="folder"
		href={resolve('/files/root')}
		current={path.startsWith('/files/')}
	/>
	<NavItem
		label="Shared with me"
		icon="shared"
		href={resolve('/shared')}
		current={path === '/shared'}
		badge={sharing.unread.length || undefined}
	/>
	<NavItem
		label="Shared by me"
		icon="arrow-right"
		href={resolve('/shared/by-me')}
		current={path === '/shared/by-me'}
	/>
	<NavItem label="Recent" icon="recent" href={resolve('/recent')} current={path === '/recent'} />
	<NavItem
		label="Favorites"
		icon="star"
		href={resolve('/favorites')}
		current={path === '/favorites'}
		count={drive.favorites.length || undefined}
	/>
	<NavItem
		label="Trash"
		icon="trash"
		href={resolve('/trash')}
		current={path === '/trash'}
		count={drive.trash.length || undefined}
	/>
</nav>

<NavSection title="Tags">
	{#snippet action()}
		<button
			type="button"
			class="add"
			aria-label="New tag"
			onclick={() => (drive.dialog = { kind: 'new-tag' })}
		>
			<Icon name="plus" size={14} strokeWidth={2} />
		</button>
	{/snippet}
	{#each drive.tags as tag (tag.id)}
		<NavItem
			label={tag.name}
			dot={DOTS[tag.tone]}
			href={resolve(`/tags/${tag.id}`)}
			current={path === `/tags/${tag.id}`}
			count={drive.tagCount(tag.id)}
		/>
	{/each}
</NavSection>

<style>
	.new {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 212px;
		max-width: 100%;
		min-height: 44px;
		padding: 0 14px;
		border: 0;
		border-radius: 12px;
		background: var(--primary);
		color: var(--on-primary);
		font-weight: 500;
		cursor: pointer;
	}

	.new:hover {
		filter: brightness(1.08);
	}

	.places {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.add {
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
	}

	.add:hover {
		background: var(--surface-hover);
	}
</style>
