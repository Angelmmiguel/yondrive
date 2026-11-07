<!-- The signed-in user's own settings. Each card owns its form. -->
<script lang="ts">
	import { Tabs, ThemeToggle, Card } from '$lib/components';
	import { session } from '$lib/state/session.svelte';
	import DevicesCard from './DevicesCard.svelte';
	import SignInCard from './SignInCard.svelte';
	import NameCard from './NameCard.svelte';
	import PassphraseCard from './PassphraseCard.svelte';
	import RecoveryCard from './RecoveryCard.svelte';
	import TotpCard from './TotpCard.svelte';

	const tabs = [
		{ id: 'account', label: 'Account' },
		{ id: 'devices', label: 'Devices' },
		{ id: 'appearance', label: 'Appearance' }
	];
	let tab = $state('account');
</script>

<svelte:head><title>Settings · YonDrive</title></svelte:head>

<h1>Settings</h1>
<Tabs label="Settings" {tabs} bind:value={tab}>
	{#snippet children(id)}
		<div class="panel">
			{#if id === 'account'}
				<NameCard />
				<SignInCard />
				{#if session.asksPassphrase}<PassphraseCard />{/if}
				{#if session.sealer?.encrypted}<RecoveryCard />{/if}
				{#if session.account?.user.sign_in_method !== 'sso'}<TotpCard />{/if}
			{:else if id === 'devices'}
				<DevicesCard />
			{:else}
				<Card padding="lg" as="section" label="Theme">
					<h2>Theme</h2>
					<p>A preference of this device. System follows your browser's setting.</p>
					<ThemeToggle />
				</Card>
			{/if}
		</div>
	{/snippet}
</Tabs>

<style>
	h1 {
		margin: 0 0 12px;
		font-size: 24px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
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

	.panel {
		display: flex;
		flex-direction: column;
		gap: 16px;
		max-width: 720px;
		padding-top: 20px;
	}
</style>
