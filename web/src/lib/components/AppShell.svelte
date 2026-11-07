<!--
  The frame of a signed-in screen: the app rail and the sidebar on the left, the
  top bar and the page on the right. Below the breakpoint both navigation columns
  collapse into a drawer behind a menu button; a link inside closes it, as do
  Escape and a tap outside.
-->
<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import { focusableIn } from './focus';

	interface Props {
		rail: Snippet;
		sidebar: Snippet;
		top: Snippet;
		children: Snippet;
	}

	let { rail, sidebar, top, children }: Props = $props();

	const uid = $props.id();
	let open = $state(false);
	let drawer = $state<HTMLElement>();
	let opener = $state<HTMLElement>();

	async function show() {
		open = true;
		await tick();
		if (drawer) focusableIn(drawer)[0]?.focus();
	}

	function hide() {
		open = false;
		opener?.focus();
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (open && event.key === 'Escape') hide();
	}}
/>

<div class="shell">
	{#if open}
		<button type="button" class="scrim" aria-label="Close menu" tabindex="-1" onclick={hide}
		></button>
	{/if}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div
		bind:this={drawer}
		id="{uid}-nav"
		class="nav"
		class:open
		onclick={(event) => {
			if (open && (event.target as HTMLElement).closest('a')) open = false;
		}}
	>
		{@render rail()}
		{@render sidebar()}
	</div>
	<div class="column">
		<div class="head">
			<button
				bind:this={opener}
				type="button"
				class="opener"
				aria-label="Menu"
				aria-expanded={open}
				aria-controls="{uid}-nav"
				onclick={show}
			>
				<Icon name="menu" size={20} />
			</button>
			<div class="top">{@render top()}</div>
		</div>
		<main class="page">{@render children()}</main>
	</div>
</div>

<style>
	.shell {
		flex: 1;
		display: flex;
		min-height: 0;
		background: var(--surface-page);
	}

	.nav {
		flex: none;
		display: flex;
	}

	.column {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.head {
		display: flex;
		align-items: stretch;
		background: var(--surface-page);
		border-bottom: 1px solid var(--divider);
	}

	.top {
		flex: 1;
		min-width: 0;
	}

	.top :global(header) {
		border-bottom: 0;
	}

	.opener,
	.scrim {
		display: none;
	}

	.page {
		flex: 1;
		min-width: 0;
		padding: 28px 32px 48px;
	}

	@media (max-width: 860px) {
		.nav {
			position: fixed;
			inset: 0 auto 0 0;
			z-index: 40;
			max-width: calc(100vw - 48px);
			overflow-y: auto;
			visibility: hidden;
			transform: translateX(-100%);
			box-shadow: 0 24px 60px -24px var(--shadow-ink);
			transition:
				transform 0.18s,
				visibility 0.18s;
		}

		.nav.open {
			visibility: visible;
			transform: none;
		}

		.nav :global(aside) {
			width: 220px;
			flex: 1 1 auto;
		}

		.scrim {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 30;
			border: 0;
			background: rgb(8 8 10 / 0.5);
		}

		.opener {
			flex: none;
			display: grid;
			place-items: center;
			width: 48px;
			border: 0;
			background: transparent;
			color: var(--icon);
			cursor: pointer;
		}

		.page {
			padding: 20px 16px 40px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.nav {
			transition: none;
		}
	}
</style>
