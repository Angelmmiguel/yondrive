<!-- A public link: no session, and none of the app around it. -->
<script lang="ts">
	import { page } from '$app/state';
	import { AuthCard } from '$lib/components';
	import LinkView from '$lib/sharing/ui/LinkView.svelte';
	import { session } from '$lib/state/session.svelte';

	const id = $derived(page.params.id as string);
</script>

{#if session.sealer}
	{#key id}
		<LinkView {id} sealer={session.sealer} />
	{/key}
{:else}
	<AuthCard
		title="There is nothing at this link"
		lede="This server has not been set up yet, so it has nothing to share."
	>
		<span></span>
	</AuthCard>
{/if}
