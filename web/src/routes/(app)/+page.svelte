<!-- Home, until Drive arrives in Phase 2: the place files will be. -->
<script lang="ts">
	import { EmptyState } from '$lib/components';
</script>

<svelte:head><title>My files · YonDrive</title></svelte:head>

<h1>My files</h1>
<EmptyState title="Nothing here yet" icon="folder">
	Your files will appear here. Uploading arrives with the next release.
</EmptyState>

<style>
	h1 {
		margin: 0;
		font-size: 24px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}
</style>
