<!--
  The dialogs of Notes: a notebook made or renamed with its colour, a notebook
  moved to the trash, and a note's reminder.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { Button, Dialog, Field, TextInput } from '$lib/components';
	import { InvalidNameError } from '$lib/drive/names';
	import {
		NOTEBOOK_COLORS,
		notebookColor,
		parseNoteMeta,
		type NotebookColor
	} from '$lib/notes/model';
	import { drive } from '$lib/state/drive.svelte';
	import { notes } from '$lib/state/notes.svelte';
	import { toasts } from '$lib/state/toasts.svelte';

	const dialog = $derived(notes.dialog);
	let name = $state('');
	let color = $state<NotebookColor>('blue');
	let error = $state('');
	let when = $state('');

	const pad = (n: number) => String(n).padStart(2, '0');
	/** A time as a `datetime-local` value, in local time. */
	function local(ms: number): string {
		const d = new Date(ms);
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	// Filled in when a dialog opens, and left alone while it is open.
	$effect(() => {
		const d = dialog;
		untrack(() => fill(d));
	});

	function fill(d: typeof dialog) {
		error = '';
		if (d?.kind === 'notebook') {
			name = d.node?.name ?? '';
			color = d.node ? notebookColor(d.node.raw) : NOTEBOOK_COLORS[notes.notebooks().length % 6];
		} else if (d?.kind === 'reminder') {
			const at = parseNoteMeta(d.node.raw).reminder;
			// A new reminder starts at the next round hour.
			const hour = 60 * 60 * 1000;
			when = local(at ?? Math.ceil((Date.now() + 1) / hour) * hour);
		}
	}

	const close = () => (notes.dialog = null);

	async function saveNotebook() {
		if (dialog?.kind !== 'notebook') return;
		const node = dialog.node;
		try {
			if (name.trim() === '') throw new InvalidNameError('empty');
			const ok = await notes.run(async (core, root) => {
				if (node === null) return core.createNotebook(root, name, color);
				if (name.trim() !== node.name) await core.renameNotebook(node.id, name);
				return core.recolorNotebook(node.id, color);
			});
			if (ok) close();
		} catch (e) {
			error =
				e instanceof InvalidNameError ? 'A notebook needs a name without slashes.' : String(e);
		}
	}

	async function deleteNotebook() {
		if (dialog?.kind !== 'delete-notebook') return;
		const node = dialog.node;
		close();
		await drive.run((core) => core.tree.trash(node.id));
		if (notes.notebook === node.id) notes.notebook = null;
		void drive.loadTrash();
		toasts.push('ok', `${node.name} is in the trash, with its notes.`);
	}

	async function saveReminder(clear = false) {
		if (dialog?.kind !== 'reminder') return;
		const node = dialog.node;
		const at = clear ? null : new Date(when).getTime();
		if (at !== null && !Number.isFinite(at)) {
			error = 'Choose a day and a time.';
			return;
		}
		close();
		await notes.run((core) => core.setMeta(node.id, { reminder: at }));
	}

	const COLOR_NAMES: Record<NotebookColor, string> = {
		blue: 'Blue',
		orange: 'Orange',
		green: 'Green',
		violet: 'Violet',
		amber: 'Amber',
		rose: 'Rose'
	};
</script>

<Dialog
	open={dialog?.kind === 'notebook'}
	title={dialog?.kind === 'notebook' && dialog.node ? 'Notebook' : 'New notebook'}
	onclose={close}
	width={420}
>
	<form
		id="notebook-form"
		onsubmit={(e) => {
			e.preventDefault();
			void saveNotebook();
		}}
	>
		<Field label="Name" {error}>
			{#snippet children(field)}
				<TextInput {...field} bind:value={name} data-autofocus autocomplete="off" />
			{/snippet}
		</Field>
		<fieldset class="colors">
			<legend>Colour</legend>
			{#each NOTEBOOK_COLORS as c (c)}
				<label class="swatch" style:--swatch="var(--notebook-{c})">
					<input type="radio" name="notebook-color" value={c} bind:group={color} />
					<span class="dot" aria-hidden="true"></span>
					<span class="sr">{COLOR_NAMES[c]}</span>
				</label>
			{/each}
		</fieldset>
	</form>
	{#snippet footer()}
		<Button variant="ghost" onclick={close}>Cancel</Button>
		<Button variant="primary" type="submit" form="notebook-form">
			{dialog?.kind === 'notebook' && dialog.node ? 'Save' : 'Create'}
		</Button>
	{/snippet}
</Dialog>

<Dialog
	open={dialog?.kind === 'delete-notebook'}
	title="Move this notebook to the trash?"
	onclose={close}
	width={440}
>
	<p>
		“{dialog?.kind === 'delete-notebook' ? dialog.node.name : ''}” and the notes in it go to the
		trash, where they can be restored.
	</p>
	{#snippet footer()}
		<Button variant="ghost" onclick={close}>Cancel</Button>
		<Button variant="primary" onclick={() => void deleteNotebook()}>Move to trash</Button>
	{/snippet}
</Dialog>

<Dialog open={dialog?.kind === 'reminder'} title="Reminder" onclose={close} width={400}>
	<form
		id="reminder-form"
		onsubmit={(e) => {
			e.preventDefault();
			void saveReminder();
		}}
	>
		<Field
			label="Remind me at"
			{error}
			hint="Reminders show while YonDrive is open in a tab, on this device and others."
		>
			{#snippet children(field)}
				<TextInput {...field} type="datetime-local" bind:value={when} data-autofocus />
			{/snippet}
		</Field>
	</form>
	{#snippet footer()}
		{#if dialog?.kind === 'reminder' && parseNoteMeta(dialog.node.raw).reminder !== null}
			<Button variant="ghost" onclick={() => void saveReminder(true)}>Remove</Button>
		{/if}
		<Button variant="ghost" onclick={close}>Cancel</Button>
		<Button variant="primary" type="submit" form="reminder-form">Set reminder</Button>
	{/snippet}
</Dialog>

<style>
	.colors {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 16px 0 0;
		padding: 0;
		border: 0;
	}

	legend {
		margin-bottom: 8px;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-strong);
	}

	.swatch {
		position: relative;
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border-radius: 10px;
		cursor: pointer;
	}

	.swatch input {
		position: absolute;
		inset: 0;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}

	.dot {
		width: 22px;
		height: 22px;
		border-radius: 7px;
		background: var(--swatch);
	}

	.swatch:has(input:checked) {
		box-shadow: 0 0 0 2px var(--swatch);
	}

	.swatch:has(input:focus-visible) {
		outline: 2px solid var(--accent);
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
