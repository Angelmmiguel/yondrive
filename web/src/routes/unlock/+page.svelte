<!-- A signed-in session whose keys are gone: only the passphrase brings them back. -->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { signOut, unlock } from '$lib/account/session';
	import { failure } from '$lib/app/failure';
	import { AuthCard, Banner, Button, Field, PasswordField } from '$lib/components';
	import { session } from '$lib/state/session.svelte';

	let passphrase = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		try {
			await unlock(passphrase);
		} catch (e) {
			error = failure(e);
		} finally {
			passphrase = '';
			busy = false;
		}
	}
</script>

<svelte:head><title>Unlock · YonDrive</title></svelte:head>

<AuthCard
	title="Unlock"
	lede="Signed in as {session.account?.user.username}. Enter your passphrase to open your files."
>
	{#if error}<Banner tone="danger">{error}</Banner>{/if}
	<form onsubmit={submit}>
		<Field label="Passphrase" required>
			{#snippet children(field)}
				<PasswordField {...field} bind:value={passphrase} autocomplete="current-password" />
			{/snippet}
		</Field>
		<Button type="submit" variant="primary" {busy} disabled={passphrase === ''}>
			{busy ? 'Unlocking…' : 'Unlock'}
		</Button>
	</form>
	<div class="links">
		<a href={resolve('/recover')}>Forgot your passphrase?</a>
		<Button variant="ghost" size="sm" onclick={() => signOut()}>Sign out</Button>
	</div>
</AuthCard>

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
