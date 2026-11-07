<!--
  Everyone on the server: disable, delete, quota and, where no key depends on the
  password, a reset link. Someone from a provider can have that identity forgotten, so
  that their next sign-in links again. All but quota and disabling ask for the
  administrator's passphrase.
-->
<script lang="ts">
	import {
		createPasswordResetLink,
		deleteUserAccount,
		unlinkUserIdentity
	} from '$lib/account/security';
	import ConfirmPassphrase from '$lib/account/ui/ConfirmPassphrase.svelte';
	import { api } from '$lib/api/client';
	import type { CreatedPasswordReset, Profile } from '$lib/api/types';
	import { failure } from '$lib/app/failure';
	import { formatDate, formatQuota, QUOTA_OPTIONS } from '$lib/app/format';
	import { Avatar, Banner, Button, CodeBlock, Dialog, Field, Select, Tag } from '$lib/components';
	import { session } from '$lib/state/session.svelte';

	let users = $state<Profile[]>([]);
	let error = $state<string | null>(null);

	let quotaFor = $state<Profile | null>(null);
	let quotaValue = $state('0');
	let deleting = $state<Profile | null>(null);
	let resetFor = $state<Profile | null>(null);
	let unlinking = $state<Profile | null>(null);
	let passphrase = $state('');
	let resetLink = $state<CreatedPasswordReset | null>(null);
	let busy = $state(false);
	let dialogError = $state<string | null>(null);

	const self = $derived(session.account?.user.id);
	const canReset = $derived(session.sealer?.encrypted === false);
	const unready = $derived(session.asksPassphrase && passphrase === '');
	const quotaOptions = $derived.by(() => {
		const current = String(quotaFor?.quota_bytes ?? 0);
		return QUOTA_OPTIONS.some((o) => o.value === current)
			? QUOTA_OPTIONS
			: [...QUOTA_OPTIONS, { value: current, label: formatQuota(Number(current)) }];
	});

	async function refresh() {
		try {
			users = await api.listUsers();
		} catch (e) {
			error = failure(e);
		}
	}

	$effect(() => {
		void refresh();
	});

	async function setDisabled(user: Profile, disabled: boolean) {
		error = null;
		try {
			await api.updateUser(user.id, { disabled });
			await refresh();
		} catch (e) {
			error = failure(e);
		}
	}

	function openQuota(user: Profile) {
		quotaFor = user;
		quotaValue = String(user.quota_bytes);
		dialogError = null;
	}

	async function act(work: () => Promise<void>) {
		busy = true;
		dialogError = null;
		try {
			await work();
			await refresh();
		} catch (e) {
			dialogError = failure(e);
		} finally {
			busy = false;
		}
	}

	const saveQuota = () =>
		act(async () => {
			if (quotaFor) await api.updateUser(quotaFor.id, { quota_bytes: Number(quotaValue) });
			quotaFor = null;
		});

	function confirmDelete(event: SubmitEvent) {
		event.preventDefault();
		void act(async () => {
			if (deleting) await deleteUserAccount({ userId: deleting.id, passphrase });
			closeDelete();
		});
	}

	function closeDelete() {
		deleting = null;
		passphrase = '';
		dialogError = null;
	}

	function issueReset(event: SubmitEvent) {
		event.preventDefault();
		void act(async () => {
			if (resetFor) resetLink = await createPasswordResetLink({ userId: resetFor.id, passphrase });
			passphrase = '';
		});
	}

	function confirmUnlink(event: SubmitEvent) {
		event.preventDefault();
		void act(async () => {
			if (unlinking) await unlinkUserIdentity({ userId: unlinking.id, passphrase });
			closeUnlink();
		});
	}

	function closeUnlink() {
		unlinking = null;
		passphrase = '';
		dialogError = null;
	}

	function closeReset() {
		resetFor = null;
		resetLink = null;
		passphrase = '';
		dialogError = null;
	}
</script>

{#if error}<Banner tone="danger">{error}</Banner>{/if}
<ul data-testid="users">
	{#each users as user (user.id)}
		<li>
			<Avatar name={user.username} size={34} />
			<span class="who">
				<span class="name">
					{user.username}
					{#if user.role === 'admin'}<Tag tone="blue">Admin</Tag>{/if}
					{#if user.disabled}<Tag tone="danger">Disabled</Tag>{/if}
					{#if user.sign_in_method === 'sso'}<Tag tone="green">Single sign-on</Tag>{/if}
					{#if user.sign_in_method === 'both'}<Tag tone="green">Local + SSO</Tag>{/if}
				</span>
				<span class="meta">
					{user.email ? `${user.email} · ` : ''}{formatQuota(user.quota_bytes)} · joined {formatDate(
						user.created_at
					)}
				</span>
			</span>
			<span class="actions">
				<Button size="sm" onclick={() => openQuota(user)}>Quota</Button>
				{#if canReset && user.sign_in_method !== 'sso'}
					<Button size="sm" onclick={() => (resetFor = user)}>Reset password</Button>
				{/if}
				{#if user.sign_in_method === 'sso' || user.sign_in_method === 'both'}
					<Button size="sm" disabled={user.id === self} onclick={() => (unlinking = user)}>
						Unlink identity
					</Button>
				{/if}
				<Button
					size="sm"
					disabled={user.id === self}
					onclick={() => setDisabled(user, !user.disabled)}
				>
					{user.disabled ? 'Enable' : 'Disable'}
				</Button>
				<Button size="sm" disabled={user.id === self} onclick={() => (deleting = user)}
					>Delete</Button
				>
			</span>
		</li>
	{/each}
</ul>

<Dialog
	open={quotaFor !== null}
	title="Storage for {quotaFor?.username}"
	onclose={() => (quotaFor = null)}
>
	{#if dialogError}<Banner tone="danger">{dialogError}</Banner>{/if}
	<Field label="Quota">
		{#snippet children(field)}
			<Select {...field} options={quotaOptions} bind:value={quotaValue} />
		{/snippet}
	</Field>
	{#snippet footer()}
		<Button onclick={() => (quotaFor = null)}>Cancel</Button>
		<Button variant="primary" {busy} onclick={saveQuota}>Save</Button>
	{/snippet}
</Dialog>

<Dialog
	open={deleting !== null}
	title="Delete {deleting?.username}?"
	description="Their account and files go for good, at once. This cannot be undone."
	onclose={closeDelete}
>
	{#if dialogError}<Banner tone="danger">{dialogError}</Banner>{/if}
	<form id="delete-form" onsubmit={confirmDelete}>
		<ConfirmPassphrase bind:value={passphrase} hint="Confirms it is you deleting this account." />
	</form>
	{#snippet footer()}
		<Button onclick={closeDelete}>Cancel</Button>
		<Button type="submit" form="delete-form" variant="primary" {busy} disabled={unready}>
			{busy ? 'Checking…' : 'Delete'}
		</Button>
	{/snippet}
</Dialog>

<Dialog
	open={unlinking !== null}
	title="Unlink {unlinking?.username}’s identity?"
	description="Their sessions and tokens end, and the next sign-in through the provider links this account again under the match mode. Use this after changing provider."
	onclose={closeUnlink}
>
	{#if dialogError}<Banner tone="danger">{dialogError}</Banner>{/if}
	<form id="unlink-form" onsubmit={confirmUnlink}>
		<ConfirmPassphrase bind:value={passphrase} hint="Confirms it is you doing this." />
	</form>
	{#snippet footer()}
		<Button onclick={closeUnlink}>Cancel</Button>
		<Button type="submit" form="unlink-form" variant="primary" {busy} disabled={unready}>
			{busy ? 'Checking…' : 'Unlink'}
		</Button>
	{/snippet}
</Dialog>

<Dialog
	open={resetFor !== null}
	title="Reset password for {resetFor?.username}"
	onclose={closeReset}
>
	{#if dialogError}<Banner tone="danger">{dialogError}</Banner>{/if}
	{#if resetLink}
		<p>Send this link to them. It works once, for a day, and is shown only now.</p>
		<CodeBlock code={resetLink.link} label="reset link" />
	{:else}
		<form id="reset-form" onsubmit={issueReset}>
			<ConfirmPassphrase bind:value={passphrase} hint="Confirms it is you issuing this." />
		</form>
	{/if}
	{#snippet footer()}
		{#if resetLink}
			<Button variant="primary" onclick={closeReset}>Done</Button>
		{:else}
			<Button onclick={closeReset}>Cancel</Button>
			<Button type="submit" form="reset-form" variant="primary" {busy} disabled={unready}>
				{busy ? 'Checking…' : 'Issue link'}
			</Button>
		{/if}
	{/snippet}
</Dialog>

<style>
	ul {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 12px;
		padding: 12px 0;
		border-bottom: 1px solid var(--divider);
	}

	.who {
		flex: 1 1 220px;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		font-weight: 500;
		color: var(--text-strong);
	}

	.meta {
		font-size: 12px;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	p {
		margin: 0 0 12px;
		color: var(--text-soft);
	}
</style>
