<!--
  A labelled form field: label above, hint or error below. The control is
  passed a snippet argument carrying the id and the aria wiring, which a
  TextInput, PasswordField or Select takes as is: `<TextInput {...field} />`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	export interface FieldControl {
		id: string;
		'aria-describedby': string | undefined;
		'aria-invalid': true | undefined;
		'aria-required': true | undefined;
	}

	interface Props {
		label: string;
		hint?: string;
		/** An error replaces the hint and marks the control invalid. */
		error?: string;
		required?: boolean;
		children: Snippet<[FieldControl]>;
	}

	let { label, hint, error, required = false, children }: Props = $props();

	const uid = $props.id();
	const id = `${uid}-control`;
	const describedBy = $derived(error ? `${uid}-error` : hint ? `${uid}-hint` : undefined);
</script>

<div class="field">
	<label for={id}
		>{label}{#if required}<span class="req" aria-hidden="true"> *</span>{/if}</label
	>
	{@render children({
		id,
		'aria-describedby': describedBy,
		'aria-invalid': error ? true : undefined,
		'aria-required': required ? true : undefined
	})}
	{#if error}
		<span id="{uid}-error" class="msg error" role="alert">{error}</span>
	{:else if hint}
		<span id="{uid}-hint" class="msg">{hint}</span>
	{/if}
</div>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	label {
		font-weight: 500;
		color: var(--text-strong);
	}

	.req {
		color: var(--danger);
	}

	.msg {
		font-size: 12px;
		color: var(--text-muted);
	}

	.error {
		color: var(--danger-ink);
	}
</style>
