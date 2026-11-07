<!-- The audit trail, newest first, a page at a time. It holds no content and no secrets. -->
<script lang="ts">
	import { api } from '$lib/api/client';
	import type { AuditEntry } from '$lib/api/types';
	import { failure } from '$lib/app/failure';
	import { formatDate } from '$lib/app/format';
	import { Banner, Button, EmptyState } from '$lib/components';

	const PAGE = 50;

	let entries = $state.raw<AuditEntry[]>([]);
	let next = $state<string | undefined>();
	let names = $state.raw<Map<string, string>>(new Map());
	let loaded = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const who = (id: string | undefined) =>
		id === undefined ? '—' : (names.get(id) ?? id.slice(0, 8));

	async function load(cursor?: string) {
		busy = true;
		error = null;
		try {
			const page = await api.listAudit({ cursor, limit: PAGE });
			entries = cursor === undefined ? page.entries : [...entries, ...page.entries];
			next = page.next_cursor;
		} catch (e) {
			error = failure(e);
		} finally {
			busy = false;
			loaded = true;
		}
	}

	$effect(() => {
		void load();
		api
			.listUsers()
			.then((users) => (names = new Map(users.map((user) => [user.id, user.username]))))
			.catch(() => {
				// Ids are shown instead.
			});
	});
</script>

{#if error}<Banner tone="danger">{error}</Banner>{/if}
{#if loaded && entries.length === 0 && !error}
	<EmptyState title="Nothing in the audit trail" icon="shield" />
{:else}
	<div class="scroll">
		<table data-testid="audit">
			<thead>
				<tr><th>When</th><th>What</th><th>Who</th><th>To</th><th>From</th></tr>
			</thead>
			<tbody>
				{#each entries as entry (entry.id)}
					<tr>
						<td class="when">{formatDate(entry.at)} {new Date(entry.at).toLocaleTimeString()}</td>
						<td class="action">{entry.action}</td>
						<td>{who(entry.actor_id)}</td>
						<td>{who(entry.target_id)}</td>
						<td class="action">{entry.remote ?? '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if next !== undefined}
		<div>
			<Button {busy} onclick={() => load(next)}>{busy ? 'Loading…' : 'Older entries'}</Button>
		</div>
	{/if}
{/if}

<style>
	.scroll {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}

	th {
		padding: 6px 12px 6px 0;
		text-align: left;
		font-weight: 500;
		color: var(--text-muted);
	}

	td {
		padding: 8px 12px 8px 0;
		border-top: 1px solid var(--divider);
		color: var(--text-soft);
		white-space: nowrap;
	}

	.action {
		font-family: var(--font-mono);
		font-size: 12px;
	}

	.when {
		color: var(--text-muted);
	}
</style>
