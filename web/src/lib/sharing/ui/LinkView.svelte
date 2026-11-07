<!--
  What someone with a link sees: no app, no account, nothing of who shared it. The
  key is read out of the address and taken out of it at once, so it stays out of the
  history and off the screen. Opening a file counts against a download limit, which
  is why nothing is read until someone asks.
-->
<script lang="ts">
	import { formatBytes } from '$lib/app/format';
	import { deriveRootInWorker } from '$lib/crypto/kdf-client';
	import type { Sealer } from '$lib/crypto/sealer';
	import {
		AuthCard,
		Banner,
		Button,
		Dialog,
		FILE_KINDS,
		Field,
		Icon,
		Logo,
		PasswordField,
		ProgressBar
	} from '$lib/components';
	import { describeDriveError, TooLargeForMemoryError } from '$lib/drive/errors';
	import { createFramePool } from '$lib/drive/frame-pool';
	import { fileKindOf, inferType } from '$lib/drive/kinds';
	import { mediaType } from '$lib/drive/stream/host';
	import ViewerStage, { type ViewerSource } from '$lib/drive/ui/ViewerStage.svelte';
	import { viewerFor } from '$lib/drive/viewers/kinds';
	import { api } from '$lib/api/client';
	import { describeError } from '$lib/account/errors';
	import { isApiError } from '$lib/api/types';
	import { onDestroy, onMount, untrack } from 'svelte';
	import {
		PublicLinkSession,
		WrongLinkPasswordError,
		type LinkEnding,
		type LinkNode,
		type LinkState
	} from '../public';

	interface Props {
		id: string;
		/** The sealer of the mode the server claims, through the mode guard. */
		sealer: Sealer;
	}

	let { id, sealer }: Props = $props();

	const ENDINGS: Record<LinkEnding, { title: string; text: string }> = {
		expired: {
			title: 'This link has expired',
			text: 'It was set to stop working after a certain time. Ask whoever sent it for a new one.'
		},
		revoked: {
			title: 'This link has been turned off',
			text: 'Whoever made it has stopped sharing it this way. Ask them for a new one.'
		},
		limit: {
			title: 'This link has given all its downloads',
			text: 'It was set to allow only so many. Ask whoever sent it for a new one.'
		},
		gone: {
			title: 'There is nothing at this link',
			text: 'It may have been removed, or the address may be incomplete.'
		},
		'no-key': {
			title: 'This address is missing its key',
			text: 'The key is the part after the # in the address, and it is taken out of the address once read. Open the whole link again, as it was sent to you.'
		},
		'bad-key': {
			title: 'This link could not be opened',
			text: 'The key in the address does not fit what the server has. The address may be incomplete, or what is on the server may have been changed.'
		}
	};

	/** Out of the address before anything else, and into memory only. */
	const fragment = untrack(() => location.hash.slice(1));
	if (fragment !== '') history.replaceState(history.state, '', location.pathname);

	const link = untrack(
		() =>
			new PublicLinkSession(id, sealer.parseLinkFragment(fragment), {
				api,
				sealer,
				pool: createFramePool(sealer),
				deriveRoot: (password, params) => deriveRootInWorker(password, params, true),
				onended: (why) => {
					shown = { kind: 'ended', why };
					viewing = null;
				}
			})
	);

	let shown = $state.raw<LinkState | null>(null);
	let trouble = $state('');
	let password = $state('');
	let wrong = $state('');
	let busy = $state(false);

	/** Where someone is, from the link's own node down. */
	let trail = $state.raw<LinkNode[]>([]);
	let items = $state.raw<LinkNode[]>([]);
	let listing = $state(false);
	let viewing = $state.raw<LinkNode | null>(null);
	let saving = $state<{ id: string; done: number; total: number } | null>(null);
	let remaining = $state<number | null>(null);
	let thumbs = $state<Record<string, string>>({});

	const here = $derived(trail[trail.length - 1] ?? null);
	const top = $derived(trail[0] ?? null);

	onMount(() => void start());
	onDestroy(() => {
		link.stop();
		for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
	});

	async function start() {
		trouble = '';
		try {
			adopt(await link.open());
		} catch (e) {
			trouble = describeError(e);
		}
	}

	function adopt(next: LinkState) {
		shown = next;
		if (next.kind === 'open') {
			remaining = link.downloadsRemaining;
			trail = [next.node];
			void enter(next.node);
		}
	}

	async function unlock(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		wrong = '';
		try {
			adopt(await link.unlock(password));
			password = '';
		} catch (e) {
			if (e instanceof WrongLinkPasswordError) wrong = 'That password is not right.';
			else if (isApiError(e, 'rate_limited'))
				wrong = 'Too many tries. Wait a minute, then try again.';
			else wrong = describeError(e);
		} finally {
			busy = false;
		}
	}

	async function enter(node: LinkNode) {
		if (node.kind !== 'folder') {
			items = [];
			return;
		}
		listing = true;
		trouble = '';
		try {
			const children = await link.children(node.id);
			children.sort(
				(a, b) =>
					Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name)
			);
			items = children;
			void loadThumbs(children);
		} catch (e) {
			trouble = describeDriveError(e);
		} finally {
			listing = false;
		}
	}

	async function loadThumbs(nodes: readonly LinkNode[]) {
		for (const node of nodes) {
			if (node.thumbBlobId === null || node.id in thumbs) continue;
			const image = await link.thumbnail(node);
			if (image !== null) thumbs = { ...thumbs, [node.id]: URL.createObjectURL(image) };
		}
	}

	function open(node: LinkNode) {
		if (node.kind === 'folder') {
			trail = [...trail, node];
			void enter(node);
		} else if (viewerFor(node) !== null) {
			viewing = node;
		} else {
			void download(node);
		}
	}

	function goTo(index: number) {
		trail = trail.slice(0, index + 1);
		void enter(trail[index]);
	}

	const saveAs = (blob: Blob, name: string) => {
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = name;
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	};

	const MEMORY_LIMIT = 1024 * 1024 * 1024;

	const describe = (e: unknown): string =>
		e instanceof TooLargeForMemoryError
			? 'This file is too large to read through a link in this browser, which has to hold it in memory.'
			: describeDriveError(e);

	/** Reads the file with its token in a header, which a plain link could not send. */
	async function download(node: LinkNode) {
		saving = { id: node.id, done: 0, total: node.size };
		trouble = '';
		try {
			const version = await link.version(node.id);
			const blob = await link.read(node.id, version, {
				limit: MEMORY_LIMIT,
				onProgress: (done, total) => {
					saving = { id: node.id, done, total };
				}
			});
			saveAs(blob, node.name);
			if (remaining !== null) await link.renew().then(() => (remaining = link.downloadsRemaining));
		} catch (e) {
			trouble = describe(e);
		} finally {
			saving = null;
		}
	}

	const source = $derived.by<ViewerSource | null>(() => {
		const node = viewing;
		if (node === null) return null;
		return {
			media: async () => {
				const version = await link.version(node.id);
				const blob = await link.read(node.id, version, {
					limit: MEMORY_LIMIT,
					type: mediaType(inferType(node.name, node.type))
				});
				const url = URL.createObjectURL(blob);
				return { url, release: () => URL.revokeObjectURL(url) };
			},
			blob: async (options) => link.read(node.id, await link.version(node.id), options)
		};
	});
	const viewerKind = $derived(viewing === null ? null : viewerFor(viewing));
</script>

<svelte:window onhashchange={() => location.reload()} />
<svelte:head><title>Shared with you · YonDrive</title></svelte:head>

{#if shown === null && trouble === ''}
	<AuthCard title="Opening…"><ProgressBar label="Opening this link" /></AuthCard>
{:else if shown === null}
	<AuthCard title="This link could not be opened" lede={trouble}>
		<Button variant="primary" onclick={start}>Try again</Button>
	</AuthCard>
{:else if shown.kind === 'ended'}
	<AuthCard title={ENDINGS[shown.why].title} lede={ENDINGS[shown.why].text}>
		<span data-testid="link-ended" data-why={shown.why}></span>
	</AuthCard>
{:else if shown.kind === 'password'}
	<AuthCard title="This link has a password" lede="Whoever sent you the link has the password.">
		<form class="unlock" onsubmit={unlock}>
			<Field label="Password" error={wrong}>
				{#snippet children(field)}
					<PasswordField {...field} bind:value={password} data-autofocus autocomplete="off" />
				{/snippet}
			</Field>
			<Button variant="primary" type="submit" {busy} disabled={password === ''}>Open</Button>
		</form>
	</AuthCard>
{:else}
	<div class="page">
		<header class="bar">
			<Logo size={24} />
			<span class="brand">YonDrive</span>
			<span class="tail">
				{#if remaining !== null}
					<span class="left" data-testid="downloads-left">
						{remaining}
						{remaining === 1 ? 'download' : 'downloads'} left
					</span>
				{/if}
			</span>
		</header>
		<main class="body">
			{#if trouble}<Banner tone="danger">{trouble}</Banner>{/if}
			<nav class="crumbs" aria-label="Where you are">
				{#each trail as node, i (node.id)}
					{#if i < trail.length - 1}
						<button type="button" class="crumb" onclick={() => goTo(i)}>{node.name}</button>
						<Icon name="chevron-right" size={14} />
					{:else}
						<h1>{node.name}</h1>
					{/if}
				{/each}
			</nav>
			{#if top?.kind === 'file' && here}
				<section class="file" data-testid="link-file">
					<span
						class="badge"
						style:background={FILE_KINDS[fileKindOf(here)].soft}
						style:color={FILE_KINDS[fileKindOf(here)].ink}
					>
						<Icon name={FILE_KINDS[fileKindOf(here)].icon} size={32} />
					</span>
					<p class="size">{formatBytes(here.size)}</p>
					<div class="actions">
						{#if viewerFor(here) !== null}
							<Button onclick={() => here && (viewing = here)}>Open</Button>
						{/if}
						<Button
							variant="primary"
							icon="download"
							busy={saving?.id === here.id}
							onclick={() => here && download(here)}
						>
							Download
						</Button>
					</div>
					{#if saving?.id === here.id}
						<ProgressBar label="Downloading" value={saving.done} max={Math.max(saving.total, 1)} />
					{/if}
				</section>
			{:else}
				<ul class="list" aria-label="What is in this folder">
					{#each items as node (node.id)}
						{@const style = FILE_KINDS[fileKindOf(node)]}
						<li data-testid="link-item">
							<button
								type="button"
								class="name"
								disabled={!node.readable}
								onclick={() => open(node)}
							>
								<span class="badge small" style:background={style.soft} style:color={style.ink}>
									{#if thumbs[node.id]}
										<img src={thumbs[node.id]} alt="" />
									{:else}
										<Icon name={style.icon} size={18} />
									{/if}
								</span>
								<span class="title">{node.name}</span>
							</button>
							{#if node.kind === 'file'}
								<span class="meta">{formatBytes(node.size)}</span>
								<Button
									size="sm"
									variant="ghost"
									icon="download"
									busy={saving?.id === node.id}
									disabled={!node.readable}
									onclick={() => download(node)}
									label="Download {node.name}"
								>
									Download
								</Button>
							{/if}
						</li>
					{/each}
					{#if items.length === 0 && !listing}<li class="none">This folder is empty.</li>{/if}
				</ul>
			{/if}
			<p class="foot">
				Opened in your browser. {sealer.encrypted
					? 'The server stores this encrypted, and cannot read it.'
					: 'This server does not encrypt what it stores.'}
			</p>
		</main>
	</div>
{/if}

{#if viewing && viewerKind && source}
	<Dialog open title={viewing.name} width={1100} onclose={() => (viewing = null)}>
		<ViewerStage file={viewing} kind={viewerKind} {source} {describe} />
		{#snippet footer()}
			<Button icon="download" onclick={() => viewing && download(viewing)}>Download</Button>
		{/snippet}
	</Dialog>
{/if}

<style>
	.unlock {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.page {
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
		background: var(--surface-page);
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 24px;
		border-bottom: 1px solid var(--divider);
	}

	.brand {
		font-weight: 600;
		color: var(--text-strong);
	}

	.tail {
		margin-left: auto;
	}

	.left {
		font-size: 13px;
		color: var(--text-muted);
	}

	.body {
		width: min(860px, 100%);
		margin: 0 auto;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.crumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		color: var(--text-muted);
	}

	.crumb {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-soft);
		font-size: 14px;
		cursor: pointer;
	}

	.crumb:hover {
		color: var(--accent-ink);
	}

	h1 {
		margin: 0;
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}

	.file {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 32px 24px;
		border: 1px solid var(--border);
		border-radius: 16px;
		background: var(--surface);
	}

	.badge {
		width: 72px;
		height: 72px;
		flex: none;
		display: grid;
		place-items: center;
		border-radius: 18px;
		overflow: hidden;
	}

	.badge.small {
		width: 34px;
		height: 34px;
		border-radius: 9px;
	}

	.badge img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.size {
		margin: 0;
		color: var(--text-muted);
	}

	.actions {
		display: flex;
		gap: 8px;
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

	.list li {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 56px;
		padding: 0 12px 0 16px;
	}

	.list li + li {
		border-top: 1px solid var(--divider);
	}

	.name {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-strong);
		text-align: left;
		cursor: pointer;
	}

	.title {
		font-weight: 500;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.meta {
		font-size: 13px;
		color: var(--text-soft);
		white-space: nowrap;
	}

	.none {
		color: var(--text-muted);
	}

	.foot {
		margin: 0;
		font-size: 12px;
		color: var(--text-muted);
	}

	@media (max-width: 640px) {
		.bar,
		.body {
			padding-inline: 16px;
		}
	}
</style>
