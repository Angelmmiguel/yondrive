<!--
  The file's name in an editor's header. Whoever may rename the file clicks it
  to edit it in place: Enter or leaving the field keeps the new name, Escape
  puts the old one back, and a name that cannot be used says why and stays open
  to be fixed.
-->
<script lang="ts">
	import { tick } from 'svelte';

	interface Props {
		name: string;
		canRename: boolean;
		/** Renames the file: the sentence that says why it could not, or null when it did. */
		onrename: (name: string) => Promise<string | null>;
	}

	let { name, canRename, onrename }: Props = $props();

	const uid = $props.id();
	let editing = $state(false);
	let draft = $state('');
	let error = $state('');
	let busy = false;
	let field = $state<HTMLInputElement>();
	let button = $state<HTMLButtonElement>();

	async function start() {
		draft = name;
		error = '';
		editing = true;
		await tick();
		field?.focus();
		// The name without its extension, ready to be typed over.
		const dot = draft.lastIndexOf('.');
		field?.setSelectionRange(0, dot > 0 ? dot : draft.length);
	}

	async function stop(refocus: boolean) {
		editing = false;
		error = '';
		if (!refocus) return;
		await tick();
		button?.focus();
	}

	async function save(refocus: boolean) {
		if (busy || !editing) return;
		if (draft === name) return stop(refocus);
		busy = true;
		try {
			const why = await onrename(draft);
			if (why === null) await stop(refocus);
			else error = why;
		} finally {
			busy = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			void save(true);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			void stop(true);
		}
	}
</script>

{#if editing}
	<span class="edit">
		<input
			bind:this={field}
			bind:value={draft}
			class="field"
			aria-label="File name"
			aria-invalid={error ? true : undefined}
			aria-describedby={error ? `${uid}-error` : undefined}
			spellcheck="false"
			autocomplete="off"
			{onkeydown}
			onblur={() => void save(false)}
		/>
		{#if error}<span id="{uid}-error" class="error" role="alert">{error}</span>{/if}
	</span>
{:else}
	<!-- Named by the file alone, whatever the button inside says it does. -->
	<h1 class="name" class:plain={!canRename} aria-label={name} title={canRename ? undefined : name}>
		{#if canRename}
			<button
				bind:this={button}
				type="button"
				class="rename"
				aria-label="Rename {name}"
				title="Rename"
				onclick={() => void start()}>{name}</button
			>
		{:else}
			{name}
		{/if}
	</h1>
{/if}

<style>
	.name {
		/* Room for the button's hover padding, without moving the name. */
		margin: 0 -6px;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--name-size, 16px);
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.rename {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		margin: -2px 0;
		padding: 2px 6px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		letter-spacing: inherit;
		white-space: nowrap;
		cursor: text;
	}

	.name.plain {
		padding: 0 6px;
	}

	.rename:hover {
		background: var(--surface-hover);
	}

	.edit {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.field {
		width: min(36ch, 50vw);
		min-width: 0;
		height: 28px;
		margin: -2px -6px;
		padding: 0 6px;
		border: 1px solid var(--border-field);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
		font-size: var(--name-size, 16px);
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.field[aria-invalid='true'] {
		border-color: var(--danger);
	}

	.error {
		color: var(--danger-ink);
		font-size: 12px;
		white-space: nowrap;
	}

	/* A finger's 44px, as every control has here, without making the header taller. */
	@media (max-width: 640px), (pointer: coarse) {
		.rename,
		.field {
			margin-block: -12px;
		}
	}
</style>
