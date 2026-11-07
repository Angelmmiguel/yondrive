<!-- Bearer tokens for other devices. A secret is shown once, when it is made. -->
<script lang="ts">
	import { createDeviceToken } from '$lib/account/security';
	import ConfirmPassphrase from '$lib/account/ui/ConfirmPassphrase.svelte';
	import { api } from '$lib/api/client';
	import type { CreatedToken, DeviceToken } from '$lib/api/types';
	import { failure } from '$lib/app/failure';
	import { formatDate } from '$lib/app/format';
	import { Banner, Button, Card, CodeBlock, EmptyState, Field, TextInput } from '$lib/components';
	import { session } from '$lib/state/session.svelte';

	let tokens = $state<DeviceToken[]>([]);
	let name = $state('');
	let passphrase = $state('');
	let created = $state<CreatedToken | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function refresh() {
		try {
			tokens = await api.listTokens();
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
			created = await createDeviceToken({ name: name.trim(), passphrase });
			name = passphrase = '';
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
			await api.revokeToken(id);
			await refresh();
		} catch (e) {
			error = failure(e);
		}
	}
</script>

<Card padding="lg" as="section" label="Device tokens">
	<h2>Device tokens</h2>
	<p>For native apps and other devices. Each can be revoked on its own.</p>
	{#if error}<Banner tone="danger">{error}</Banner>{/if}
	{#if created}
		<Banner tone="warn" title="Copy this token now">It is shown only once.</Banner>
		<CodeBlock code={created.secret} label="token" />
	{/if}
	{#if tokens.length === 0}
		<EmptyState title="No device tokens" icon="shield" />
	{:else}
		<ul>
			{#each tokens as token (token.id)}
				<li>
					<span class="name">{token.name}</span>
					<span class="meta">
						Created {formatDate(token.created_at)}{token.last_used_at
							? ` · used ${formatDate(token.last_used_at)}`
							: ''}
					</span>
					<Button size="sm" onclick={() => revoke(token.id)}>Revoke</Button>
				</li>
			{/each}
		</ul>
	{/if}
	<form onsubmit={create}>
		<div class="fields">
			<Field label="Device name" required>
				{#snippet children(field)}<TextInput {...field} bind:value={name} />{/snippet}
			</Field>
			<ConfirmPassphrase
				bind:value={passphrase}
				label={session.account?.user.sign_in_method === 'sso' ? 'Unlock passphrase' : 'Passphrase'}
			/>
		</div>
		<div>
			<Button
				type="submit"
				{busy}
				disabled={name.trim() === '' || (session.asksPassphrase && passphrase === '')}
			>
				{busy ? 'Creating…' : 'Create token'}
			</Button>
		</div>
	</form>
</Card>

<style>
	h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--text-strong);
	}

	p {
		margin: 4px 0 14px;
		font-size: 13px;
		color: var(--text-muted);
	}

	ul {
		display: flex;
		flex-direction: column;
		margin: 14px 0;
		padding: 0;
		list-style: none;
	}

	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		min-height: 52px;
		padding: 6px 0;
		border-bottom: 1px solid var(--divider);
	}

	.name {
		font-weight: 500;
		color: var(--text-strong);
	}

	.meta {
		flex: 1;
		font-size: 12px;
		color: var(--text-muted);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 14px;
		margin-top: 14px;
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
		gap: 14px;
		align-items: start;
	}
</style>
