<!--
  Setting a passphrase: the field with its strength meter, and the confirmation
  with whether the two match. The policy itself lives in the account layer.
-->
<script lang="ts">
	import { passphraseStrength } from '$lib/account/strength';
	import Field from './Field.svelte';
	import PasswordField from './PasswordField.svelte';
	import StrengthMeter from './StrengthMeter.svelte';

	interface Props {
		passphrase?: string;
		confirmation?: string;
		label?: string;
	}

	let {
		passphrase = $bindable(''),
		confirmation = $bindable(''),
		label = 'Passphrase'
	}: Props = $props();

	const mismatch = $derived(confirmation.length > 0 && confirmation !== passphrase);
</script>

<Field {label} hint="12 or more characters. A few unrelated words work well." required>
	{#snippet children(field)}
		<PasswordField {...field} bind:value={passphrase} autocomplete="new-password">
			{#snippet meter()}<StrengthMeter score={passphraseStrength(passphrase)} />{/snippet}
		</PasswordField>
	{/snippet}
</Field>
<Field
	label="Confirm {label.toLowerCase()}"
	error={mismatch ? 'The two passphrases do not match.' : undefined}
	required
>
	{#snippet children(field)}
		<PasswordField {...field} bind:value={confirmation} autocomplete="new-password" />
	{/snippet}
</Field>
