<!--
  Decides what may be drawn: the alert that blocks a refused mode, what to do with
  a server that does not answer, or the page, once the session belongs on it.
-->
<script lang="ts">
	import '$lib/styles/app.css';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { followOtherTabs } from '$lib/account/session';
	import { takeReturn } from '$lib/account/sso';
	import { boot } from '$lib/app/boot';
	import { destinationFor } from '$lib/app/routing';
	import { AuthCard, Banner, Button, ModeAlert, Toast, ToastStack } from '$lib/components';
	import { session } from '$lib/state/session.svelte';
	import { toasts } from '$lib/state/toasts.svelte';

	let { children } = $props();

	const target = $derived(
		destinationFor({
			status: session.status,
			path: page.url.pathname,
			role: session.account?.user.role,
			wantsTotp: session.wantsTotp
		})
	);

	$effect(() => {
		if (target !== null && session.refusal === null)
			void goto(resolve(target), { replaceState: true });
	});

	$effect(() => followOtherTabs());

	// Back from signing in again for an action: to where it was, to do it again.
	$effect(() => {
		if (session.status !== 'unlocked') return;
		const path = takeReturn();
		if (path === null) return;
		toasts.push('info', 'You signed in again. Try that within the next five minutes.');
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- kept from this app's own location
		void goto(path, { replaceState: true });
	});

	const insecure = !window.isSecureContext;
	let retrying = $state(false);

	async function retry() {
		retrying = true;
		await boot();
		retrying = false;
	}
</script>

<div class="root">
	{#if insecure}
		<div class="insecure">
			<Banner tone="warn" title="This connection is not secure" icon="warn">
				Anyone on the network between you and this server can see or change what is sent. Use HTTPS,
				through a reverse proxy, for anything beyond a network you trust.
			</Banner>
		</div>
	{/if}
	{#if session.refusal !== null}
		<ModeAlert reason={session.refusal} />
	{:else if session.status === 'offline'}
		<AuthCard title="The server is not answering" lede="YonDrive could not reach its server.">
			<Button variant="primary" busy={retrying} onclick={retry}>Try again</Button>
		</AuthCard>
	{:else if target === null && session.status !== 'booting'}
		{@render children()}
	{/if}
</div>

<ToastStack>
	{#each toasts.items as toast (toast.id)}
		<Toast tone={toast.tone} ondismiss={() => toasts.dismiss(toast.id)}>{toast.message}</Toast>
	{/each}
</ToastStack>

<style>
	.root {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
	}

	.insecure {
		padding: 8px;
		background: var(--surface-page);
	}
</style>
