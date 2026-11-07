<!-- Signing in, with the code step when the account has two-factor on. -->
<script lang="ts">
	import { resolve } from '$app/paths';
	import type { LoginStep, TotpChallenge } from '$lib/account/login';
	import { signIn } from '$lib/account/session';
	import { failure } from '$lib/app/failure';
	import { AuthCard, Banner, Button, Field, PasswordField, TextInput } from '$lib/components';
	import { onDestroy } from 'svelte';

	let username = $state('');
	let passphrase = $state('');
	let code = $state('');
	let useRecoveryCode = $state(false);
	let challenge = $state.raw<TotpChallenge<void> | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	onDestroy(() => challenge?.cancel());

	function follow(step: LoginStep<void>) {
		challenge = step.status === 'totp' ? step : null;
		passphrase = '';
	}

	async function run(work: () => Promise<LoginStep<void>>) {
		busy = true;
		error = null;
		try {
			follow(await work());
		} catch (e) {
			error = failure(e);
		} finally {
			busy = false;
		}
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		void run(() => signIn({ username: username.trim(), passphrase }));
	}

	function submitCode(event: SubmitEvent) {
		event.preventDefault();
		const open = challenge;
		if (open === null) return;
		void run(() => open.submit(useRecoveryCode ? { recoveryCode: code } : { code }));
		code = '';
	}

	function back() {
		challenge?.cancel();
		challenge = null;
		error = null;
	}
</script>

<svelte:head><title>Sign in · YonDrive</title></svelte:head>

{#if challenge}
	<AuthCard
		title="Two-factor sign-in"
		lede={useRecoveryCode
			? 'Enter one of the recovery codes you saved. Each works once.'
			: 'Enter the 6-digit code from your authenticator app.'}
	>
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		<form onsubmit={submitCode}>
			<Field label={useRecoveryCode ? 'Recovery code' : 'Code'} required>
				{#snippet children(field)}
					<TextInput
						{...field}
						bind:value={code}
						mono
						autocomplete="one-time-code"
						inputmode={useRecoveryCode ? 'text' : 'numeric'}
					/>
				{/snippet}
			</Field>
			<Button type="submit" variant="primary" {busy} disabled={code.trim() === ''}>
				{busy ? 'Checking…' : 'Continue'}
			</Button>
		</form>
		<div class="links">
			<Button variant="ghost" size="sm" onclick={() => (useRecoveryCode = !useRecoveryCode)}>
				{useRecoveryCode ? 'Use a code from the app' : 'Use a recovery code'}
			</Button>
			<Button variant="ghost" size="sm" onclick={back}>Back</Button>
		</div>
	</AuthCard>
{:else}
	<AuthCard title="Sign in">
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
			<Field label="Passphrase" required>
				{#snippet children(field)}
					<PasswordField {...field} bind:value={passphrase} autocomplete="current-password" />
				{/snippet}
			</Field>
			<Button
				type="submit"
				variant="primary"
				{busy}
				disabled={username.trim() === '' || passphrase === ''}
			>
				{busy ? 'Signing in…' : 'Sign in'}
			</Button>
		</form>
		<div class="links">
			<a href={resolve('/recover')}>Forgot your passphrase?</a>
			<a href={resolve('/invite')}>Create an account</a>
		</div>
	</AuthCard>
{/if}

<style>
	.links {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		font-size: 13px;
	}
</style>
