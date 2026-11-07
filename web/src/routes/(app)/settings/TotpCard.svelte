<!-- Two-factor sign-in: enrolling, with the secret to type by hand, and turning it off. -->
<script lang="ts">
	import { confirmTotp, disableTotp, enrolTotp } from '$lib/account/security';
	import type { TotpEnrolment } from '$lib/api/types';
	import { failure } from '$lib/app/failure';
	import {
		Banner,
		Button,
		Card,
		CodeBlock,
		Field,
		PasswordField,
		Tag,
		TextInput
	} from '$lib/components';
	import { session } from '$lib/state/session.svelte';
	import { toasts } from '$lib/state/toasts.svelte';

	let passphrase = $state('');
	let code = $state('');
	let enrolment = $state<TotpEnrolment | null>(null);
	let recoveryCodes = $state<string[] | null>(null);
	let useRecoveryCode = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const enabled = $derived(session.account?.user.totp_enabled ?? false);

	async function run(work: () => Promise<void>) {
		busy = true;
		error = null;
		try {
			await work();
			passphrase = '';
			code = '';
		} catch (e) {
			error = failure(e);
		} finally {
			busy = false;
		}
	}

	function enrol(event: SubmitEvent) {
		event.preventDefault();
		void run(async () => {
			enrolment = await enrolTotp(passphrase);
		});
	}

	function confirm(event: SubmitEvent) {
		event.preventDefault();
		void run(async () => {
			recoveryCodes = (await confirmTotp(code)).recovery_codes;
			enrolment = null;
			session.wantsTotp = false;
		});
	}

	function disable(event: SubmitEvent) {
		event.preventDefault();
		void run(async () => {
			await disableTotp({
				passphrase,
				factor: useRecoveryCode ? { recoveryCode: code } : { code }
			});
			useRecoveryCode = false;
			recoveryCodes = null;
			toasts.push('ok', 'Two-factor sign-in is off.');
		});
	}
</script>

<Card padding="lg" as="section" label="Two-factor sign-in">
	<div class="title">
		<h2>Two-factor sign-in</h2>
		<Tag tone={enabled ? 'ok' : 'neutral'}>{enabled ? 'On' : 'Off'}</Tag>
	</div>
	<p>A code from an authenticator app when signing in. It protects sign-in and decrypts nothing.</p>
	{#if session.wantsTotp && !enabled && !enrolment}
		<Banner tone="info">You asked to set this up during setup. Start below.</Banner>
	{/if}
	{#if error}<Banner tone="danger">{error}</Banner>{/if}

	{#if recoveryCodes}
		<Banner tone="warn" title="Save these recovery codes">
			Each works once, in place of a code, if you lose your authenticator. They are shown only now.
		</Banner>
		<CodeBlock code={recoveryCodes.join('\n')} label="recovery codes" />
		<div><Button onclick={() => (recoveryCodes = null)}>I saved them</Button></div>
	{:else if enrolment}
		<form onsubmit={confirm}>
			<Field label="Secret" hint="Type this into your authenticator app by hand.">
				<CodeBlock code={enrolment?.secret ?? ''} variant="key" label="secret" />
			</Field>
			<Field label="Address" hint="Or paste this otpauth address into an app that takes one.">
				<CodeBlock code={enrolment?.uri ?? ''} label="address" />
			</Field>
			<Field label="Code from the app" required>
				{#snippet children(field)}
					<TextInput
						{...field}
						bind:value={code}
						mono
						inputmode="numeric"
						autocomplete="one-time-code"
					/>
				{/snippet}
			</Field>
			<div class="actions">
				<Button type="submit" variant="primary" {busy} disabled={code.trim() === ''}>
					Turn on
				</Button>
				<Button onclick={() => (enrolment = null)}>Cancel</Button>
			</div>
		</form>
	{:else if enabled}
		<form onsubmit={disable}>
			<Field label="Passphrase" required>
				{#snippet children(field)}
					<PasswordField {...field} bind:value={passphrase} autocomplete="current-password" />
				{/snippet}
			</Field>
			<Field label={useRecoveryCode ? 'Recovery code' : 'Code from the app'} required>
				{#snippet children(field)}
					<TextInput {...field} bind:value={code} mono autocomplete="one-time-code" />
				{/snippet}
			</Field>
			<div class="actions">
				<Button type="submit" {busy} disabled={passphrase === '' || code.trim() === ''}>
					{busy ? 'Turning off…' : 'Turn off'}
				</Button>
				<Button variant="ghost" onclick={() => (useRecoveryCode = !useRecoveryCode)}>
					{useRecoveryCode ? 'Use a code from the app' : 'Use a recovery code'}
				</Button>
			</div>
		</form>
	{:else}
		<form onsubmit={enrol}>
			<Field label="Passphrase" hint="Needed to change how you sign in." required>
				{#snippet children(field)}
					<PasswordField {...field} bind:value={passphrase} autocomplete="current-password" />
				{/snippet}
			</Field>
			<div>
				<Button type="submit" variant="primary" {busy} disabled={passphrase === ''}>
					{busy ? 'Checking…' : 'Set up'}
				</Button>
			</div>
		</form>
	{/if}
</Card>

<style>
	.title {
		display: flex;
		align-items: center;
		gap: 10px;
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

	form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
