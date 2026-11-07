<!--
  A modal dialog. Focus moves in when it opens (to the element marked
  data-autofocus, else the first control), Tab and Shift+Tab wrap inside it,
  Escape and a click on the backdrop close it, and focus returns to where it was.
-->
<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import { focusableIn } from './focus';

	interface Props {
		open?: boolean;
		title: string;
		description?: string;
		/** Whether Escape and the backdrop close it. Off for flows that must be answered. */
		dismissible?: boolean;
		width?: number;
		onclose?: () => void;
		children: Snippet;
		footer?: Snippet;
	}

	let {
		open = $bindable(false),
		title,
		description,
		dismissible = true,
		width = 480,
		onclose,
		children,
		footer
	}: Props = $props();

	const uid = $props.id();
	let panel = $state<HTMLElement>();
	let returnTo: HTMLElement | null = null;

	function close() {
		open = false;
		onclose?.();
	}

	$effect(() => {
		if (!open) return;
		returnTo = document.activeElement as HTMLElement | null;
		void tick().then(() => {
			if (!panel) return;
			const target =
				panel.querySelector<HTMLElement>('[data-autofocus]') ?? focusableIn(panel)[0] ?? panel;
			target.focus();
		});
		return () => {
			returnTo?.focus?.();
			returnTo = null;
		};
	});

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && dismissible) {
			event.stopPropagation();
			close();
			return;
		}
		if (event.key !== 'Tab' || !panel) return;
		const items = focusableIn(panel);
		if (items.length === 0) {
			event.preventDefault();
			panel.focus();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		if (event.shiftKey && (active === first || active === panel)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && active === last) {
			event.preventDefault();
			first.focus();
		} else if (!panel.contains(active)) {
			event.preventDefault();
			first.focus();
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={(e) => e.target === e.currentTarget && dismissible && close()}>
		<div
			bind:this={panel}
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="{uid}-title"
			aria-describedby={description ? `${uid}-desc` : undefined}
			tabindex="-1"
			style:max-width="{width}px"
			{onkeydown}
		>
			<header class="head">
				<h2 id="{uid}-title">{title}</h2>
				{#if dismissible}
					<button type="button" class="close" aria-label="Close" onclick={close}>
						<Icon name="close" size={16} strokeWidth={2} />
					</button>
				{/if}
			</header>
			{#if description}<p id="{uid}-desc" class="desc">{description}</p>{/if}
			<div class="body">{@render children()}</div>
			{#if footer}<footer class="foot">{@render footer()}</footer>{/if}
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: grid;
		place-items: center;
		padding: 16px;
		background: rgb(8 8 10 / 0.5);
	}

	.dialog {
		width: 100%;
		max-height: calc(100dvh - 32px);
		display: flex;
		flex-direction: column;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 16px;
		box-shadow: 0 24px 60px -24px var(--shadow-ink);
		overflow: hidden;
	}

	.dialog:focus {
		outline: none;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 18px 20px 0 24px;
	}

	h2 {
		flex: 1;
		margin: 0;
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text-strong);
	}

	.close {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
	}

	.close:hover {
		background: var(--surface-hover);
	}

	.desc {
		margin: 6px 24px 0;
		color: var(--text-muted);
	}

	.body {
		padding: 16px 24px 20px;
		overflow-y: auto;
	}

	.foot {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
		padding: 14px 24px;
		border-top: 1px solid var(--divider);
	}
</style>
