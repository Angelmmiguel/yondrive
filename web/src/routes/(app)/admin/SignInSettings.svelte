<!--
  How people sign in, and how long history is kept. Changing the provider or local
  accounts proves a current credential, as whoever names the issuer can sign in as
  anyone it can match. Shortening what is kept does too, and lengthening it does not.
-->
<script lang="ts">
	import { newOidcForm, oidcFormProblem, oidcInput, type OidcForm } from '$lib/account/providers';
	import { changeSettings } from '$lib/account/security';
	import ConfirmPassphrase from '$lib/account/ui/ConfirmPassphrase.svelte';
	import OidcFields from '$lib/account/ui/OidcFields.svelte';
	import { api } from '$lib/api/client';
	import type { ServerSettings, UpdateSettingsRequest } from '$lib/api/types';
	import { failure } from '$lib/app/failure';
	import { Banner, Button, Card, Field, Switch, TextInput } from '$lib/components';
	import { session } from '$lib/state/session.svelte';
	import { toasts } from '$lib/state/toasts.svelte';

	let settings = $state.raw<ServerSettings | null>(null);
	let enabled = $state(false);
	let local = $state(true);
	let form = $state<OidcForm>(newOidcForm('other'));
	let passphrase = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	let grace = $state('');
	let trash = $state('');
	let audit = $state('');
	let journal = $state('');
	let historyPassphrase = $state('');
	let historyBusy = $state(false);
	let historyError = $state<string | null>(null);

	const secretSet = $derived(settings?.oidc?.client_secret_set ?? false);
	const problem = $derived(enabled ? oidcFormProblem(form, secretSet) : null);
	const redirectUri = $derived(
		settings?.oidc?.redirect_uri ?? `${settings?.public_url ?? ''}/auth/oidc/callback`
	);
	const days = (text: string) => Number(text);
	const validDays = (text: string, least = 0) =>
		/^\d+$/.test(text) && days(text) >= least && days(text) <= 3650;
	const historyValid = $derived(
		validDays(grace, 1) && validDays(trash) && validDays(audit) && validDays(journal)
	);
	const shortens = (next: number, now: number | undefined) =>
		// Zero keeps for good, so going to it from anything shortens nothing.
		now !== undefined && next !== 0 && (now === 0 || next < now);
	const historyAsks = $derived(
		settings !== null &&
			(days(grace) < settings.purge_grace_days ||
				shortens(days(audit), settings.audit_retention_days))
	);

	function adopt(next: ServerSettings) {
		settings = next;
		local = next.local_accounts ?? true;
		enabled = next.oidc?.enabled ?? false;
		const oidc = next.oidc;
		if (oidc !== undefined) {
			form = {
				...newOidcForm('other'),
				label: oidc.label,
				issuer: oidc.issuer,
				clientId: oidc.client_id,
				clientSecret: '',
				scopes: oidc.scopes,
				adminGroup: oidc.admin_group,
				adminClaim: oidc.admin_claim,
				matchMode: oidc.match_mode,
				newUsers: oidc.new_users,
				allowInsecure: oidc.allow_insecure
			};
		}
		grace = String(next.purge_grace_days);
		trash = String(next.trash_retention_days);
		audit = String(next.audit_retention_days ?? 365);
		journal = String(next.journal_retention_days ?? 90);
	}

	$effect(() => {
		api
			.getSettings()
			.then(adopt)
			.catch((e: unknown) => (error = failure(e)));
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (problem !== null) return;
		busy = true;
		error = null;
		try {
			adopt(
				await changeSettings({
					request: { oidc: oidcInput(form, enabled), local_accounts: local },
					passphrase
				})
			);
			passphrase = '';
			toasts.push('ok', 'Sign-in settings saved.');
		} catch (e) {
			error = failure(e);
		} finally {
			busy = false;
		}
	}

	async function saveHistory(event: SubmitEvent) {
		event.preventDefault();
		if (!historyValid) return;
		historyBusy = true;
		historyError = null;
		const request: UpdateSettingsRequest = {
			purge_grace_days: days(grace),
			trash_retention_days: days(trash),
			audit_retention_days: days(audit),
			journal_retention_days: days(journal)
		};
		try {
			adopt(
				historyAsks
					? await changeSettings({ request, passphrase: historyPassphrase })
					: await api.updateSettings(request)
			);
			historyPassphrase = '';
			toasts.push('ok', 'Settings saved.');
		} catch (e) {
			historyError = failure(e);
		} finally {
			historyBusy = false;
		}
	}
</script>

{#if settings}
	<Card padding="lg" as="section" label="Sign-in settings">
		<form onsubmit={save}>
			<div class="switch-row">
				<span class="switch-text">
					<span class="switch-label">Local accounts</span>
					<span class="small">
						People sign in with a username and passphrase. Off, the first local administrator can
						still sign in, as the way back if the provider is down.
					</span>
				</span>
				<Switch label="Local accounts" bind:checked={local} />
			</div>
			<div class="switch-row">
				<span class="switch-text">
					<span class="switch-label">Single sign-on</span>
					<span class="small">Sign in through your identity provider with OpenID Connect.</span>
				</span>
				<Switch label="Single sign-on" bind:checked={enabled} />
			</div>
			{#if enabled}
				<OidcFields bind:form {redirectUri} {secretSet} test={(body) => api.testOidc(body)} />
			{/if}
			{#if error}<Banner tone="danger">{error}</Banner>{/if}
			{#if problem}<span class="small">{problem}</span>{/if}
			<ConfirmPassphrase bind:value={passphrase} hint="Needed to change how people sign in." />
			<div>
				<Button
					type="submit"
					variant="primary"
					{busy}
					disabled={problem !== null || (session.asksPassphrase && passphrase === '')}
				>
					{busy ? 'Saving…' : 'Save sign-in settings'}
				</Button>
			</div>
		</form>
	</Card>

	<Card padding="lg" as="section" label="History">
		<h2>How long things are kept</h2>
		<p class="small">
			In days. For the audit trail, the journal and the trash, 0 keeps them for good.
		</p>
		<form onsubmit={saveHistory}>
			<div class="fields">
				<Field label="Audit trail" hint="Shortening it asks for your passphrase.">
					{#snippet children(field)}
						<TextInput {...field} bind:value={audit} inputmode="numeric" />
					{/snippet}
				</Field>
				<Field label="Change journal" hint="A device away for longer reads everything again.">
					{#snippet children(field)}
						<TextInput {...field} bind:value={journal} inputmode="numeric" />
					{/snippet}
				</Field>
				<Field label="Trash" hint="Then it is purged.">
					{#snippet children(field)}
						<TextInput {...field} bind:value={trash} inputmode="numeric" />
					{/snippet}
				</Field>
				<Field
					label="Grace after a purge"
					hint="1 or more. Shortening it asks for your passphrase."
				>
					{#snippet children(field)}
						<TextInput {...field} bind:value={grace} inputmode="numeric" />
					{/snippet}
				</Field>
			</div>
			{#if historyError}<Banner tone="danger">{historyError}</Banner>{/if}
			{#if historyAsks}
				<ConfirmPassphrase
					bind:value={historyPassphrase}
					hint="A stolen session must not be able to erase its tracks."
				/>
			{/if}
			<div>
				<Button
					type="submit"
					{...{ busy: historyBusy }}
					disabled={!historyValid ||
						(historyAsks && session.asksPassphrase && historyPassphrase === '')}
				>
					{historyBusy ? 'Saving…' : 'Save'}
				</Button>
			</div>
		</form>
	</Card>
{:else if error}
	<Banner tone="danger">{error}</Banner>
{/if}

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--text-strong);
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));
		gap: 14px 18px;
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

	.small {
		margin: 0 0 12px;
		font-size: 12.5px;
		color: var(--text-muted);
	}
</style>
