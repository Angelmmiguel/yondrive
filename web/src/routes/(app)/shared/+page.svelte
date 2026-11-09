<!--
  What others have shared with this user. Only what verifies opens: the signature on
  a grant has to check out against its granter's pinned key, and the granter has to
  own the node. The rest shows as what it is, with no name, as it was never opened.
-->
<script lang="ts">
	import { formatWhen } from '$lib/app/format';
	import { Avatar, Banner, Button, Tag } from '$lib/components';
	import FileBrowser from '$lib/drive/ui/FileBrowser.svelte';
	import type { DriveNode } from '$lib/drive/tree';
	import { ROLE_LABELS } from '$lib/sharing/roles';
	import { drive } from '$lib/state/drive.svelte';
	import { session } from '$lib/state/session.svelte';
	import { sharing } from '$lib/state/sharing.svelte';
	import { untrack } from 'svelte';

	const encrypted = $derived(session.sealer?.encrypted ?? true);
	const trusted = $derived(sharing.shared.filter((entry) => entry.trust === 'verified'));
	const untrusted = $derived(sharing.shared.filter((entry) => entry.trust !== 'verified'));

	$effect(() => {
		const entries = trusted;
		const ready = drive.status === 'ready';
		untrack(() => {
			if (!ready) return;
			for (const entry of entries) void drive.core?.tree.resolve(entry.node.id).catch(() => {});
		});
	});

	const nodes = $derived(
		trusted.flatMap((entry) => {
			const node = drive.node(entry.node.id);
			return node === undefined ? [] : [node as DriveNode];
		})
	);

	$effect(() => {
		drive.folder = drive.rootId;
		if (sharing.sharedLoaded) void sharing.markAllRead();
	});

	const reasons = {
		'not-owner': 'The person it says it comes from does not own what it opens.',
		'bad-signature': 'Its signature does not check out against the keys this device has for them.',
		'keys-changed': 'The keys or the account this device knows for them have changed.'
	} as const;
</script>

<svelte:head><title>Shared with me · YonDrive</title></svelte:head>

{#each untrusted as entry (entry.grant.id)}
	<div class="warning" data-testid="unverified-share">
		<Banner tone="danger" title="A share from {entry.grant.granter_username} could not be verified">
			{entry.trust === 'verified' ? '' : reasons[entry.trust]} It has not been opened, and nothing can
			be added to it. A server cannot sign in someone's name, so this may mean the server, or someone
			with access to it, made this up.
			{#snippet actions()}
				{#if entry.changed}
					<Button size="sm" onclick={() => (sharing.changed = entry.changed ?? null)}>Review</Button
					>
				{/if}
			{/snippet}
		</Banner>
	</div>
{/each}

<FileBrowser
	{nodes}
	label="Shared with me"
	emptyTitle="Nothing is shared with you yet"
	emptyIcon="shared"
	loading={!sharing.sharedLoaded}
>
	{#snippet header()}
		<div class="head">
			<h1>Shared with me</h1>
			{#if !encrypted}<Tag tone="grey">Not encrypted</Tag>{/if}
		</div>
	{/snippet}
	{#snippet empty()}When someone shares a file or folder with you, it shows up here.{/snippet}
</FileBrowser>

{#if trusted.length > 0}
	<ul class="from" aria-label="Who shared these">
		{#each trusted as entry (entry.grant.id)}
			<li data-testid="share-from">
				<Avatar name={entry.grant.granter_username} size={24} />
				<span class="who">{entry.grant.granter_username}</span>
				<span class="what">
					shared {drive.node(entry.node.id)?.name ?? 'something'} · you {ROLE_LABELS[
						entry.grant.role
					].toLowerCase()} ·
					{formatWhen(Date.parse(entry.grant.created_at))}
				</span>
				{#if encrypted}
					<Button
						size="sm"
						variant="ghost"
						onclick={() =>
							(sharing.comparing = {
								userId: entry.grant.granter_id,
								username: entry.grant.granter_username
							})}
					>
						Safety number
					</Button>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
	.warning {
		margin-bottom: 14px;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	h1 {
		margin: 0;
		font-size: 24px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}

	.from {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 18px 0 0;
		padding: 0;
		list-style: none;
	}

	.from li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		min-height: 36px;
		font-size: 13px;
		color: var(--text-soft);
	}

	.who {
		font-weight: 500;
		color: var(--text-strong);
	}

	.what {
		min-width: 0;
		overflow-wrap: anywhere;
	}
</style>
