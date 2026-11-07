<!-- Setting a new password from a link an administrator issued. -->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { resetPassword } from '$lib/account/change';
	import { passphraseProblem } from '$lib/account/strength';
	import { boot } from '$lib/app/boot';
	import { failure } from '$lib/app/failure';
	import { AuthCard, Banner, Button, PassphraseFields } from '$lib/components';

	const token = page.url.hash.slice(1);
	// The link is a secret: keep it out of the history and the address bar.
	history.replaceState(null, '', location.pathname);

	let passphrase = $state('');
	let confirmation = $state('');
	let done = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const problem = $derived(passphraseProblem(passphrase, confirmation));

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (problem !== null) return;
		busy = true;
		error = null;
		try {
			await resetPassword({ token, passphrase });
			// This browser may have been signed in as that user, whose sessions just ended.
			await boot();
			done = true;
		} catch (e) {
			error = failure(e);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Set a new passphrase · YonDrive</title></svelte:head>

{#if done}
	<AuthCard
		title="Your passphrase is set"
		lede="Everywhere you were signed in has been signed out."
	>
		<Button variant="primary" href={resolve('/signin')}>Go to sign in</Button>
	</AuthCard>
{:else if token === ''}
	<AuthCard title="This link is not complete" lede="Ask your administrator for a new reset link.">
		<a href={resolve('/signin')}>Back to sign in</a>
	</AuthCard>
{:else}
	<AuthCard title="Set a new passphrase">
		{#if error}<Banner tone="danger">{error}</Banner>{/if}
		<form onsubmit={submit}>
			<PassphraseFields bind:passphrase bind:confirmation label="New passphrase" />
			<Button type="submit" variant="primary" {busy} disabled={problem !== null}>
				{busy ? 'Saving…' : 'Set passphrase'}
			</Button>
		</form>
	</AuthCard>
{/if}
