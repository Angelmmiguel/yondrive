<!--
  Preformatted text with a Copy button. When the browser offers no way to write
  the clipboard (plain HTTP, a locked-down policy), the text is selected
  instead and the button asks the user to copy it by hand. The `key`
  variant is the one-line, spaced style for recovery keys.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { copyText } from './clipboard';

	interface Props {
		code: string;
		variant?: 'block' | 'key';
		/** Wrap long lines instead of scrolling sideways. */
		wrap?: boolean;
		/** Names what is copied, for the button's accessible name. */
		label?: string;
	}

	let { code, variant = 'block', label = 'code', wrap = false }: Props = $props();

	let phase = $state<'idle' | 'copied' | 'manual'>('idle');
	let node = $state<HTMLElement>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		const result = await copyText(code);
		if (result === 'manual' && node) {
			const range = document.createRange();
			range.selectNodeContents(node);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		}
		phase = result;
		clearTimeout(timer);
		timer = setTimeout(() => (phase = 'idle'), 2500);
	}

	onDestroy(() => clearTimeout(timer));
</script>

<div class="code {variant}" class:wrap>
	{#if variant === 'key'}
		<code bind:this={node} class="text">{code}</code>
	{:else}
		<pre bind:this={node} class="text"><code>{code}</code></pre>
	{/if}
	<button type="button" class="copy" aria-label="Copy {label}" onclick={copy}>
		{phase === 'copied' ? 'Copied' : phase === 'manual' ? 'Press Ctrl+C' : 'Copy'}
	</button>
	<span class="status" role="status">
		{phase === 'copied'
			? 'Copied to the clipboard.'
			: phase === 'manual'
				? 'Selected. Press Ctrl+C or Cmd+C to copy.'
				: ''}
	</span>
</div>

<style>
	.block {
		position: relative;
	}

	.key {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.text {
		margin: 0;
		border: 1px solid var(--border);
		background: var(--code);
		color: var(--text-body);
		font-family: var(--font-mono);
	}

	pre.text {
		padding: 14px 16px;
		padding-right: 96px;
		border-radius: 10px;
		font-size: 12px;
		line-height: 1.6;
		overflow-x: auto;
		white-space: pre;
	}

	.wrap pre.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		overflow-x: hidden;
		padding-right: 16px;
		padding-bottom: 46px;
	}

	.block.wrap .copy {
		top: auto;
		bottom: 8px;
	}

	code.text {
		flex: 1 1 360px;
		padding: 12px 14px;
		border-radius: 10px;
		background: var(--surface);
		font-size: 15px;
		letter-spacing: 0.06em;
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}

	.copy {
		height: 30px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text-strong);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
	}

	.copy:hover {
		background: var(--surface-hover);
	}

	.block .copy {
		position: absolute;
		top: 8px;
		right: 8px;
	}

	.key .copy {
		height: 44px;
		padding: 0 14px;
		border-radius: 10px;
		font-size: inherit;
	}

	.status {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
</style>
