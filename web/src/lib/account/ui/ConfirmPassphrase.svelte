<!--
  Proving a current credential. An account with a passphrase types it. One without, a
  provider's account in a mode with no keys, shows what happens instead: a recent sign-in
  stands in, and an old one is sent to sign in again.
-->
<script lang="ts">
	import { Field, PasswordField } from '$lib/components';
	import { session } from '$lib/state/session.svelte';

	interface Props {
		value?: string;
		label?: string;
		hint?: string;
	}

	let { value = $bindable(''), label, hint }: Props = $props();

	const sso = $derived(session.account?.user.sign_in_method === 'sso');
</script>

{#if session.asksPassphrase}
	<Field label={label ?? (sso ? 'Your unlock passphrase' : 'Your passphrase')} {hint} required>
		{#snippet children(field)}
			<PasswordField {...field} bind:value autocomplete="current-password" />
		{/snippet}
	</Field>
{:else}
	<p class="note" data-testid="reauth-note">
		This needs a recent sign-in. If yours is more than five minutes old, you will be asked to sign
		in again through your provider.
	</p>
{/if}

<style>
	.note {
		margin: 0;
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
