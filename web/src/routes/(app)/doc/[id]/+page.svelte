<!-- A document in the editor, full screen. -->
<script lang="ts">
	import { page } from '$app/state';
	import DocScreen from '$lib/docs/ui/DocScreen.svelte';

	const id = $derived(page.params.id as string);
</script>

{#key id}
	<DocScreen nodeId={id} />
{/key}
