<!-- What an administrator should know about the server's storage and how it is reached. -->
<script lang="ts">
	import { api } from '$lib/api/client';
	import type { AdminHealth } from '$lib/api/types';
	import { failure } from '$lib/app/failure';
	import { formatBytes, formatDate } from '$lib/app/format';
	import { Banner, Card } from '$lib/components';

	let { proxyUntrusted = false }: { proxyUntrusted?: boolean } = $props();

	let health = $state.raw<AdminHealth | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		api
			.getAdminHealth()
			.then((found) => (health = found))
			.catch((e: unknown) => (error = failure(e)));
	});
</script>

{#if proxyUntrusted}
	<Banner tone="warn" title="Requests look proxied by an address that is not trusted" icon="warn">
		Forwarded headers are being ignored, so client addresses and HTTPS detection are wrong. Add the
		proxy’s address to <code>YONDRIVE_TRUSTED_PROXIES</code>.
	</Banner>
{/if}
{#if error}<Banner tone="danger">{error}</Banner>{/if}
{#if health}
	<Card padding="lg" as="section" label="Health">
		<h2>Health</h2>
		<dl data-testid="admin-health">
			<dt>Last backup</dt>
			<dd data-testid="last-backup">
				{health.last_backup_at ? formatDate(health.last_backup_at) : 'Never: run yondrive backup'}
			</dd>
			<dt>Free disk</dt>
			<dd>{health.free_bytes === undefined ? 'Not known' : formatBytes(health.free_bytes)}</dd>
			<dt>Stored</dt>
			<dd>{formatBytes(health.stored_bytes)} in {health.blobs.toLocaleString()} files</dd>
			<dt>Uploads in progress</dt>
			<dd>{health.uploads.toLocaleString()}, holding {formatBytes(health.reserved_bytes)}</dd>
			<dt>Waiting to be removed</dt>
			<dd>{health.pending_removals.toLocaleString()} files</dd>
			<dt>Single sign-on</dt>
			<dd>
				{health.oidc_enabled ? `On, ${(health.sso_users ?? 0).toLocaleString()} linked` : 'Off'}
			</dd>
			<dt>Version</dt>
			<dd>{health.version}</dd>
		</dl>
	</Card>
{/if}

<style>
	h2 {
		margin: 0 0 12px;
		font-size: 16px;
		font-weight: 600;
		color: var(--text-strong);
	}

	dl {
		display: grid;
		grid-template-columns: minmax(120px, 200px) minmax(0, 1fr);
		gap: 6px 14px;
		margin: 0;
		font-size: 13px;
	}

	dt {
		color: var(--text-muted);
	}

	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	code {
		font-family: var(--font-mono);
		font-size: 12.5px;
	}
</style>
