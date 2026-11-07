<!--
  A new recovery key: the 24 words, Copy and Download, then three of the words to
  type back. `confirmed` turns true only once those are right. Copy falls back to
  selecting the words where the browser offers no clipboard, as over plain HTTP.
-->
<script lang="ts">
	import {
		answersMatch,
		recoveryFile,
		WORDS_ASKED,
		type PendingRecovery
	} from '$lib/account/recovery-key';
	import Button from './Button.svelte';
	import Field from './Field.svelte';
	import Icon from './Icon.svelte';
	import TextInput from './TextInput.svelte';
	import { copyText } from './clipboard';

	interface Props {
		pending: PendingRecovery;
		username: string;
		server: string;
		confirmed?: boolean;
	}

	let { pending, username, server, confirmed = $bindable(false) }: Props = $props();

	let answers = $state<string[]>(Array.from({ length: WORDS_ASKED }, () => ''));
	let list = $state<HTMLElement>();
	let copied = $state<'copied' | 'manual' | null>(null);

	$effect(() => {
		confirmed = answersMatch(pending, answers);
	});

	async function copy() {
		const result = await copyText(pending.words.join(' '));
		if (result === 'manual' && list) {
			const range = document.createRange();
			range.selectNodeContents(list);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		}
		copied = result;
	}

	function download() {
		const blob = new Blob([recoveryFile(pending, username, server)], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = 'yondrive-recovery-key.txt';
		link.click();
		URL.revokeObjectURL(url);
	}
</script>

<div class="panel">
	<div class="save">
		<strong class="title"><Icon name="warn" size={18} /> Save your recovery key</strong>
		<p>
			It was generated in this browser and is never sent to the server. If you forget your
			passphrase, it is the only way back into your files. Nobody can reset it for you, not even an
			administrator.
		</p>
		<ol bind:this={list} class="words" data-testid="recovery-words">
			{#each pending.words as word, i (i)}
				<li><span class="n" aria-hidden="true">{i + 1}</span><span class="w">{word}</span></li>
			{/each}
		</ol>
		<div class="actions">
			<Button size="sm" icon="copy" onclick={copy}>
				{copied === 'copied' ? 'Copied' : 'Copy'}
			</Button>
			<Button size="sm" icon="download" onclick={download}>Download .txt</Button>
			<span class="status" role="status">
				{#if copied === 'manual'}Selected. Press Ctrl+C or Cmd+C to copy.{/if}
			</span>
		</div>
	</div>

	<div class="check">
		<p class="ask">To be sure you have it, type these words back.</p>
		<div class="answers">
			{#each pending.asked as position, i (position)}
				<Field label="Word {position + 1}" required>
					{#snippet children(field)}
						<TextInput
							{...field}
							bind:value={answers[i]}
							mono
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
						/>
					{/snippet}
				</Field>
			{/each}
		</div>
		{#if confirmed}
			<span class="ok" role="status"><Icon name="check" size={16} /> That matches.</span>
		{/if}
	</div>
</div>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.save {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 18px;
		border-radius: 14px;
		background: var(--warn-soft);
		color: var(--warn-ink);
	}

	.title {
		display: flex;
		align-items: center;
		gap: 10px;
		font-weight: 600;
	}

	.save p {
		margin: 0;
		font-size: 13px;
		color: var(--text-body);
	}

	.words {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
		gap: 6px;
		margin: 0;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
		list-style: none;
	}

	.words li {
		display: flex;
		gap: 8px;
		font-family: var(--font-mono);
		font-size: 13px;
		color: var(--text-strong);
	}

	.n {
		min-width: 18px;
		text-align: right;
		color: var(--text-muted);
		user-select: none;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.status {
		font-size: 12px;
		color: var(--text-body);
	}

	.check {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.ask {
		margin: 0;
		font-weight: 500;
		color: var(--text-strong);
	}

	.answers {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 12px;
	}

	.ok {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		color: var(--ok);
	}
</style>
