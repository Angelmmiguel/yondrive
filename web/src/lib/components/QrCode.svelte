<!--
	A QR code drawn in the page, so nothing leaves for another origin to make it.
	It stays dark on light in either theme: scanners expect that way round.
-->
<script lang="ts">
	import { encodeQr } from '$lib/qr/encode';

	interface Props {
		value: string;
		/** The largest it is drawn, in pixels; narrower containers shrink it. */
		size?: number;
		label: string;
	}

	let { value, size = 240, label }: Props = $props();

	const QUIET = 4;

	const modules = $derived(encodeQr(value));
	const side = $derived(modules.length + 2 * QUIET);
	const path = $derived(
		modules
			.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x + QUIET} ${y + QUIET}h1v1h-1z` : '')))
			.join('')
	);
</script>

<svg
	viewBox="0 0 {side} {side}"
	role="img"
	aria-label={label}
	shape-rendering="crispEdges"
	data-pairing-link={value}
	style:width="min({size}px, 100%)"
>
	<rect width={side} height={side} />
	<path d={path} />
</svg>

<style>
	svg {
		display: block;
		height: auto;
		aspect-ratio: 1;
		/* The light values of the tokens, whatever the theme. */
		color-scheme: light;
	}

	rect {
		fill: var(--surface);
	}

	path {
		fill: var(--text-strong);
	}
</style>
