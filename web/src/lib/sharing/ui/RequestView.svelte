<!--
  A file request's page. The key is read out of the address and taken out of it at
  once. An address that carries a key was made for encrypted files, so a server that
  says it is not encrypting is refused here, before anything else talks to it.
-->
<script lang="ts">
	import type { Sealer } from '$lib/crypto/sealer';
	import { AuthCard } from '$lib/components';
	import { untrack } from 'svelte';
	import { modeRefusal } from '../request';
	import RequestSend from './RequestSend.svelte';

	interface Props {
		id: string;
		/** The sealer of the mode the server claims, through the mode guard. */
		sealer: Sealer;
	}

	let { id, sealer }: Props = $props();

	/** Out of the address before anything else, and into memory only. */
	const fragment = untrack(() => location.hash.slice(1));
	if (fragment !== '') history.replaceState(history.state, '', location.pathname);
	const refused = untrack(() => modeRefusal(fragment, sealer));
</script>

<svelte:window onhashchange={() => location.reload()} />
<svelte:head><title>Send files · YonDrive</title></svelte:head>

{#if refused === 'downgraded'}
	<AuthCard
		title="This request could not be opened"
		lede="This request was made for encrypted files, but the server says it is not encrypting. Nothing was sent."
	>
		<span data-testid="request-ended" data-why="downgraded"></span>
	</AuthCard>
{:else}
	<RequestSend {id} {sealer} {fragment} />
{/if}
