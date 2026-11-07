<!-- Server administration. Each tab owns its data. -->
<script lang="ts">
	import { Tabs } from '$lib/components';
	import Invites from './Invites.svelte';
	import ServerSettings from './ServerSettings.svelte';
	import Users from './Users.svelte';

	const tabs = [
		{ id: 'users', label: 'Users' },
		{ id: 'invites', label: 'Invites' },
		{ id: 'settings', label: 'Server' }
	];
	let tab = $state('users');
</script>

<svelte:head><title>Administration · YonDrive</title></svelte:head>

<h1>Administration</h1>
<Tabs label="Administration" {tabs} bind:value={tab}>
	{#snippet children(id)}
		<div class="panel">
			{#if id === 'users'}<Users />{:else if id === 'invites'}<Invites />{:else}<ServerSettings
				/>{/if}
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

	.panel {
		display: flex;
		flex-direction: column;
		gap: 16px;
		max-width: 860px;
		padding-top: 20px;
	}
</style>
