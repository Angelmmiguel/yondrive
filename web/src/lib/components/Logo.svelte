<!-- The YonDrive mark: an arch in a rounded square. -->
<script lang="ts">
	interface Props {
		size?: number;
		/** An accessible name; the mark is decorative without one. */
		label?: string;
	}

	let { size = 30, label }: Props = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 28 28"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : true}
>
	<rect width="28" height="28" rx="8" fill="var(--rail-logo)" />
	<path
		d="M8 20.5v-4.5a6 6 0 0 1 12 0v4.5"
		fill="none"
		stroke="var(--logo-ink)"
		stroke-width="2.4"
		stroke-linecap="round"
	/>
	<circle cx="14" cy="16.5" r="1.6" fill="var(--rail-accent)" />
</svg>
