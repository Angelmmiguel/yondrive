<!-- All that this user has shared, in one place, with one click to end any of it. -->
<script lang="ts">
	import { formatDate } from '$lib/app/format';
	import { Avatar, Button, CodeBlock, EmptyState, Tag } from '$lib/components';
	import { isApiError, type Grant, type Link } from '$lib/api/types';
	import { describeDriveError } from '$lib/drive/errors';
	import { linkStatus } from '$lib/sharing/links';
	import { drive } from '$lib/state/drive.svelte';
	import { session } from '$lib/state/session.svelte';
	import { sharing } from '$lib/state/sharing.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import { untrack } from 'svelte';

	const grants = $derived(sharing.made);
	const links = $derived(sharing.links);
	const rotating = $derived(sharing.rotation !== null);

	$effect(() => {
		const nodes = [...grants.map((g) => g.node.id), ...links.map((l) => l.node.id)];
		const ready = drive.status === 'ready';
		untrack(() => {
			if (!ready) return;
			for (const id of nodes) void drive.core?.tree.resolve(id).catch(() => {});
		});
		drive.folder = drive.rootId;
	});

	const nameOf = (id: string) => drive.node(id)?.name ?? 'Opening…';

	function explain(e: unknown): string {
		if (isApiError(e, 'unauthorized')) session.signedOut();
		sharing.warn(e);
		return describeDriveError(e);
	}

	async function revoke(grant: Grant) {
		try {
			await sharing.revoke(grant.id, grant.node_id);
			toasts.push(
				'ok',
				`${grant.grantee_username} no longer has access, and the keys are replaced.`
			);
		} catch (e) {
			toasts.push(
				'danger',
				`${explain(e)} Their access has ended. The keys are replaced the next time you unlock.`
			);
		}
	}

	async function endLink(link: Link) {
		try {
			await sharing.core?.revokeLink(link.id);
			sharing.publish();
		} catch (e) {
			toasts.push('danger', explain(e));
		}
	}

	const urlOf = (link: Link) => sharing.core?.urlOf(link) ?? '';
</script>

<svelte:head><title>Shared by me · YonDrive</title></svelte:head>

<h1>Shared by me</h1>

<section aria-label="People">
	<h2>People</h2>
	{#if grants.length === 0}
		<EmptyState title="You have not shared anything with anyone" icon="shared">
			Share a file or folder from its menu.
		</EmptyState>
	{:else}
		<ul class="list">
			{#each grants as { grant } (grant.id)}
				<li data-testid="grant">
					<Avatar name={grant.grantee_username} size={28} />
					<span class="main">
						<span class="title">{nameOf(grant.node_id)}</span>
						<span class="sub">
							{grant.grantee_username} · {grant.role === 'editor' ? 'can edit' : 'can view'} · since
							{formatDate(grant.created_at)}
						</span>
					</span>
					<Button
						size="sm"
						disabled={rotating}
						onclick={() => revoke(grant)}
						label="Revoke {grant.grantee_username} from {nameOf(grant.node_id)}"
					>
						Revoke
					</Button>
				</li>
			{/each}
		</ul>
		<p class="note">
			Revoking ends access at once and replaces the keys for what comes next. What someone has
			already opened or copied may still be with them.
		</p>
	{/if}
</section>

<section aria-label="Public links">
	<h2>Public links</h2>
	{#if links.length === 0}
		<EmptyState title="You have no public links" icon="shared">
			Make one from a file or folder's menu.
		</EmptyState>
	{:else}
		<ul class="list">
			{#each links as { link } (link.id)}
				{@const status = linkStatus(link, Date.now())}
				<li data-testid="by-me-link" data-status={status}>
					<span class="main">
						<span class="title">{nameOf(link.node_id)}</span>
						<span class="sub">
							{#if status === 'live'}<Tag tone="ok">Live</Tag>{:else if status === 'revoked'}<Tag
									tone="danger">Revoked</Tag
								>{:else if status === 'expired'}<Tag tone="grey">Expired</Tag>{:else}<Tag
									tone="grey">Downloads used up</Tag
								>{/if}
							{#if link.has_password}<Tag tone="grey">Password</Tag>{/if}
							{link.download_limit === undefined
								? `${link.download_count} downloaded`
								: `${link.download_count} of ${link.download_limit} downloaded`}
							{#if link.expires_at}· ends {formatDate(link.expires_at)}{/if}
						</span>
						{#if status === 'live'}<CodeBlock code={urlOf(link)} label="the link" />{/if}
					</span>
					{#if status === 'live'}
						<Button
							size="sm"
							onclick={() => endLink(link)}
							label="Revoke the link to {nameOf(link.node_id)}"
						>
							Revoke
						</Button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	h1 {
		margin: 0 0 18px;
		font-size: 24px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}

	h2 {
		margin: 24px 0 10px;
		font-size: 16px;
		font-weight: 600;
		color: var(--text-strong);
	}

	.list {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: 16px;
		background: var(--surface);
		overflow: hidden;
	}

	li {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 56px;
		padding: 10px 16px;
	}

	li + li {
		border-top: 1px solid var(--divider);
	}

	.main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.title {
		font-weight: 500;
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}

	.sub {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		color: var(--text-muted);
	}

	.note {
		margin: 10px 0 0;
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
