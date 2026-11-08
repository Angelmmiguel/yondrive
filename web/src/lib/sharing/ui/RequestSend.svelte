<!--
  What someone with a file request sees: a place to drop files, and nothing of where
  they go or of who asked. Once everything is sent the page says so plainly and clears
  the list, so nothing of what was sent stays on screen.
-->
<script lang="ts">
	import { formatBytes, formatDate } from '$lib/app/format';
	import { describeError } from '$lib/account/errors';
	import { api } from '$lib/api/client';
	import { isApiError } from '$lib/api/types';
	import { deriveRootInWorker } from '$lib/crypto/kdf-client';
	import type { Sealer } from '$lib/crypto/sealer';
	import {
		AuthCard,
		Banner,
		Button,
		Field,
		Icon,
		Logo,
		PasswordField,
		ProgressBar,
		TextInput
	} from '$lib/components';
	import { describeDriveError } from '$lib/drive/errors';
	import { createFramePool } from '$lib/drive/frame-pool';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { WrongLinkPasswordError } from '../public';
	import {
		MAX_FROM,
		MAX_MESSAGE,
		RequestSender,
		RequestSession,
		type RequestEnding,
		type RequestRefusal,
		type RequestRoom,
		type RequestState,
		type SendItem
	} from '../request';

	interface Props {
		id: string;
		/** The sealer of the mode the server claims, through the mode guard. */
		/** What the address carried after the #, already taken out of it. */
		fragment: string;
		sealer: Sealer;
	}

	let { id, sealer, fragment }: Props = $props();

	const ENDINGS: Record<RequestEnding, { title: string; text: string }> = {
		expired: {
			title: 'This request has ended',
			text: 'It was set to stop taking files after a certain time. Ask whoever sent it for a new one.'
		},
		revoked: {
			title: 'This request has been turned off',
			text: 'Whoever made it no longer takes files this way. Ask them for a new one.'
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
			title: 'This request could not be opened',
			text: 'The key in the address does not match what the server has. The address may be incomplete, or what is on the server may have been changed, so nothing was sent.'
		},
		'wrong-mode': {
			title: 'This request could not be opened',
			text: 'The server says it stores files differently from what this page was loaded for. Reload the page and open the link again. Nothing was sent.'
		},
		downgraded: {
			title: 'This request could not be opened',
			text: 'This request was made for encrypted files, but the server says it is not encrypting. Nothing was sent.'
		}
	};

	const REFUSALS: Record<RequestRefusal, string> = {
		'too-large': 'A file is larger than this request takes.',
		'no-files': 'This request takes no more files.',
		'no-room': 'These files are more than this request has room for.'
	};

	const LIMITS: Record<string, string> = {
		request_file_too_large: 'This file is larger than the request takes.',
		request_files_reached: 'The request takes no more files.',
		request_bytes_reached: 'The request has no room left for this file.',
		quota_exceeded: 'There is no room left for this file.',
		rate_limited: 'Too many files at once. Try again in a minute.'
	};

	let shown = $state.raw<RequestState | null>(null);
	let trouble = $state('');
	let password = $state('');
	let wrong = $state('');
	let busy = $state(false);
	let from = $state('');
	let message = $state('');
	let refused = $state('');
	let items = $state.raw<SendItem[]>([]);
	let room = $state.raw<RequestRoom | null>(null);
	let sent = $state(0);
	let dragging = $state(false);
	let picker = $state<HTMLInputElement>();

	const session = untrack(
		() =>
			new RequestSession(id, sealer.parseRequestFragment(fragment), {
				api,
				sealer,
				pool: createFramePool(sealer),
				deriveRoot: (pw, params) => deriveRootInWorker(pw, params, true),
				onended: (why) => {
					shown = { kind: 'ended', why };
					sender.stop();
					items = [];
				},
				onlocked: () => {
					shown = { kind: 'password' };
				}
			})
	);
	const sender = new RequestSender(session);
	sender.onchange = () => {
		items = sender.items;
		room = session.room;
		if (!sender.active && items.length > 0 && items.every((i) => i.status === 'sent')) {
			sent += items.length;
			sender.clear();
		}
	};

	onMount(() => void start());
	onDestroy(() => {
		sender.stop();
		session.stop();
	});

	async function start() {
		trouble = '';
		try {
			adopt(await session.open());
		} catch (e) {
			trouble = describeError(e);
		}
	}

	function adopt(next: RequestState) {
		shown = next;
		room = session.room;
	}

	async function unlock(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		wrong = '';
		try {
			adopt(await session.unlock(password));
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

	function add(files: readonly File[]) {
		if (files.length === 0) return;
		refused = '';
		const why = sender.add(files, { from, message });
		if (why !== null) refused = REFUSALS[why];
	}

	function drop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.size > 0 || f.type);
		add(files);
	}

	function picked(event: Event & { currentTarget: HTMLInputElement }) {
		add(Array.from(event.currentTarget.files ?? []));
		event.currentTarget.value = '';
	}

	const reason = (e: unknown): string => {
		for (const [code, text] of Object.entries(LIMITS)) if (isApiError(e, code)) return text;
		return describeDriveError(e);
	};

	const limits = $derived.by(() => {
		if (room === null) return [];
		const out: string[] = [];
		if (room.maxFileSize !== null) out.push(`Up to ${formatBytes(room.maxFileSize)} a file`);
		if (room.filesRemaining !== null) {
			out.push(`${room.filesRemaining} more ${room.filesRemaining === 1 ? 'file' : 'files'}`);
		}
		if (room.bytesRemaining !== null) out.push(`${formatBytes(room.bytesRemaining)} left`);
		if (room.expiresAt !== null)
			out.push(`Open until ${formatDate(new Date(room.expiresAt).toISOString())}`);
		return out;
	});
</script>

{#if shown === null && trouble === ''}
	<AuthCard title="Opening…"><ProgressBar label="Opening this request" /></AuthCard>
{:else if shown === null}
	<AuthCard title="This request could not be opened" lede={trouble}>
		<Button variant="primary" onclick={start}>Try again</Button>
	</AuthCard>
{:else if shown.kind === 'ended'}
	<AuthCard title={ENDINGS[shown.why].title} lede={ENDINGS[shown.why].text}>
		<span data-testid="request-ended" data-why={shown.why}></span>
	</AuthCard>
{:else if shown.kind === 'password'}
	<AuthCard
		title="This request has a password"
		lede="Whoever asked for the files has the password."
	>
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
		</header>
		<main class="body">
			<h1>Send files</h1>
			<p class="lede">
				Someone asked you for files. You can send them here, but not see what is already there, nor
				what you sent once it has gone.
			</p>
			{#if limits.length > 0}<p class="limits" data-testid="request-limits">
					{limits.join(' · ')}
				</p>{/if}
			{#if refused}<Banner tone="warn">{refused}</Banner>{/if}
			{#if sent > 0 && items.length === 0}
				<div data-testid="request-sent">
					<Banner tone="ok" title="Sent">
						{sent === 1 ? 'Your file was sent.' : `Your ${sent} files were sent.`} You can close this
						page, or send more.
					</Banner>
				</div>
			{/if}

			<div class="about">
				<Field label="Your name" hint="Optional. Sent with each file, sealed with it.">
					{#snippet children(field)}
						<TextInput {...field} bind:value={from} maxlength={MAX_FROM} autocomplete="name" />
					{/snippet}
				</Field>
				<label class="message">
					<span>Message</span>
					<textarea bind:value={message} maxlength={MAX_MESSAGE} rows="3"></textarea>
				</label>
			</div>

			<div
				class="drop"
				class:dragging
				role="region"
				aria-label="Drop files here"
				data-testid="request-drop"
				ondragover={(event) => {
					event.preventDefault();
					dragging = true;
				}}
				ondragleave={() => (dragging = false)}
				ondrop={drop}
			>
				<Icon name="upload" size={28} />
				<p>Drop files here, or</p>
				<Button variant="primary" onclick={() => picker?.click()}>Choose files</Button>
				<input
					bind:this={picker}
					type="file"
					multiple
					hidden
					data-testid="request-input"
					onchange={picked}
				/>
			</div>

			{#if items.length > 0}
				<ul class="list" aria-label="Files being sent">
					{#each items as item (item.id)}
						<li data-testid="request-item" data-status={item.status}>
							<span class="main">
								<span class="title">{item.name}</span>
								<span class="meta">
									{#if item.status === 'failed'}
										<span class="error">{reason(item.error)}</span>
									{:else if item.status === 'sent'}
										Sent
									{:else if item.status === 'cancelled'}
										Cancelled
									{:else}
										{formatBytes(item.done)} of {formatBytes(item.size)}
									{/if}
								</span>
								{#if item.status === 'sending' || item.status === 'queued'}
									<ProgressBar
										label="Sending {item.name}"
										value={item.done}
										max={Math.max(item.size, 1)}
									/>
								{/if}
							</span>
							{#if item.status === 'failed'}
								<Button size="sm" onclick={() => sender.retry(item.id)}>Resume</Button>
							{/if}
							{#if item.status === 'sending' || item.status === 'queued' || item.status === 'failed'}
								<Button
									size="sm"
									variant="ghost"
									onclick={() => sender.cancel(item.id)}
									label="Cancel {item.name}"
								>
									Cancel
								</Button>
							{/if}
						</li>
					{/each}
				</ul>
				{#if !sender.active}
					<Button variant="ghost" onclick={() => sender.clear()}>Clear the list</Button>
				{/if}
			{/if}

			<p class="foot">
				{sealer.encrypted
					? 'Each file is encrypted in your browser before it leaves, to a key only the person who asked can open.'
					: 'This server does not encrypt what it stores.'}
			</p>
		</main>
	</div>
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

	.body {
		width: min(720px, 100%);
		margin: 0 auto;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	h1 {
		margin: 0;
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}

	.lede,
	.limits {
		margin: 0;
		color: var(--text-soft);
	}

	.limits {
		font-size: 13px;
		color: var(--text-muted);
	}

	.about {
		display: grid;
		gap: 12px;
	}

	.message {
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 14px;
		font-weight: 500;
		color: var(--text-strong);
	}

	.message textarea {
		width: 100%;
		padding: 10px 12px;
		border: 1px solid var(--border-field);
		border-radius: 10px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
		font-weight: 400;
		resize: vertical;
	}

	.message textarea:focus-visible {
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
		outline: none;
	}

	.drop {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		padding: 32px 16px;
		border: 2px dashed var(--border);
		border-radius: 16px;
		background: var(--surface);
		color: var(--text-muted);
		text-align: center;
	}

	.drop.dragging {
		border-color: var(--accent);
	}

	.drop p {
		margin: 0;
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
		gap: 10px;
		padding: 10px 12px 10px 16px;
	}

	.list li + li {
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
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.meta {
		font-size: 13px;
		color: var(--text-soft);
	}

	.error {
		color: var(--danger);
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
