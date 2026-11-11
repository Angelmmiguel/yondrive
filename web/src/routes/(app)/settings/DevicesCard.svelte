<!--
  The devices signed in to the account, each with its own token, and the ways to add
  one: a code to scan, or for a script a token to copy, whose secret is shown once.
-->
<script lang="ts">
	import { createDeviceToken } from '$lib/account/security';
	import ConfirmPassphrase from '$lib/account/ui/ConfirmPassphrase.svelte';
	import { api } from '$lib/api/client';
	import type { CreatedToken, DeviceToken } from '$lib/api/types';
	import { failure } from '$lib/app/failure';
	import { formatPlatform, formatWhen } from '$lib/app/format';
	import {
		Banner,
		Button,
		Card,
		CodeBlock,
		EmptyState,
		Field,
		Icon,
		TextInput
	} from '$lib/components';
	import { session } from '$lib/state/session.svelte';

	const ORIGINS: Record<DeviceToken['origin'], string> = {
		pairing: 'Paired',
		login: 'Signed in',
		settings: 'Token'
	};

	let tokens = $state<DeviceToken[]>([]);
	let name = $state('');
	let passphrase = $state('');
	let created = $state<CreatedToken | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let adding = $state(false);
	/** The dialog, its crypto and the code's encoder load the first time they are needed. */
	let AddDeviceDialog = $state.raw<typeof import('./AddDeviceDialog.svelte').default | null>(null);

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

	async function add() {
		error = null;
		try {
			AddDeviceDialog ??= (await import('./AddDeviceDialog.svelte')).default;
			adding = true;
		} catch (e) {
			error = failure(e);
		}
	}

	let again: ReturnType<typeof setTimeout> | undefined;
	$effect(() => () => clearTimeout(again));

	/** Once now, and once more after the device has had time for its first request. */
	function paired() {
		void refresh();
		clearTimeout(again);
		again = setTimeout(() => void refresh(), 10_000);
	}

	/** "just now", "5 min ago", "yesterday", or a date. */
	function when(iso: string): string {
		const text = formatWhen(Date.parse(iso));
		return /^(Just|Today|Yesterday)/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
	}

	function describe(token: DeviceToken): string {
		const used = token.last_used_at ? `used ${when(token.last_used_at)}` : 'not used yet';
		return `${ORIGINS[token.origin] ?? 'Token'} ${when(token.created_at)} · ${used}`;
	}

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

<Card padding="lg" as="section" label="Devices">
	<div class="head">
		<div>
			<h2>Devices</h2>
			<p>
				Phones, tablets and other apps signed in to your account. Revoke one and it is signed out at
				its next request.
			</p>
		</div>
		<Button variant="primary" icon="plus" onclick={add}>Add a device</Button>
	</div>
	{#if error}<Banner tone="danger">{error}</Banner>{/if}
	{#if tokens.length === 0}
		<EmptyState title="No devices yet" icon="phone" />
	{:else}
		<ul>
			{#each tokens as token (token.id)}
				{@const platform = formatPlatform(token.platform)}
				<li>
					<Icon
						name={token.platform === 'ios' || token.platform === 'android' ? 'phone' : 'laptop'}
					/>
					<span class="what">
						<span class="name">
							{token.name}{#if token.current}<span class="current"> · This device</span>{/if}
						</span>
						<span class="meta">{platform ? `${platform} · ` : ''}{describe(token)}</span>
					</span>
					<Button size="sm" onclick={() => revoke(token.id)}>Revoke</Button>
				</li>
			{/each}
		</ul>
	{/if}
	<details>
		<summary>Need a token for a script?</summary>
		{#if created}
			<Banner tone="warn" title="Copy this token now">It is shown only once.</Banner>
			<CodeBlock code={created.secret} label="token" />
		{/if}
		<form onsubmit={create}>
			<div class="fields">
				<Field label="Device name" required>
					{#snippet children(field)}<TextInput {...field} bind:value={name} />{/snippet}
				</Field>
				<ConfirmPassphrase
					bind:value={passphrase}
					label={session.account?.user.sign_in_method === 'sso'
						? 'Unlock passphrase'
						: 'Passphrase'}
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
	</details>
</Card>

{#if AddDeviceDialog}<AddDeviceDialog bind:open={adding} onpaired={paired} />{/if}

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

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
		align-items: center;
		gap: 12px;
		min-height: 52px;
		padding: 6px 0;
		border-bottom: 1px solid var(--divider);
		color: var(--text-muted);
	}

	.what {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}

	.name {
		font-weight: 500;
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}

	.current {
		font-weight: 400;
		color: var(--text-muted);
	}

	.meta {
		font-size: 12px;
		color: var(--text-muted);
	}

	details {
		margin-top: 14px;
	}

	summary {
		cursor: pointer;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-strong);
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
