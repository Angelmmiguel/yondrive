<!--
  The settings of an identity provider, with a guide for the common ones: the same in
  the wizard and in administration. It draws and tests. Saving is its caller's.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { copyText } from '$lib/components/clipboard';
	import { failure } from '$lib/app/failure';
	import { Banner, Button, CodeBlock, Field, Select, Switch, TextInput } from '$lib/components';
	import type { OidcTestRequest, OidcTestResult } from '$lib/api/types';
	import {
		describeOidcTest,
		PROVIDERS,
		providerById,
		type OidcForm,
		type ProviderId
	} from '../providers';

	interface Props {
		form: OidcForm;
		redirectUri: string;
		/** A secret is already stored, and leaving this blank keeps it. */
		secretSet?: boolean;
		test: (body: OidcTestRequest) => Promise<OidcTestResult>;
	}

	let { form = $bindable(), redirectUri, secretSet = false, test }: Props = $props();

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let testing = $state(false);
	let tested = $state<string | null>(null);
	let testError = $state<string | null>(null);

	const guide = $derived(providerById(form.provider));
	const MATCH = [
		{ value: 'email', label: 'email' },
		{ value: 'preferred_username', label: 'preferred_username' },
		{ value: 'sub', label: 'sub (never re-link)' }
	];
	const NEW_USERS = [
		{ value: 'create', label: 'Create on first sign-in' },
		{ value: 'invited', label: 'Only if invited first' }
	];
	const MESSAGES: Record<string, string> = {
		invalid_issuer:
			'That is not a usable issuer address. It has to be https, unless you allow insecure ones.',
		oidc_issuer_mismatch:
			'The provider spells its issuer differently. Use exactly its spelling, trailing slash and all.',
		oidc_discovery_failed:
			'YonDrive could not read the provider’s configuration from that address.',
		oidc_keys_failed:
			'The provider’s configuration reads fine, but it offers no signing key YonDrive can use.'
	};

	async function copyRedirect() {
		const result = await copyText(redirectUri);
		if (result === 'manual') {
			document.querySelector<HTMLInputElement>('[data-testid="redirect-uri"]')?.select();
			return;
		}
		copied = true;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied = false), 2500);
	}

	onDestroy(() => clearTimeout(copyTimer));

	function pick(id: ProviderId) {
		const provider = providerById(id);
		form.provider = id;
		form.issuer = provider.issuer;
		form.scopes = provider.scopes;
		form.label = provider.label;
		tested = testError = null;
	}

	async function run() {
		testing = true;
		tested = testError = null;
		try {
			tested = describeOidcTest(
				await test({ issuer: form.issuer.trim(), allow_insecure: form.allowInsecure })
			);
		} catch (e) {
			const code = (e as { code?: string }).code ?? '';
			testError = MESSAGES[code] ?? failure(e);
		} finally {
			testing = false;
		}
	}

	function onradio(event: KeyboardEvent, at: number) {
		const step =
			event.key === 'ArrowRight' || event.key === 'ArrowDown'
				? 1
				: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
					? -1
					: 0;
		if (step === 0) return;
		event.preventDefault();
		const next = PROVIDERS[(at + step + PROVIDERS.length) % PROVIDERS.length];
		pick(next.id);
		(event.currentTarget as HTMLElement).parentElement
			?.querySelector<HTMLElement>(`[data-provider="${next.id}"]`)
			?.focus();
	}
</script>

<div class="oidc" data-testid="oidc-fields">
	<div class="section">
		<span class="title" id="oidc-provider">Identity provider</span>
		<div class="providers" role="radiogroup" aria-labelledby="oidc-provider">
			{#each PROVIDERS as provider, at (provider.id)}
				<button
					type="button"
					role="radio"
					class="provider"
					class:on={form.provider === provider.id}
					aria-checked={form.provider === provider.id}
					tabindex={form.provider === provider.id ? 0 : -1}
					data-provider={provider.id}
					onclick={() => pick(provider.id)}
					onkeydown={(e) => onradio(e, at)}
				>
					<span class="mono {provider.tone}" aria-hidden="true">{provider.mono}</span>
					<span class="provider-text">
						<span class="provider-name">{provider.name}</span>
						<span class="small">{provider.tag}</span>
					</span>
				</button>
			{/each}
		</div>
	</div>

	<div class="columns">
		<div class="fields">
			<Field label="Button label" hint="Shown on the sign-in page as “Continue with …”." required>
				{#snippet children(field)}<TextInput {...field} bind:value={form.label} />{/snippet}
			</Field>
			<Field
				label="Issuer URL"
				hint="We read /.well-known/openid-configuration from here. Spell it exactly as the provider does."
				required
			>
				{#snippet children(field)}
					<TextInput {...field} bind:value={form.issuer} mono spellcheck="false" />
				{/snippet}
			</Field>
			<div class="pair">
				<Field label="Client ID" required>
					{#snippet children(field)}
						<TextInput {...field} bind:value={form.clientId} mono spellcheck="false" />
					{/snippet}
				</Field>
				<Field
					label="Client secret"
					hint={secretSet ? 'Stored. Leave blank to keep it.' : undefined}
					required={!secretSet}
				>
					{#snippet children(field)}
						<TextInput
							{...field}
							bind:value={form.clientSecret}
							type="password"
							autocomplete="off"
						/>
					{/snippet}
				</Field>
			</div>
			<Field label="Redirect URI" hint="Paste this into your provider.">
				{#snippet children(field)}
					<div class="copy-row">
						<TextInput {...field} value={redirectUri} mono readonly data-testid="redirect-uri" />
						<Button onclick={copyRedirect} label="Copy redirect URI">
							{copied ? 'Copied' : 'Copy'}
						</Button>
					</div>
				{/snippet}
			</Field>
			<div class="pair">
				<Field label="Scopes" required>
					{#snippet children(field)}
						<TextInput {...field} bind:value={form.scopes} mono spellcheck="false" />
					{/snippet}
				</Field>
				<Field label="Admin group" hint="Empty: sign-in never changes anyone’s role.">
					{#snippet children(field)}
						<TextInput {...field} bind:value={form.adminGroup} mono spellcheck="false" />
					{/snippet}
				</Field>
			</div>
			<div class="pair">
				<Field label="Match existing users by">
					{#snippet children(field)}
						<Select {...field} options={MATCH} bind:value={form.matchMode} />
					{/snippet}
				</Field>
				<Field label="New users from SSO">
					{#snippet children(field)}
						<Select {...field} options={NEW_USERS} bind:value={form.newUsers} />
					{/snippet}
				</Field>
			</div>
			<div class="switch-row">
				<span class="switch-text">
					<span class="switch-label">Allow an insecure issuer</span>
					<span class="small">Plain http://. Only for a test on a network you trust.</span>
				</span>
				<Switch label="Allow an insecure issuer" bind:checked={form.allowInsecure} />
			</div>
			<div class="test">
				<Button busy={testing} disabled={form.issuer.trim() === ''} onclick={run}>
					{testing ? 'Testing…' : 'Test connection'}
				</Button>
				{#if tested}<span class="ok" role="status" data-testid="oidc-test-ok">{tested}</span>{/if}
			</div>
			{#if testError}<Banner tone="danger">{testError}</Banner>{/if}
		</div>

		<aside class="guide" aria-label="Provider guide">
			<span class="guide-head">
				<span class="mono small-mono {guide.tone}" aria-hidden="true">{guide.mono}</span>
				<span class="provider-name">
					Set up {guide.id === 'other' ? 'your provider' : guide.name}
				</span>
			</span>
			<ol>
				{#each guide.steps as step (step)}<li>{step}</li>{/each}
			</ol>
			<CodeBlock code={guide.snippet(redirectUri)} label="settings" wrap />
			<span class="small">{guide.note}</span>
		</aside>
	</div>
</div>

<style>
	.oidc,
	.section,
	.fields {
		display: flex;
		flex-direction: column;
	}

	.oidc {
		gap: 22px;
	}

	.section {
		gap: 10px;
	}

	.fields {
		flex: 1 1 320px;
		min-width: 0;
		gap: 16px;
	}

	.title,
	.provider-name {
		font-weight: 600;
		color: var(--text-strong);
	}

	.providers {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(140px, 100%), 1fr));
		gap: 10px;
	}

	.provider {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
		padding: 14px;
		border: 1px solid var(--border-strong);
		border-radius: 14px;
		background: var(--surface);
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.provider:hover {
		border-color: var(--accent);
	}

	.provider.on {
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}

	.provider-text {
		display: flex;
		flex-direction: column;
	}

	.small {
		font-size: 12px;
		color: var(--text-muted);
	}

	.mono {
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		border-radius: 10px;
		font-size: 14px;
		font-weight: 700;
	}

	.small-mono {
		width: 28px;
		height: 28px;
		font-size: 12px;
		border-radius: 8px;
	}

	.blue {
		color: var(--tag-blue);
		background: var(--tag-blue-soft);
	}

	.green {
		color: var(--tag-green);
		background: var(--tag-green-soft);
	}

	.orange {
		color: var(--tag-orange);
		background: var(--tag-orange-soft);
	}

	.rose {
		color: var(--tag-rose);
		background: var(--tag-rose-soft);
	}

	.grey {
		color: var(--tag-grey);
		background: var(--tag-grey-soft);
	}

	.columns {
		display: flex;
		flex-wrap: wrap;
		gap: 22px;
		align-items: flex-start;
	}

	.copy-row {
		display: flex;
		gap: 8px;
		align-items: stretch;
	}

	.copy-row :global(.input) {
		flex: 1;
		min-width: 0;
	}

	.pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr));
		gap: 16px;
		align-items: start;
	}

	.switch-row {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.switch-text {
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.switch-label {
		font-weight: 500;
		color: var(--text-strong);
	}

	.test {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
	}

	.ok {
		font-size: 13px;
		color: var(--ok);
	}

	.guide {
		flex: 1 1 320px;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 18px;
		border: 1px solid var(--divider);
		border-radius: 14px;
		background: var(--surface-sunken);
	}

	.guide-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	ol {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding-left: 20px;
		font-size: 13px;
		color: var(--text-soft);
	}
</style>
