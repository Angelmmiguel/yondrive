<!--
  A forgotten passphrase. With keys, the recovery words open the account and it
  gets a new passphrase and a new recovery key in one step. Without keys there is
  nothing to recover: an administrator issues a reset link.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { onDestroy } from 'svelte';
	import type { LoginStep, TotpChallenge } from '$lib/account/login';
	import { openRecovery, openRecoveryInSession, type Recovery } from '$lib/account/recover';
	import { discardRecovery, newRecovery, type PendingRecovery } from '$lib/account/recovery-key';
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

	let username = $state(session.account?.user.username ?? '');
	let phrase = $state('');
	let code = $state('');
	let useRecoveryCode = $state(false);
	let passphrase = $state('');
	let confirmation = $state('');
	let confirmed = $state(false);
	let step = $state<'words' | 'passphrase' | 'recovery'>('words');
	let challenge = $state.raw<TotpChallenge<Recovery> | null>(null);
	let recovery = $state.raw<Recovery | null>(null);
	let pending = $state.raw<PendingRecovery | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const problem = $derived(passphraseProblem(passphrase, confirmation));
	/** Someone signed in through a provider already has their session: the words just open keys. */
	const inSession = $derived(
		session.status === 'locked' && session.account?.user.sign_in_method !== 'local'
	);
	const sso = $derived(session.account?.user.sign_in_method === 'sso');
	const newLabel = $derived(sso ? 'New unlock passphrase' : 'New passphrase');

	onDestroy(() => {
		challenge?.cancel();
		void recovery?.abandon();
		if (pending) discardRecovery(pending);
	});

	function follow(next: LoginStep<Recovery>) {
		if (next.status === 'totp') {
			challenge = next;
			return;
		}
		challenge = null;
		recovery = next.value;
		phrase = '';
		step = 'passphrase';
	}

	async function run(work: () => Promise<void>) {
		busy = true;
		error = null;
		try {
			await work();
		} catch (e) {
			error = failure(e);
		} finally {
			busy = false;
		}
	}

	function submitWords(event: SubmitEvent) {
		event.preventDefault();
		const sealer = session.sealer;
		if (sealer === null) return;
		void run(async () => {
			if (inSession) {
				follow({ status: 'done', value: await openRecoveryInSession({ phrase }) });
			} else {
				follow(await openRecovery({ username: username.trim(), phrase, sealer }));
			}
		});
	}

	function submitCode(event: SubmitEvent) {
		event.preventDefault();
		const open = challenge;
		if (open === null) return;
		void run(async () =>
			follow(await open.submit(useRecoveryCode ? { recoveryCode: code } : { code }))
		);
		code = '';
	}

	function toRecovery(event: SubmitEvent) {
		event.preventDefault();
		if (session.sealer === null || problem !== null) return;
		pending ??= newRecovery(session.sealer);
		step = 'recovery';
	}

	function finish() {
		const open = recovery;
		const key = pending;
		if (open === null || key === null) return;
		void run(() => open.finish({ passphrase, recoveryKey: key.key }));
	}
</script>

<svelte:head><title>Recover · YonDrive</title></svelte:head>

{#if session.sealer?.encrypted === false}
	<AuthCard
		title="Forgot your password?"
		lede="This server does not encrypt files, so there is no recovery key. An administrator can give you a reset link."
	>
		<a href={resolve('/signin')}>Back to sign in</a>
	</AuthCard>
{:else if challenge}
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
			<Button type="submit" variant="primary" {busy} disabled={code.trim() === ''}>Continue</Button>
		</form>
		<Button variant="ghost" size="sm" onclick={() => (useRecoveryCode = !useRecoveryCode)}>
			{useRecoveryCode ? 'Use a code from the app' : 'Use a recovery code'}
		</Button>
	</AuthCard>
{:else if step === 'words'}
	<AuthCard
		title="Recover your account"
		lede={inSession
			? 'Signed in as ' +
				username +
				'. Enter the 24 words of your recovery key. You will then set a new passphrase.'
			: 'Enter your username and the 24 words of your recovery key. You will then set a new passphrase.'}
		width={520}
	>
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		<form onsubmit={submitWords}>
			{#if !inSession}
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
			{/if}
			<Field label="Recovery key" hint="The 24 words, separated by spaces." required>
				{#snippet children(field)}
					<textarea
						{...field}
						bind:value={phrase}
						rows="4"
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"></textarea>
				{/snippet}
			</Field>
			<Button
				type="submit"
				variant="primary"
				{busy}
				disabled={username.trim() === '' || phrase.trim() === ''}
			>
				{busy ? 'Checking…' : 'Continue'}
			</Button>
		</form>
		<a href={resolve(inSession ? '/unlock' : '/signin')}>
			{inSession ? 'Back to unlock' : 'Back to sign in'}
		</a>
	</AuthCard>
{:else if step === 'passphrase'}
	<AuthCard
		title="Set a new passphrase"
		lede="The words were right. Your old passphrase and recovery key stop working when you finish."
	>
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		<form onsubmit={toRecovery}>
			<PassphraseFields bind:passphrase bind:confirmation label={newLabel} />
			<Button type="submit" variant="primary" disabled={problem !== null}>Continue</Button>
		</form>
	</AuthCard>
{:else if pending}
	<AuthCard
		title="Save your new recovery key"
		lede="It replaces the one you just used."
		width={640}
	>
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		<RecoveryKeyPanel {pending} {username} server={location.host} bind:confirmed />
		<Button variant="primary" {busy} disabled={!confirmed} onclick={finish}>
			{busy ? 'Finishing…' : 'Finish'}
		</Button>
	</AuthCard>
{/if}

<style>
	textarea {
		width: 100%;
		padding: 10px 12px;
		border: 1px solid var(--border-strong);
		border-radius: 10px;
		background: var(--surface);
		color: var(--text-strong);
		font-family: var(--font-mono);
		font-size: 13px;
		resize: vertical;
	}

	textarea:focus-visible {
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}
</style>
