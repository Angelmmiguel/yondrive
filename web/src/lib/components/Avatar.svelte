<!-- A person's initial on a soft colour, picked from the name when no tone is given. -->
<script lang="ts">
	interface Props {
		name: string;
		size?: number;
		tone?: 'blue' | 'green' | 'pink' | 'yellow';
		/** A ring in the surface colour, for overlapping stacks. */
		ring?: boolean;
	}

	let { name, size = 34, tone, ring = false }: Props = $props();

	const TONES = ['blue', 'green', 'pink', 'yellow'] as const;
	const initial = $derived(Array.from(name.trim())[0]?.toUpperCase() ?? '?');
	const picked = $derived(
		tone ??
			TONES[Array.from(name).reduce((sum, c) => sum + (c.codePointAt(0) ?? 0), 0) % TONES.length]
	);
</script>

<span
	class="avatar {picked}"
	class:ring
	role="img"
	aria-label={name}
	style:width="{size}px"
	style:height="{size}px"
	style:font-size="{Math.round(size * 0.38)}px"
>
	{initial}
</span>

<style>
	.avatar {
		flex: none;
		display: inline-grid;
		place-items: center;
		border-radius: 99px;
		font-weight: 600;
		color: var(--avatar-ink);
	}

	.ring {
		border: 2px solid var(--surface);
	}

	.blue {
		background: var(--avatar-blue);
	}

	.green {
		background: var(--avatar-green);
	}

	.pink {
		background: var(--avatar-pink);
	}

	.yellow {
		background: var(--avatar-yellow);
	}
</style>
