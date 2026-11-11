<!-- Changing the passphrase. Every other session and device token ends with it. -->
<script lang="ts">
	import { changePassphrase } from '$lib/account/change';
	import { passphraseProblem } from '$lib/account/strength';
	import { failure } from '$lib/app/failure';
	import { Banner, Button, Card, Field, PassphraseFields, PasswordField } from '$lib/components';
	import { session } from '$lib/state/session.svelte';
	import { toasts } from '$lib/state/toasts.svelte';

	const sso = $derived(session.account?.user.sign_in_method === 'sso');

	let current = $state('');
	let next = $state('');
	let confirmation = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	const problem = $derived(passphraseProblem(next, confirmation));

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (problem !== null) return;
		busy = true;
		error = null;
		try {
			await changePassphrase({ current, next });
			current = next = confirmation = '';
			toasts.push(
				'ok',
				'Passphrase changed. Other devices were signed out; pair them again from Devices.'
			);
		} catch (e) {
			error = failure(e);
		} finally {
			busy = false;
		}
	}
</script>

<Card padding="lg" as="section" label="Passphrase">
	<h2>{sso ? 'Change unlock passphrase' : 'Change passphrase'}</h2>
	<p>
		{sso
			? 'It opens your files, and your identity provider never sees it. Other sessions and device tokens are signed out when it changes.'
			: 'Other sessions and device tokens are signed out when it changes.'}
	</p>
	<form onsubmit={submit}>
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		<Field label="Current passphrase" required>
			{#snippet children(field)}
				<PasswordField {...field} bind:value={current} autocomplete="current-password" />
			{/snippet}
		</Field>
		<PassphraseFields bind:passphrase={next} bind:confirmation label="New passphrase" />
		<div>
			<Button type="submit" variant="primary" {busy} disabled={current === '' || problem !== null}>
				{busy ? 'Changing…' : 'Change passphrase'}
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

	form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
</style>
