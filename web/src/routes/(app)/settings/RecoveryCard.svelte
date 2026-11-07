<!--
  A new recovery key. The words are shown and typed back first, and the old key
  stops working only when the new one is saved, so no step here can leave someone
  with a key they never saw.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { replaceRecoveryKey } from '$lib/account/change';
	import { discardRecovery, newRecovery, type PendingRecovery } from '$lib/account/recovery-key';
	import { failure } from '$lib/app/failure';
	import { Banner, Button, Card, Field, PasswordField, RecoveryKeyPanel } from '$lib/components';
	import { session } from '$lib/state/session.svelte';
	import { toasts } from '$lib/state/toasts.svelte';

	let pending = $state.raw<PendingRecovery | null>(null);
	let confirmed = $state(false);
	let current = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	function discard() {
		if (pending) discardRecovery(pending);
		pending = null;
		confirmed = false;
		current = '';
		error = null;
	}

	onDestroy(discard);

	function start() {
		if (session.sealer) pending = newRecovery(session.sealer);
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (pending === null) return;
		busy = true;
		error = null;
		try {
			await replaceRecoveryKey({ current, recoveryKey: pending.key });
			discard();
			toasts.push('ok', 'New recovery key saved. The old one no longer works.');
		} catch (e) {
			error = failure(e);
		} finally {
			busy = false;
		}
	}
</script>

<Card padding="lg" as="section" label="Recovery key">
	<h2>Recovery key</h2>
	<p>
		The only way back in if you forget your passphrase. Make a new one if you have lost it, or if
		someone else may have seen it. The old one stops working.
	</p>
	{#if pending}
		<form onsubmit={save}>
			{#if error}<Banner tone="danger">{error}</Banner>{/if}
			<RecoveryKeyPanel
				{pending}
				username={session.account?.user.username ?? ''}
				server={location.host}
				bind:confirmed
			/>
			<Field label="Current passphrase" required>
				{#snippet children(field)}
					<PasswordField {...field} bind:value={current} autocomplete="current-password" />
				{/snippet}
			</Field>
			<div class="actions">
				<Button type="submit" variant="primary" {busy} disabled={!confirmed || current === ''}>
					{busy ? 'Saving…' : 'Replace recovery key'}
				</Button>
				<Button onclick={discard}>Cancel</Button>
			</div>
		</form>
	{:else}
		<Button onclick={start}>Make a new recovery key</Button>
	{/if}
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

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
