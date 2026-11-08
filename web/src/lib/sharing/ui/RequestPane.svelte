<!--
  Asking for files into a folder: a link anyone can drop files through, who sees
  nothing of what is there, with the limits the owner sets. What arrives waits until
  this app adopts it into the folder, which it does each time it opens.
-->
<script lang="ts">
	import { formatBytes, formatDate } from '$lib/app/format';
	import { Banner, Button, CodeBlock, Field, PasswordField, Tag, TextInput } from '$lib/components';
	import { isApiError, type Link } from '$lib/api/types';
	import { describeDriveError } from '$lib/drive/errors';
	import type { DriveNode } from '$lib/drive/tree';
	import { session } from '$lib/state/session.svelte';
	import { sharing } from '$lib/state/sharing.svelte';
	import { linkStatus, type LinkStatus } from '../links';
	import { untrack } from 'svelte';

	interface Props {
		node: DriveNode;
	}

	let { node }: Props = $props();

	const MB = 1_000_000;
	const DEFAULT_TOTAL_MB = '1024';
	const STATUS: Record<LinkStatus, { label: string; tone: 'ok' | 'danger' | 'grey' }> = {
		live: { label: 'Live', tone: 'ok' },
		revoked: { label: 'Revoked', tone: 'danger' },
		expired: { label: 'Expired', tone: 'grey' },
		'used-up': { label: 'All files received', tone: 'grey' }
	};

	let expires = $state('');
	let password = $state('');
	let maxSize = $state('');
	let files = $state('');
	// A bound by default: with none, and no quota, a request takes anything sent to it.
	let total = $state(DEFAULT_TOTAL_MB);
	let error = $state('');
	let busy = $state(false);
	let made = $state<{ id: string; url: string } | null>(null);
	// The form shows at first only where there is no request yet.
	let creating = $state(
		untrack(
			() => !sharing.links.some(({ link }) => link.node_id === node.id && link.kind === 'request')
		)
	);

	const requests = $derived(
		sharing.links
			.filter(({ link }) => link.node_id === node.id && link.kind === 'request')
			.map(({ link }) => link)
	);
	// The one just made is shown on its own above, once.
	const listed = $derived(requests.filter((link) => link.id !== made?.id));

	function explain(e: unknown): string {
		if (isApiError(e, 'unauthorized')) session.signedOut();
		sharing.warn(e);
		return describeDriveError(e);
	}

	/** A limit as typed, or undefined for none, or null for something that is not one. */
	function limitOf(typed: string, unit: number): number | undefined | null {
		if (typed.trim() === '') return undefined;
		const value = Number(typed);
		if (!Number.isFinite(value) || value <= 0) return null;
		const out = Math.round(value * unit);
		return out >= 1 ? out : null;
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		const core = sharing.core;
		if (core === null) return;
		error = '';
		const maxFileSize = limitOf(maxSize, MB);
		const bytesLimit = limitOf(total, MB);
		const fileLimit = limitOf(files, 1);
		if (maxFileSize === null || bytesLimit === null) {
			error = 'A size is a number of megabytes, more than 0.';
			return;
		}
		if (fileLimit === null || (fileLimit !== undefined && !Number.isInteger(Number(files)))) {
			error = 'A number of files is a whole number, at least 1.';
			return;
		}
		if (password !== '' && Array.from(password).length < 8) {
			error = 'A request password needs at least 8 characters.';
			return;
		}
		busy = true;
		try {
			const { link, url } = await core.createRequest(node.id, {
				expiresAt: expires === '' ? undefined : new Date(expires),
				maxFileSize,
				fileLimit,
				bytesLimit,
				password: password === '' ? undefined : password
			});
			made = { id: link.id, url };
			creating = false;
			expires = password = maxSize = files = '';
			total = DEFAULT_TOTAL_MB;
			sharing.publish();
		} catch (e) {
			error = explain(e);
		} finally {
			busy = false;
		}
	}

	async function end(link: Link) {
		try {
			await sharing.core?.revokeLink(link.id);
			sharing.publish();
		} catch (e) {
			error = explain(e);
		}
	}

	async function forget(link: Link) {
		try {
			await sharing.core?.deleteLink(link.id);
			sharing.publish();
		} catch (e) {
			error = explain(e);
		}
	}

	function received(link: Link): string {
		const count = link.files_received ?? 0;
		const files = link.file_limit === undefined ? `${count}` : `${count} of ${link.file_limit}`;
		const noun = count === 1 && link.file_limit === undefined ? 'file' : 'files';
		const moving = link.uploads_in_progress ?? 0;
		return moving > 0
			? `${files} ${noun} received, ${moving} on the way`
			: `${files} ${noun} received`;
	}

	const urlOf = (link: Link) => sharing.core?.urlOf(link) ?? '';
</script>

<div class="pane">
	{#if error}<Banner tone="danger">{error}</Banner>{/if}
	<p class="note">
		Anyone with the link can send files into {node.name}. They cannot see what is in it, not even
		what they sent. What arrives is added to the folder the next time you open YonDrive.
	</p>
	{#if made}
		<section class="made" aria-label="The new request link" data-testid="request-url">
			<strong>Request link created</strong>
			<div class="url"><CodeBlock code={made.url} label="the request link" wrap /></div>
			{#if made.url.includes('#')}
				<p class="note">
					Files sent through it are sealed to the key in the part after the #, and only you can open
					them. Your browser never sends that part to the server.
				</p>
			{/if}
		</section>
	{/if}
	{#if creating}
		<form class="form" onsubmit={create} aria-label="New request">
			<Field label="Largest file, in MB" hint="Leave empty for no limit.">
				{#snippet children(field)}
					<TextInput {...field} inputmode="decimal" bind:value={maxSize} />
				{/snippet}
			</Field>
			<Field label="Files" hint="How many, in all. Leave empty for no limit.">
				{#snippet children(field)}
					<TextInput {...field} inputmode="numeric" bind:value={files} />
				{/snippet}
			</Field>
			<Field label="Total, in MB" hint="Empty takes anything, up to your quota.">
				{#snippet children(field)}
					<TextInput {...field} inputmode="decimal" bind:value={total} />
				{/snippet}
			</Field>
			<Field label="Ends" hint="Leave empty for no end.">
				{#snippet children(field)}
					<TextInput {...field} type="datetime-local" bind:value={expires} />
				{/snippet}
			</Field>
			<div class="wide">
				<Field
					label="Request password"
					hint="Optional. Whoever sends files needs it too. Send it some other way than the link."
				>
					{#snippet children(field)}
						<PasswordField {...field} bind:value={password} autocomplete="new-password" />
					{/snippet}
				</Field>
			</div>
			<div class="wide buttons">
				{#if requests.length > 0 || made}
					<Button variant="ghost" onclick={() => (creating = false)}>Cancel</Button>
				{/if}
				<Button variant="primary" type="submit" {busy}>Create request link</Button>
			</div>
		</form>
	{:else}
		<div>
			<Button icon="plus" onclick={() => ((creating = true), (made = null))}>New request</Button>
		</div>
	{/if}
	{#if listed.length > 0}
		<ul class="links" aria-label="File requests">
			{#each listed as link (link.id)}
				{@const status = linkStatus(link, Date.now())}
				<li data-testid="request">
					<div class="line">
						<Tag tone={STATUS[status].tone}>{STATUS[status].label}</Tag>
						{#if link.has_password}<Tag tone="grey">Password</Tag>{/if}
						<span class="details">
							{received(link)}
							{#if link.max_file_size}· up to {formatBytes(link.max_file_size)} each{/if}
							{#if link.bytes_limit}· {formatBytes(link.bytes_limit)} in all{/if}
							{#if link.expires_at}· ends {formatDate(link.expires_at)}{/if}
						</span>
					</div>
					{#if status === 'live'}
						<div class="url"><CodeBlock code={urlOf(link)} label="the request link" wrap /></div>
					{/if}
					<div class="line">
						{#if status === 'live'}
							<Button size="sm" onclick={() => end(link)}>Revoke request</Button>
						{:else}
							<Button size="sm" variant="ghost" onclick={() => forget(link)}>
								Remove from this list
							</Button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.pane {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding-top: 14px;
	}

	.note {
		margin: 0;
		font-size: 13px;
		color: var(--text-muted);
	}

	.form {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	.wide {
		grid-column: 1 / -1;
	}

	.links {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.links li {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 12px;
		min-width: 0;
	}

	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.made {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--ok);
		border-radius: 12px;
		background: var(--ok-soft);
		color: var(--ok-ink);
	}

	.url {
		width: 100%;
		min-width: 0;
	}

	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.details {
		font-size: 13px;
		color: var(--text-muted);
	}

	@media (max-width: 480px) {
		.form {
			grid-template-columns: 1fr;
		}
	}
</style>
