<!-- What has been shared with this user and not looked at, at the top of the app. -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Icon, Menu, type MenuItem } from '$lib/components';
	import { drive } from '$lib/state/drive.svelte';
	import { sharing } from '$lib/state/sharing.svelte';

	const unread = $derived(sharing.unread);

	function labelOf(nodeId: string, granterId: string): string {
		const entry = sharing.entryOf(nodeId);
		if (entry === undefined) return 'Something was shared with you';
		const who = entry.grant.granter_username;
		if (entry.trust !== 'verified' || granterId !== entry.grant.granter_id) {
			return `An unverified share from ${who}`;
		}
		const name = drive.node(nodeId)?.name;
		return name ? `${who} shared ${name}` : `${who} shared something with you`;
	}

	const items = $derived<MenuItem[]>([
		...unread.map((one) => ({
			id: one.grant_id,
			label: labelOf(one.node_id, one.granter_id),
			icon: 'shared' as const
		})),
		...(unread.length === 0 ? [{ id: 'none', label: 'Nothing new', disabled: true }] : []),
		{ id: 'all', label: 'See all that is shared with you' }
	]);

	function choose(id: string) {
		const one = unread.find((item) => item.grant_id === id);
		if (one !== undefined) void sharing.markRead(one.grant_id);
		const entry = one === undefined ? undefined : sharing.entryOf(one.node_id);
		if (entry?.trust === 'verified' && entry.node.kind === 'folder') {
			void goto(resolve(`/files/${entry.node.id}`));
		} else {
			void goto(resolve('/shared'));
		}
	}
</script>

<Menu label="Notifications" {items} width={320} onselect={choose} heading="Shared with you">
	{#snippet trigger(attrs)}
		<button
			type="button"
			class="bell"
			data-testid="notifications"
			aria-label={unread.length === 0 ? 'Notifications' : `Notifications, ${unread.length} new`}
			{...attrs}
		>
			<Icon name="bell" size={19} strokeWidth={1.7} />
			{#if unread.length > 0}<span class="count">{unread.length}</span>{/if}
		</button>
	{/snippet}
</Menu>

<style>
	.bell {
		position: relative;
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 99px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
	}

	.bell:hover {
		background: var(--surface-hover);
	}

	.count {
		position: absolute;
		top: 3px;
		right: 2px;
		min-width: 17px;
		height: 17px;
		padding: 0 4px;
		border-radius: 99px;
		background: var(--accent);
		color: var(--on-accent, var(--on-primary));
		font-size: 11px;
		font-weight: 600;
		line-height: 17px;
		text-align: center;
	}
</style>
