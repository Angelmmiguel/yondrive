<!--
  The screen a device stops at when it refuses the mode the server claims. There
  is no way past it: an app that carried on might send what should be encrypted
  to a server that asked for it in the clear.
-->
<script lang="ts">
	import type { ModeRefusal } from '$lib/crypto/sealer';
	import AuthCard from './AuthCard.svelte';
	import Banner from './Banner.svelte';

	interface Props {
		reason: ModeRefusal;
	}

	let { reason }: Props = $props();

	const WHY: Record<ModeRefusal, string> = {
		'account-has-keys':
			'Your account holds encryption keys, yet the server now says it does not encrypt.',
		'device-pinned':
			'This server now reports a different encryption mode from the one this device first saw.',
		'unknown-suite': 'The server reports an encryption mode this app does not know.'
	};
</script>

<AuthCard title="Stopped for your safety" width={520}>
	<Banner tone="danger" title="The encryption mode does not match">{WHY[reason]}</Banner>
	<p>
		The mode of a server is fixed when it is set up, so this should never happen on its own. It may
		be a mistake in how the server was restored or moved, or someone may be trying to get your files
		sent unencrypted. YonDrive has stopped, and has not opened your keys.
	</p>
	<p>
		Tell the administrator of this server. If this server was deliberately reinstalled, clear this
		site's data in your browser to start again.
	</p>
</AuthCard>

<style>
	p {
		margin: 0;
		color: var(--text-soft);
	}
</style>
