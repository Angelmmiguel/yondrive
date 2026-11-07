<!-- Signing in, with the code step when the account has two-factor on. -->
<script lang="ts">
	import { resolve } from '$app/paths';
	import type { LoginStep, TotpChallenge } from '$lib/account/login';
	import { signIn } from '$lib/account/session';
	import { continueWithProvider, ssoErrorMessage } from '$lib/account/sso';
	import { api } from '$lib/api/client';
	import type { AuthMethods } from '$lib/api/types';
	import { failure } from '$lib/app/failure';
	import { AuthCard, Banner, Button, Field, PasswordField, TextInput } from '$lib/components';
	import { onDestroy } from 'svelte';

	let username = $state('');
	let passphrase = $state('');
	let totp = $state('');
	let useRecoveryCode = $state(false);
	let challenge = $state.raw<TotpChallenge<void> | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let methods = $state.raw<AuthMethods | null>(null);
	/** With local accounts off the first admin can still sign in: this is their way back in. */
	let wantsLocal = $state(false);

	const showLocal = $derived(
		methods === null || methods.local_accounts || methods.oidc === undefined || wantsLocal
	);

	// A failed sign-in lands here with a code, which should not outlive this page view.
	const params = new URLSearchParams(location.search);
	const code = params.get('sso_error');
	if (code !== null) {
		error = ssoErrorMessage(code);
		history.replaceState(null, '', location.pathname);
	}

	$effect(() => {
		api
			.getAuthMethods()
			.then((found) => (methods = found))
			.catch(() => {
				// Then the form is what is left to offer.
			});
	});

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
		void run(() => open.submit(useRecoveryCode ? { recoveryCode: totp } : { code: totp }));
		totp = '';
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
						bind:value={totp}
						mono
						autocomplete="one-time-code"
						inputmode={useRecoveryCode ? 'text' : 'numeric'}
					/>
				{/snippet}
			</Field>
			<Button type="submit" variant="primary" {busy} disabled={totp.trim() === ''}>
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
		{#if methods?.oidc}
			<Button
				variant={methods.local_accounts ? 'secondary' : 'primary'}
				trailingIcon="arrow-right"
				onclick={() => continueWithProvider()}
			>
				Continue with {methods.oidc.label}
			</Button>
			{#if showLocal}<div class="or"><span>or</span></div>{/if}
		{/if}
		{#if showLocal}
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
					variant={methods?.oidc && methods.local_accounts ? 'secondary' : 'primary'}
					{busy}
					disabled={username.trim() === '' || passphrase === ''}
				>
					{busy ? 'Signing in…' : 'Sign in'}
				</Button>
			</form>
			<div class="links">
				<a href={resolve('/recover')}>Forgot your passphrase?</a>
				{#if methods === null || methods.local_accounts}
					<a href={resolve('/invite')}>Create an account</a>
				{/if}
			</div>
		{:else}
			<Button variant="ghost" size="sm" onclick={() => (wantsLocal = true)}>
				Administrator? Sign in with a passphrase
			</Button>
		{/if}
	</AuthCard>
{/if}

<style>
	.or {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.or::before,
	.or::after {
		content: '';
		flex: 1;
		border-top: 1px solid var(--divider);
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		font-size: 13px;
	}
</style>
