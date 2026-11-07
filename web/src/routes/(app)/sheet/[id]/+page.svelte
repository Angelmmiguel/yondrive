<!-- A spreadsheet in the editor, full screen. -->
<script lang="ts">
	import { page } from '$app/state';
	import SheetScreen from '$lib/sheets/ui/SheetScreen.svelte';

	const id = $derived(page.params.id as string);
</script>

{#key id}
	<SheetScreen nodeId={id} />
{/key}
