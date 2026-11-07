<!-- The app shell every signed-in screen sits in. -->
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
		NavSection,
		Sidebar,
		TopBar,
		type MenuItem
	} from '$lib/components';
	import { session } from '$lib/state/session.svelte';

	let { children } = $props();

	const path = $derived(page.url.pathname);
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
</script>

<AppShell>
	{#snippet rail()}
		<AppRail
			current={path.startsWith('/notes') ? 'notes' : 'drive'}
			hrefs={{ drive: resolve('/'), notes: resolve('/notes') }}
		/>
	{/snippet}
	{#snippet sidebar()}
		<Sidebar title="Drive" label="Drive">
			<NavSection title="Files">
				<NavItem label="My files" icon="folder" href={resolve('/')} current={path === '/'} />
			</NavSection>
			{#snippet footer()}
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
			{#if !encrypted}
				<span
					class="plain"
					data-testid="not-encrypted"
					title="Files on this server can be read by anyone with access to it or its disks"
				>
					<Icon name="lock-open" size={15} /> Not encrypted
				</span>
			{/if}
			<Menu label="Account" {items} onselect={choose} width={200}>
				{#snippet trigger(attrs)}
					<button type="button" class="me" {...attrs}>
						<Avatar name={displayName} size={30} />
						<span class="who">{displayName}</span>
					</button>
				{/snippet}
			</Menu>
		</TopBar>
	{/snippet}
	{@render children()}
</AppShell>

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

	@media (max-width: 480px) {
		.who {
			display: none;
		}
	}
</style>
