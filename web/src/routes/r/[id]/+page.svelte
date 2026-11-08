<!-- A file request: no session, and none of the app around it. -->
<script lang="ts">
	import { page } from '$app/state';
	import { AuthCard } from '$lib/components';
	import RequestView from '$lib/sharing/ui/RequestView.svelte';
	import { session } from '$lib/state/session.svelte';

	const id = $derived(page.params.id as string);
</script>

{#if session.sealer}
	{#key id}
		<RequestView {id} sealer={session.sealer} />
	{/key}
{:else}
	<AuthCard
		title="There is nothing at this link"
		lede="This server has not been set up yet, so it takes no files."
	>
		<span></span>
	</AuthCard>
{/if}
