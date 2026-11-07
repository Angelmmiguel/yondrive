<!--
  Creating an account, from an invite link or, where the server allows it, with
  none. The recovery step exists only where there are keys to recover.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onDestroy } from 'svelte';
	import { discardRecovery, newRecovery, type PendingRecovery } from '$lib/account/recovery-key';
	import { register } from '$lib/account/setup';
	import { passphraseProblem } from '$lib/account/strength';
	import { failure } from '$lib/app/failure';
	import {
		AuthCard,
		Banner,
		Button,
		Field,
		PassphraseFields,
		RecoveryKeyPanel,
		TextInput
	} from '$lib/components';
	import { session } from '$lib/state/session.svelte';

	const token = page.url.hash.slice(1) || null;
	// The link is a secret: keep it out of the history and the address bar.
	history.replaceState(null, '', location.pathname);

	let username = $state('');
	let email = $state('');
	let passphrase = $state('');
	let confirmation = $state('');
	let confirmed = $state(false);
	let step = $state<'form' | 'recovery' | 'done'>('form');
	let pending = $state.raw<PendingRecovery | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const problem = $derived(passphraseProblem(passphrase, confirmation));
	const ready = $derived(username.trim() !== '' && problem === null);

	onDestroy(() => {
		if (pending) discardRecovery(pending);
	});

	async function create() {
		const sealer = session.sealer;
		if (sealer === null) return;
		pending ??= newRecovery(sealer);
		busy = true;
		error = null;
		try {
			await register({
				inviteToken: token,
				sealer,
				user: { username: username.trim(), email, passphrase, recoveryKey: pending.key }
			});
			step = 'done';
		} catch (e) {
			error = failure(e);
			step = 'form';
		} finally {
			busy = false;
		}
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!ready) return;
		if (session.sealer?.encrypted) {
			pending ??= newRecovery(session.sealer);
			step = 'recovery';
		} else {
			void create();
		}
	}
</script>

<svelte:head><title>Create your account · YonDrive</title></svelte:head>

{#if step === 'form'}
	<AuthCard
		title="Create your account"
		lede={token ? 'You have been invited to this YonDrive server.' : undefined}
		width={480}
	>
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		<form onsubmit={submit}>
			<Field label="Username" required>
				{#snippet children(field)}
					<TextInput
						{...field}
						bind:value={username}
						autocomplete="username"
						autocapitalize="off"
						spellcheck="false"
					/>
				{/snippet}
			</Field>
			<Field label="Email" hint="Optional.">
				{#snippet children(field)}
					<TextInput {...field} bind:value={email} type="email" autocomplete="email" />
				{/snippet}
			</Field>
			<PassphraseFields bind:passphrase bind:confirmation />
			<Button type="submit" variant="primary" {busy} disabled={!ready}>
				{busy ? 'Creating…' : session.sealer?.encrypted ? 'Continue' : 'Create account'}
			</Button>
		</form>
		<a href={resolve('/signin')}>I already have an account</a>
	</AuthCard>
{:else if step === 'recovery' && pending}
	<AuthCard title="Save your recovery key" width={640}>
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		<RecoveryKeyPanel {pending} {username} server={location.host} bind:confirmed />
		<Button variant="primary" {busy} disabled={!confirmed} onclick={create}>
			{busy ? 'Creating…' : 'Create account'}
		</Button>
	</AuthCard>
{:else}
	<AuthCard title="Your account is ready" lede="Sign in as {username} to get started.">
		<Button variant="primary" href={resolve('/signin')}>Go to sign in</Button>
	</AuthCard>
{/if}
