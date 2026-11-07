<!-- Inviting people. Inviting an admin asks for the passphrase. A link is shown once. -->
<script lang="ts">
	import { createInvite } from '$lib/account/security';
	import { api } from '$lib/api/client';
	import type { CreatedInvite, Invite, Role } from '$lib/api/types';
	import { failure } from '$lib/app/failure';
	import { formatDate, formatQuota, QUOTA_OPTIONS } from '$lib/app/format';
	import {
		Banner,
		Button,
		Card,
		CodeBlock,
		EmptyState,
		Field,
		PasswordField,
		Select,
		Tag,
		TextInput
	} from '$lib/components';

	const DAY = 24 * 60 * 60;
	const EXPIRY = [
		{ value: String(DAY), label: 'A day' },
		{ value: String(7 * DAY), label: 'A week' },
		{ value: String(30 * DAY), label: 'A month' }
	];
	const ROLES = [
		{ value: 'user', label: 'User' },
		{ value: 'admin', label: 'Administrator' }
	];
	const QUOTAS = [{ value: '', label: 'Server default' }, ...QUOTA_OPTIONS];

	let invites = $state<Invite[]>([]);
	let email = $state('');
	let role = $state('user');
	let quota = $state('');
	let expiry = $state(String(7 * DAY));
	let passphrase = $state('');
	let created = $state<CreatedInvite | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const needsPassphrase = $derived(role === 'admin');

	async function refresh() {
		try {
			invites = await api.listInvites();
		} catch (e) {
			error = failure(e);
		}
	}

	$effect(() => {
		void refresh();
	});

	async function create(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		try {
			created = await createInvite({
				request: {
					email: email.trim() === '' ? undefined : email.trim(),
					role: role as Role,
					quota_bytes: quota === '' ? undefined : Number(quota),
					expires_in_seconds: Number(expiry)
				},
				passphrase: needsPassphrase ? passphrase : undefined
			});
			email = passphrase = '';
			await refresh();
		} catch (e) {
			error = failure(e);
		} finally {
			busy = false;
		}
	}

	async function revoke(id: string) {
		error = null;
		try {
			await api.deleteInvite(id);
			await refresh();
		} catch (e) {
			error = failure(e);
		}
	}

	function statusOf(invite: Invite): string {
		if (invite.used) return 'Used';
		return new Date(invite.expires_at) < new Date() ? 'Expired' : 'Open';
	}
</script>

<Card padding="lg" as="section" label="New invite">
	<h2>New invite</h2>
	{#if error}<Banner tone="danger">{error}</Banner>{/if}
	<form onsubmit={create}>
		<div class="fields">
			<Field label="Email" hint="Optional. It becomes the new user's address.">
				{#snippet children(field)}<TextInput {...field} bind:value={email} type="email" />{/snippet}
			</Field>
			<Field label="Role">
				{#snippet children(field)}<Select {...field} options={ROLES} bind:value={role} />{/snippet}
			</Field>
			<Field label="Storage">
				{#snippet children(field)}<Select
						{...field}
						options={QUOTAS}
						bind:value={quota}
					/>{/snippet}
			</Field>
			<Field label="Valid for">
				{#snippet children(field)}<Select
						{...field}
						options={EXPIRY}
						bind:value={expiry}
					/>{/snippet}
			</Field>
			{#if needsPassphrase}
				<Field label="Your passphrase" hint="Needed to invite an administrator." required>
					{#snippet children(field)}
						<PasswordField {...field} bind:value={passphrase} autocomplete="current-password" />
					{/snippet}
				</Field>
			{/if}
		</div>
		<div>
			<Button
				type="submit"
				variant="primary"
				{busy}
				disabled={needsPassphrase && passphrase === ''}
			>
				{busy ? 'Creating…' : 'Create invite'}
			</Button>
		</div>
	</form>
	{#if created}
		<div class="link" data-testid="invite-link">
			<Banner tone="warn" title="Copy this link now">It works once, and is shown only now.</Banner>
			<CodeBlock code={created.link} label="invite link" />
		</div>
	{/if}
</Card>

{#if invites.length === 0}
	<EmptyState title="No invites yet" icon="shared" />
{:else}
	<ul>
		{#each invites as invite (invite.id)}
			{@const status = statusOf(invite)}
			<li>
				<span class="who">
					<span class="name">
						{invite.email ?? 'Anyone with the link'}
						{#if invite.role === 'admin'}<Tag tone="blue">Admin</Tag>{/if}
						<Tag tone={status === 'Open' ? 'ok' : 'grey'}>{status}</Tag>
					</span>
					<span class="meta">
						{invite.quota_bytes === undefined ? 'Server default' : formatQuota(invite.quota_bytes)} ·
						expires {formatDate(invite.expires_at)}
					</span>
				</span>
				{#if !invite.used}
					<Button size="sm" onclick={() => revoke(invite.id)}>Revoke</Button>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
	h2 {
		margin: 0 0 14px;
		font-size: 16px;
		font-weight: 600;
		color: var(--text-strong);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
		gap: 14px;
		align-items: start;
	}

	.link {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 16px;
	}

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
		gap: 8px 12px;
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
	}
</style>
