<!--
  Adding a device by code: the passphrase once, a code for the phone to scan, the six
  digits both screens show, and the confirmation. Closing it at any step ends the
  pairing and forgets what the flow held.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import ConfirmPassphrase from '$lib/account/ui/ConfirmPassphrase.svelte';
	import type { DeviceToken } from '$lib/api/types';
	import { formatPlatform } from '$lib/app/format';
	import { Banner, Button, copyText, Dialog } from '$lib/components';
	import QrCode from '$lib/components/QrCode.svelte';
	import { PairingFlow } from '$lib/state/pairing.svelte';
	import { session } from '$lib/state/session.svelte';

	interface Props {
		open?: boolean;
		/** A device has its token. */
		onpaired?: (token: DeviceToken) => void;
	}

	let { open = $bindable(false), onpaired }: Props = $props();

	let flow = $state<PairingFlow | null>(null);
	let passphrase = $state('');
	let copied = $state(false);
	let body = $state<HTMLElement>();

	$effect(() => {
		if (!open) return;
		const current = new PairingFlow();
		flow = current;
		return () => {
			if (current.step === 'scan' || current.step === 'confirm') void current.cancel();
			current.dispose();
			passphrase = '';
			copied = false;
		};
	});

	// The question needs an answer: the person's eyes go to it, and so does the focus.
	$effect(() => {
		if (flow?.step !== 'confirm') return;
		void tick().then(() => body?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
	});

	const countdown = $derived.by(() => {
		const seconds = flow?.remaining ?? 0;
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	});
	const code = $derived(flow ? `${flow.code.slice(0, 3)} ${flow.code.slice(3)}` : '');
	const platform = $derived(formatPlatform(flow?.device?.platform));

	async function begin(event: SubmitEvent) {
		event.preventDefault();
		await flow?.begin(passphrase);
		if (flow?.step === 'scan') passphrase = '';
	}

	async function copy() {
		if (!flow || (await copyText(flow.link)) !== 'copied') return;
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	async function confirm() {
		await flow?.confirm();
		if (flow?.token) onpaired?.(flow.token);
	}
</script>

<Dialog bind:open title="Add a device" width={440} dismissible={flow?.step !== 'confirm'}>
	{#if flow}
		<div class="body" bind:this={body}>
			{#if flow.error}<Banner tone="danger">{flow.error}</Banner>{/if}
			{#if flow.step === 'credential'}
				<form onsubmit={begin}>
					<h3>Confirm it's you</h3>
					<p>Adding a device gives it access to your files. Confirm with your passphrase.</p>
					<ConfirmPassphrase bind:value={passphrase} />
					<div class="actions">
						<Button
							type="submit"
							variant="primary"
							busy={flow.busy}
							disabled={session.asksPassphrase && passphrase === ''}
						>
							{flow.busy ? 'Checking…' : 'Continue'}
						</Button>
					</div>
				</form>
			{:else if flow.step === 'scan' || flow.step === 'ended'}
				<h3>Scan with your phone</h3>
				<div class="qr">
					{#if flow.step === 'scan'}
						<QrCode value={flow.link} label="Code to add a device" />
					{:else}
						<p class="ended">This code can no longer be used.</p>
					{/if}
				</div>
				{#if flow.step === 'scan'}
					<p>
						Open the YonDrive app on your phone, choose <strong>Add this device</strong> and scan this
						code.
					</p>
					<p class="expiry">Expires in {countdown}</p>
					<div class="actions">
						<Button icon="copy" onclick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
						<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
					</div>
				{:else}
					<div class="actions">
						<Button variant="primary" busy={flow.busy} onclick={() => flow?.renew()}>
							Show a new code
						</Button>
						<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
					</div>
				{/if}
			{:else if flow.step === 'confirm'}
				<h3>Is this your device?</h3>
				<p>
					<strong>{flow.device?.name}</strong>{platform ? ` (${platform})` : ''} wants to join your account.
				</p>
				<p class="code" aria-live="polite" data-testid="pairing-code">{code}</p>
				<p>Confirm only if your phone shows the same code.</p>
				<div class="actions">
					<Button variant="primary" busy={flow.busy} data-autofocus onclick={confirm}>
						Yes, add it
					</Button>
					<Button onclick={() => (open = false)}>No, cancel</Button>
				</div>
			{:else}
				<h3>Done</h3>
				<p><strong>{flow.token?.name}</strong> is paired and appears in your devices.</p>
				<div class="actions">
					<Button variant="primary" data-autofocus onclick={() => (open = false)}>Close</Button>
				</div>
			{/if}
		</div>
	{/if}
</Dialog>

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	h3 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		color: var(--text-strong);
	}

	p {
		margin: 0;
		font-size: 13px;
		color: var(--text-muted);
	}

	strong {
		color: var(--text-strong);
	}

	.qr {
		display: grid;
		place-items: center;
		width: min(240px, 100%);
		aspect-ratio: 1;
		margin: 4px auto;
	}

	.ended {
		color: var(--text-strong);
		text-align: center;
	}

	.expiry {
		font-variant-numeric: tabular-nums;
	}

	.code {
		font-family: var(--font-mono);
		font-size: 32px;
		letter-spacing: 0.1em;
		text-align: center;
		color: var(--text-strong);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
