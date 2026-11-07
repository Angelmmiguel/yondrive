<!--
  A first sign-in through a provider, in a mode with keys. Before anything else this
  account gets its unlock passphrase and its recovery key. The provider sees neither.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { discardRecovery, newRecovery, type PendingRecovery } from '$lib/account/recovery-key';
	import { signOut } from '$lib/account/session';
	import { enrol } from '$lib/account/sso';
	import { passphraseProblem } from '$lib/account/strength';
	import { failure } from '$lib/app/failure';
	import { AuthCard, Banner, Button, PassphraseFields, RecoveryKeyPanel } from '$lib/components';
	import { session } from '$lib/state/session.svelte';

	let passphrase = $state('');
	let confirmation = $state('');
	let confirmed = $state(false);
	let step = $state<'passphrase' | 'recovery'>('passphrase');
	let pending = $state.raw<PendingRecovery | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const username = $derived(session.account?.user.username ?? '');
	const problem = $derived(passphraseProblem(passphrase, confirmation));

	onDestroy(() => {
		if (pending) discardRecovery(pending);
	});

	function toRecovery(event: SubmitEvent) {
		event.preventDefault();
		if (session.sealer === null || problem !== null) return;
		pending ??= newRecovery(session.sealer);
		step = 'recovery';
	}

	async function finish() {
		if (pending === null) return;
		busy = true;
		error = null;
		try {
			await enrol({ passphrase, recoveryKey: pending.key });
		} catch (e) {
			error = failure(e);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Protect your files · YonDrive</title></svelte:head>

{#if step === 'passphrase'}
	<AuthCard
		title="Choose an unlock passphrase"
		lede="Signed in as {username}. Your files are encrypted on this device with keys only you hold, and this passphrase opens them. Your identity provider never sees it."
		width={520}
	>
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		<form onsubmit={toRecovery}>
			<PassphraseFields bind:passphrase bind:confirmation label="Unlock passphrase" />
			<Button type="submit" variant="primary" disabled={problem !== null}>Continue</Button>
		</form>
		<Button variant="ghost" size="sm" onclick={() => signOut()}>Sign out</Button>
	</AuthCard>
{:else if pending}
	<AuthCard
		title="Save your recovery key"
		lede="If you forget your unlock passphrase, this is the only way back to your files. Nobody can reset it for you, not an administrator and not your identity provider."
		width={640}
	>
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		<RecoveryKeyPanel {pending} {username} server={location.host} bind:confirmed />
		<div class="actions">
			<Button onclick={() => (step = 'passphrase')}>Back</Button>
			<Button variant="primary" {busy} disabled={!confirmed} onclick={finish}>
				{busy ? 'Making your keys…' : 'Finish'}
			</Button>
		</div>
	</AuthCard>
{/if}

<style>
	.actions {
		display: flex;
		justify-content: space-between;
		gap: 8px;
	}
</style>
