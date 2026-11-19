<!-- The YonDrive mark: a tray of cards. -->
<script lang="ts">
	import mark from '$lib/assets/logo.png';

	interface Props {
		size?: number;
		/** An accessible name; the mark is decorative without one. */
		label?: string;
	}

	let { size = 32, label }: Props = $props();
</script>

<img src={mark} width={size} height={size} alt={label ?? ''} draggable="false" />

<style>
	img {
		display: block;
		filter: drop-shadow(0 2px 3px rgb(0 0 0 / 0.25));
	}
</style>
