<!-- The app shell every signed-in screen sits in, and what stays around between them. -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { readDisplayName } from '$lib/account/display-name';
	import { lock, signOut } from '$lib/account/session';
	import {
		AppRail,
		AppShell,
		Avatar,
		Icon,
		Menu,
		NavItem,
		SearchField,
		Sidebar,
		TopBar,
		type MenuItem
	} from '$lib/components';
	import DriveDialogs from '$lib/drive/ui/DriveDialogs.svelte';
	import SearchPalette from '$lib/search/ui/SearchPalette.svelte';
	import NotificationBell from '$lib/sharing/ui/NotificationBell.svelte';
	import RotationBar from '$lib/sharing/ui/RotationBar.svelte';
	import SharingDialogs from '$lib/sharing/ui/SharingDialogs.svelte';
	import DriveSidebar from '$lib/drive/ui/DriveSidebar.svelte';
	import StorageCard from '$lib/drive/ui/StorageCard.svelte';
	import { uploadPanel } from '$lib/state/uploadPanel.svelte';
	import UploadPanel from '$lib/drive/ui/UploadPanel.svelte';
	import VersionsPanel from '$lib/drive/ui/VersionsPanel.svelte';
	import Viewer from '$lib/drive/ui/Viewer.svelte';
	import { drive } from '$lib/state/drive.svelte';
	import { search } from '$lib/state/search.svelte';
	import { session } from '$lib/state/session.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import { setContext, untrack } from 'svelte';
	import type { ShellActions } from './shell';

	let { children } = $props();

	const path = $derived(page.url.pathname);
	const fullScreen = $derived(path.startsWith('/doc/') || path.startsWith('/sheet/'));
	const encrypted = $derived(session.sealer?.encrypted ?? true);
	const username = $derived(session.account?.user.username ?? '');
	const isAdmin = $derived(session.account?.user.role === 'admin');
	const displayName = $derived(readDisplayName(localStorage) || username);

	const items = $derived<MenuItem[]>([
		{ id: 'settings', label: 'Settings' },
		...(isAdmin ? [{ id: 'admin', label: 'Administration' }] : []),
		...(encrypted ? [{ id: 'lock', label: 'Lock' }] : []),
		{ id: 'signout', label: 'Sign out' }
	]);

	function choose(id: string) {
		if (id === 'settings') void goto(resolve('/settings'));
		else if (id === 'admin') void goto(resolve('/admin'));
		else if (id === 'lock') void lock();
		else void signOut();
	}

	// The drive lives as long as this shell: a lock or sign-out unmounts it, which
	// zeroes every key the drive holds, however the lock arrived.
	$effect(() => {
		if (session.status !== 'unlocked') return;
		untrack(() => drive.start());
		return () => drive.stop();
	});

	let filesInput = $state<HTMLInputElement>();
	let folderInput = $state<HTMLInputElement>();
	let dragging = $state(false);

	const uploads = [
		{ id: 'files', label: 'Upload files' },
		{ id: 'folder', label: 'Upload a folder' }
	];

	const actions: ShellActions = {
		newFolder(parentId) {
			if (!drive.canAddHere) {
				toasts.push('info', 'You can only view this folder, so nothing can be added to it.');
				return;
			}
			const parent = parentId ?? drive.folder ?? drive.rootId;
			if (parent !== null) drive.dialog = { kind: 'new-folder', parentId: parent };
		},
		uploadFiles: () => {
			if (drive.canAddHere) filesInput?.click();
			else toasts.push('info', 'You can only view this folder, so nothing can be added to it.');
		},
		uploadFolder: () => {
			if (drive.canAddHere) folderInput?.click();
			else toasts.push('info', 'You can only view this folder, so nothing can be added to it.');
		}
	};
	setContext<ShellActions>('shell', actions);

	const shortcut = /mac|iphone|ipad/i.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';

	function keydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			if (search.open) search.hide();
			else search.show();
		}
	}

	function picked(event: Event & { currentTarget: HTMLInputElement }) {
		drive.uploadInput(event.currentTarget.files);
		event.currentTarget.value = '';
	}

	const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

	function dragover(event: DragEvent) {
		if (!hasFiles(event) || fullScreen) return;
		event.preventDefault();
		dragging = true;
	}

	function dragleave(event: DragEvent) {
		if (event.relatedTarget === null) dragging = false;
	}

	function drop(event: DragEvent) {
		dragging = false;
		if (!hasFiles(event) || event.dataTransfer === null) return;
		event.preventDefault();
		void drive.uploadDrop(event.dataTransfer);
	}
</script>

<svelte:window ondragover={dragover} ondragleave={dragleave} ondrop={drop} onkeydown={keydown} />

{#if fullScreen}
	<!-- The editor is a screen of its own, with the drive still running behind it. -->
	{@render children()}
{:else}
	<AppShell>
		{#snippet rail()}
			<AppRail
				current={path.startsWith('/notes') ? 'notes' : 'drive'}
				hrefs={{ drive: resolve('/'), notes: resolve('/notes') }}
			/>
		{/snippet}
		{#snippet sidebar()}
			<Sidebar title="Drive" label="Drive">
				<DriveSidebar
					onnewfolder={() => actions.newFolder()}
					onuploadfiles={actions.uploadFiles}
					onuploadfolder={actions.uploadFolder}
				/>
				{#snippet footer()}
					<StorageCard />
					<div class="foot">
						<NavItem
							label="Settings"
							icon="filter"
							href={resolve('/settings')}
							current={path === '/settings'}
						/>
						{#if isAdmin}
							<NavItem
								label="Administration"
								icon="shield"
								href={resolve('/admin')}
								current={path === '/admin'}
							/>
						{/if}
					</div>
				{/snippet}
			</Sidebar>
		{/snippet}
		{#snippet top()}
			<TopBar>
				{#snippet leading()}
					<SearchField
						label="Search files, tags and contents"
						placeholder="Search files, tags and contents…"
						{shortcut}
						onopen={(typed) => search.show(typed)}
					/>
				{/snippet}
				{#if !encrypted}
					<span
						class="plain"
						data-testid="not-encrypted"
						title="Files on this server can be read by anyone with access to it or its disks"
					>
						<Icon name="lock-open" size={15} /> Not encrypted
					</span>
				{/if}
				{#if drive.canAddHere}
					<Menu
						label="Upload"
						triggerLabel="Upload"
						triggerIcon="upload"
						width={200}
						items={uploads}
						onselect={(id) => (id === 'files' ? actions.uploadFiles() : actions.uploadFolder())}
					/>
				{/if}
				<NotificationBell />
				<Menu label="Account" {items} onselect={choose} width={200}>
					{#snippet trigger(attrs)}
						<button type="button" class="me" data-testid="account-menu" {...attrs}>
							<Avatar name={displayName} size={30} />
							<span class="who">{displayName}</span>
						</button>
					{/snippet}
				</Menu>
			</TopBar>
		{/snippet}
		<RotationBar />
		{@render children()}
		{#if uploadPanel.room !== 'none'}
			<!-- Room to scroll the end of a list out from under the upload panel or its pill. -->
			<div class="under-panel" class:pill={uploadPanel.room === 'pill'}></div>
		{/if}
	</AppShell>
{/if}

<input
	bind:this={filesInput}
	type="file"
	multiple
	hidden
	data-testid="upload-input"
	onchange={picked}
/>
<input
	bind:this={folderInput}
	type="file"
	webkitdirectory
	hidden
	data-testid="upload-folder-input"
	onchange={picked}
/>

{#if dragging}
	<div class="drop" aria-hidden="true">
		<Icon name="upload" size={36} />
		<span>Drop to upload here</span>
	</div>
{/if}

<UploadPanel />
<VersionsPanel />
<DriveDialogs />
<SharingDialogs />
<SearchPalette />
<Viewer />

<style>
	.foot {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.plain {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.me {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 40px;
		padding: 0 10px 0 5px;
		border: 0;
		border-radius: 99px;
		background: transparent;
		color: var(--text-strong);
		font-weight: 500;
		cursor: pointer;
	}

	.me:hover {
		background: var(--surface-hover);
	}

	.who {
		max-width: 160px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.under-panel {
		height: min(420px, 60vh);
	}

	.under-panel.pill {
		height: 64px;
	}

	.drop {
		position: fixed;
		inset: 12px;
		z-index: 60;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		border: 2px dashed var(--accent);
		border-radius: 20px;
		background: var(--surface-selected);
		color: var(--accent-ink);
		font-size: 18px;
		font-weight: 600;
		pointer-events: none;
	}

	@media (max-width: 480px) {
		.who {
			display: none;
		}
	}
</style>
