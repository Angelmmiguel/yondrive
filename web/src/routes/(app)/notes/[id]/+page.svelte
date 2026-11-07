<!-- A note in the editor, full screen. -->
<script lang="ts">
	import { page } from '$app/state';
	import NoteScreen from '$lib/notes/ui/NoteScreen.svelte';

	const id = $derived(page.params.id as string);
</script>

{#key id}
	<NoteScreen nodeId={id} />
{/key}
