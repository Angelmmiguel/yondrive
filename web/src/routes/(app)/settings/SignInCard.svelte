<!-- How this account signs in, and what follows from it. -->
<script lang="ts">
	import { Card } from '$lib/components';
	import { session } from '$lib/state/session.svelte';

	const method = $derived(session.account?.user.sign_in_method ?? 'local');
	const encrypted = $derived(session.sealer?.encrypted ?? true);
	const text = $derived.by(() => {
		if (method === 'local') return 'You sign in with your username and passphrase.';
		if (method === 'both') {
			return 'You sign in with your username and passphrase, or through your identity provider.';
		}
		return encrypted
			? 'You sign in through your identity provider, and your unlock passphrase opens your files. Your provider never sees it, and handles your second factor.'
			: 'You sign in through your identity provider, which also handles your second factor. There is no password here to change.';
	});
</script>

<Card padding="lg" as="section" label="Sign-in method">
	<h2>Sign-in method</h2>
	<p data-testid="sign-in-method" data-method={method}>{text}</p>
</Card>

<style>
	h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--text-strong);
	}

	p {
		margin: 4px 0 0;
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
