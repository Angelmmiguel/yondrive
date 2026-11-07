<!-- What the account is called, and the name that stays on this device. -->
<script lang="ts">
	import { readDisplayName, writeDisplayName } from '$lib/account/display-name';
	import { Button, Card, Field, TextInput } from '$lib/components';
	import { session } from '$lib/state/session.svelte';
	import { toasts } from '$lib/state/toasts.svelte';

	let name = $state(readDisplayName(localStorage));

	function save(event: SubmitEvent) {
		event.preventDefault();
		writeDisplayName(localStorage, name);
		toasts.push('ok', 'Saved. It shows the next time the page loads.');
	}
</script>

<Card padding="lg" as="section" label="Account">
	<h2>{session.account?.user.username}</h2>
	{#if session.account?.user.email}<p>{session.account.user.email}</p>{/if}
	<form onsubmit={save}>
		<Field label="Your name" hint="Stays on this device. It is never sent to the server.">
			{#snippet children(field)}<TextInput
					{...field}
					bind:value={name}
					autocomplete="name"
				/>{/snippet}
		</Field>
		<div><Button type="submit" size="sm">Save</Button></div>
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
		margin: 2px 0 0;
		font-size: 13px;
		color: var(--text-muted);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: 14px;
	}
</style>
