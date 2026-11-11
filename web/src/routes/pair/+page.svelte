<!--
  Where a pairing code leads when it is opened as a link rather than scanned by the
  app. The fragment holds the browser's key for the pairing: it is dropped from the
  address bar and never read, and nothing here asks the server about it.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { AuthCard } from '$lib/components';

	history.replaceState(null, '', location.pathname);
</script>

<svelte:head><title>Add this device · YonDrive</title></svelte:head>

<AuthCard title="Add this device">
	<p>
		This code is for the YonDrive app. Open the app on your phone, choose <strong
			>Add this device</strong
		> and scan the code shown on your computer.
	</p>
	<p class="aside">
		Already signed in on the web? Go to <a href={resolve('/settings')}>Settings → Devices</a>.
	</p>
</AuthCard>

<style>
	p {
		margin: 0;
		font-size: 14px;
		color: var(--text-muted);
	}

	strong {
		color: var(--text-strong);
	}

	.aside {
		font-size: 13px;
	}
</style>
