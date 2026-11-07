<!-- The server's settings. The encryption mode is shown and never editable. -->
<script lang="ts">
	import { api } from '$lib/api/client';
	import type { ServerSettings } from '$lib/api/types';
	import { failure } from '$lib/app/failure';
	import { formatQuota, QUOTA_OPTIONS } from '$lib/app/format';
	import { Banner, Button, Card, Field, Select, Switch, TextInput } from '$lib/components';
	import { session } from '$lib/state/session.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import Health from './Health.svelte';

	let settings = $state<ServerSettings | null>(null);
	let quota = $state('0');
	let busy = $state(false);
	let error = $state<string | null>(null);

	const quotas = $derived(
		QUOTA_OPTIONS.some((o) => o.value === quota)
			? QUOTA_OPTIONS
			: [...QUOTA_OPTIONS, { value: quota, label: formatQuota(Number(quota)) }]
	);

	$effect(() => {
		api
			.getSettings()
			.then((s) => {
				settings = s;
				quota = String(s.default_quota_bytes);
			})
			.catch((e: unknown) => (error = failure(e)));
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (settings === null) return;
		busy = true;
		error = null;
		try {
			settings = await api.updateSettings({
				name: settings.name.trim(),
				public_url: settings.public_url,
				default_quota_bytes: Number(quota),
				language: settings.language,
				time_zone: settings.time_zone,
				open_signup: settings.open_signup
			});
			toasts.push('ok', 'Settings saved.');
		} catch (e) {
			error = failure(e);
		} finally {
			busy = false;
		}
	}
</script>

{#if error}<Banner tone="danger">{error}</Banner>{/if}
{#if settings}
	<Health proxyUntrusted={settings.proxy_untrusted} />
	<Card padding="lg" as="section" label="Server settings">
		<form onsubmit={save}>
			<div class="fields">
				<Field label="Server name" required>
					{#snippet children(field)}
						<TextInput {...field} bind:value={(settings as ServerSettings).name} />
					{/snippet}
				</Field>
				<Field label="Public URL" required>
					{#snippet children(field)}
						<TextInput {...field} bind:value={(settings as ServerSettings).public_url} mono />
					{/snippet}
				</Field>
				<Field label="Default storage per user">
					{#snippet children(field)}
						<Select {...field} options={quotas} bind:value={quota} />
					{/snippet}
				</Field>
				<Field label="Time zone">
					{#snippet children(field)}
						<TextInput {...field} bind:value={(settings as ServerSettings).time_zone} />
					{/snippet}
				</Field>
				<Field label="Encryption" hint="Fixed when the server was set up.">
					{#snippet children(field)}
						<TextInput
							{...field}
							value={session.sealer?.encrypted ? 'End-to-end' : 'No encryption'}
							readonly
						/>
					{/snippet}
				</Field>
			</div>
			<div class="switch-row">
				<span class="switch-text">
					<span class="switch-label">Allow people to sign up</span>
					<span class="small">Otherwise, only people you invite can create an account.</span>
				</span>
				<Switch
					label="Allow people to sign up"
					bind:checked={(settings as ServerSettings).open_signup}
				/>
			</div>
			<div>
				<Button type="submit" variant="primary" {busy}>{busy ? 'Saving…' : 'Save'}</Button>
			</div>
		</form>
	</Card>
{/if}

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
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
		font-size: 12.5px;
		color: var(--text-muted);
	}
</style>
