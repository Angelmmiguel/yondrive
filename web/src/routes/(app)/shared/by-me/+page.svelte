<!-- All that this user has shared, in one place, with one click to end any of it. -->
<script lang="ts">
	import { formatBytes, formatDate } from '$lib/app/format';
	import { Avatar, Button, CodeBlock, EmptyState, Tag } from '$lib/components';
	import { isApiError, type Grant, type Link } from '$lib/api/types';
	import { describeDriveError } from '$lib/drive/errors';
	import { linkStatus } from '$lib/sharing/links';
	import { ROLE_LABELS } from '$lib/sharing/roles';
	import { drive } from '$lib/state/drive.svelte';
	import { incoming } from '$lib/state/incoming.svelte';
	import { session } from '$lib/state/session.svelte';
	import { sharing } from '$lib/state/sharing.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import { untrack } from 'svelte';

	const grants = $derived(sharing.made);
	const links = $derived(sharing.links.filter(({ link }) => link.kind === 'view'));
	const requests = $derived(sharing.links.filter(({ link }) => link.kind === 'request'));
	const waiting = $derived(incoming.waiting);
	const rotating = $derived(sharing.rotation !== null);

	$effect(() => {
		const nodes = [...grants, ...links, ...requests].map((one) => one.node.id);
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

	$effect(() => {
		incoming.seen();
	});

	async function retry(id: string) {
		try {
			if (await incoming.retry(id)) toasts.push('ok', 'The file is in its folder now.');
			else toasts.push('danger', 'That file still could not be added.');
		} catch (e) {
			toasts.push('danger', explain(e));
		}
	}

	async function throwAway(id: string) {
		try {
			await incoming.remove(id);
		} catch (e) {
			toasts.push('danger', explain(e));
		}
	}

	function received(link: Link): string {
		const count = link.files_received ?? 0;
		return link.file_limit === undefined
			? `${count} received`
			: `${count} of ${link.file_limit} received`;
	}
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
							{grant.grantee_username} · {ROLE_LABELS[grant.role].toLowerCase()} · since
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

<section aria-label="File requests" id="requests">
	<h2>File requests</h2>
	{#if requests.length === 0}
		<EmptyState title="You have not asked anyone for files" icon="upload">
			Ask for files into a folder from its Share menu.
		</EmptyState>
	{:else}
		<ul class="list">
			{#each requests as { link } (link.id)}
				{@const status = linkStatus(link, Date.now())}
				<li data-testid="by-me-request" data-status={status}>
					<span class="main">
						<span class="title">{nameOf(link.node_id)}</span>
						<span class="sub">
							{#if status === 'live'}<Tag tone="ok">Live</Tag>{:else if status === 'revoked'}<Tag
									tone="danger">Revoked</Tag
								>{:else if status === 'expired'}<Tag tone="grey">Expired</Tag>{:else}<Tag
									tone="grey">All files received</Tag
								>{/if}
							{#if link.has_password}<Tag tone="grey">Password</Tag>{/if}
							{received(link)}
							{#if link.expires_at}· ends {formatDate(link.expires_at)}{/if}
						</span>
						{#if status === 'live'}<CodeBlock code={urlOf(link)} label="the request link" />{/if}
					</span>
					{#if status === 'live'}
						<Button
							size="sm"
							onclick={() => endLink(link)}
							label="Revoke the request into {nameOf(link.node_id)}"
						>
							Revoke
						</Button>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="note">
			What arrives is added to its folder each time you open YonDrive. Files sent to a request you
			revoke, or that has ended, can still be added until the purge period is over.
		</p>
	{/if}
</section>

{#if waiting.length > 0}
	<section aria-label="Files that could not be added" id="incoming">
		<h2>Files that could not be added</h2>
		<ul class="list">
			{#each waiting as { item, why } (item.id)}
				<li data-testid="incoming-item" data-why={why}>
					<span class="main">
						<span class="title">
							A file of {formatBytes(item.size)} for {nameOf(item.folder_id)}
						</span>
						<span class="sub">
							Received {formatDate(item.created_at)} ·
							{why === 'unreadable'
								? 'It does not open with the key of its request. It may be damaged, or not have been sent through your link.'
								: 'It could not be added this time.'}
						</span>
					</span>
					{#if why === 'failed'}
						<Button size="sm" onclick={() => retry(item.id)}>Try again</Button>
					{/if}
					<Button
						size="sm"
						variant="ghost"
						onclick={() => throwAway(item.id)}
						label="Delete the file of {formatBytes(item.size)}"
					>
						Delete
					</Button>
				</li>
			{/each}
		</ul>
	</section>
{/if}

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
