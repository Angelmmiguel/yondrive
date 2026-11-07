<!--
  An inline stroke icon, drawn by name from the paths in icons.ts. It is
  decorative unless given a `label`, in which case it is an image with that name.
-->
<script lang="ts">
	import { ICONS, type IconName } from './icons';

	interface Props {
		name: IconName;
		size?: number;
		strokeWidth?: number;
		/** Fills the shape with the current colour (the favourite star). */
		filled?: boolean;
		label?: string;
	}

	let { name, size = 18, strokeWidth = 1.8, filled = false, label }: Props = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill={filled ? 'currentColor' : 'none'}
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : true}
	focusable="false"
>
	<path d={ICONS[name]} />
</svg>

<style>
	svg {
		flex: none;
		display: block;
	}
</style>
