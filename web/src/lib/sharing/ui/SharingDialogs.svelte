<!--
  What sharing shows over everything else: who to share with, the number two people
  compare, and the warning that stops anything from being shared with someone whose
  keys have changed, which cannot be dismissed without an answer.
-->
<script lang="ts">
	import { formatDay } from '$lib/app/format';
	import { Button, Checkbox, Dialog, Icon } from '$lib/components';
	import { drive } from '$lib/state/drive.svelte';
	import { sharing } from '$lib/state/sharing.svelte';
	import ShareDialog from './ShareDialog.svelte';

	const changed = $derived(sharing.changed);
	const comparing = $derived(sharing.comparing);
	const contacts = $derived(sharing.core?.contacts ?? null);

	/** Twelve groups, which read better in rows than in a line. */
	const groupsOf = (number: string) => number.split(' ');

	const newNumber = $derived(
		changed === null || contacts === null ? '' : contacts.safetyNumberWith(changed.current)
	);
	const oldNumber = $derived(
		changed === null || contacts === null ? '' : contacts.safetyNumberWith(changed.pinned)
	);

	/** What is not as this device knows it: another account, another name, or other keys. */
	const swapped = $derived(changed?.was.userId !== undefined);
	const renamed = $derived(!swapped && changed?.was.username !== undefined);
	const sameKeys = $derived(newNumber === oldNumber);

	async function accept() {
		if (changed === null || contacts === null) return;
		contacts.accept(changed);
		sharing.changed = null;
		await sharing.sync();
	}

	const contact = $derived(comparing === null ? undefined : contacts?.get(comparing.userId));
	const number = $derived(
		contact === undefined || contacts === null ? '' : contacts.safetyNumberWith(contact.keys)
	);
	let compared = $derived((contact?.comparedAt ?? null) !== null);

	function setCompared(on: boolean) {
		if (comparing !== null) contacts?.markCompared(comparing.userId, on);
		compared = on;
	}
</script>

{#if drive.dialog?.kind === 'share'}
	<ShareDialog node={drive.dialog.node} />
{/if}

{#if comparing}
	<Dialog
		open
		title="Safety number with {comparing.username}"
		width={460}
		onclose={() => (sharing.comparing = null)}
	>
		{#if contact}
			<p class="text">
				Compare this number with {comparing.username}, in person or on a call you trust. If it
				matches on both sides, nobody has stood between your keys, and that includes this server.
			</p>
			<ol class="number" data-testid="safety-number">
				{#each groupsOf(number) as group, i (i)}<li>{group}</li>{/each}
			</ol>
			<p class="when">Their keys were first seen on {formatDay(contact.pinnedAt)}.</p>
			<Checkbox checked={compared} onchange={(event) => setCompared(event.currentTarget.checked)}>
				We compared it, and it matches
			</Checkbox>
		{:else}
			<p class="text">This device has not seen {comparing.username}'s keys yet.</p>
		{/if}
		{#snippet footer()}
			<Button variant="primary" onclick={() => (sharing.comparing = null)}>Done</Button>
		{/snippet}
	</Dialog>
{/if}

{#if changed}
	<Dialog
		open
		title={swapped
			? `A different account is using the name ${changed.username}`
			: renamed
				? `${changed.was.username} now has the name ${changed.username}`
				: `The keys of ${changed.username} have changed`}
		width={520}
		dismissible={false}
	>
		<div class="alarm">
			<Icon name="warn" size={22} />
			<div>
				<p class="text">
					{#if swapped}
						This device knows <strong>{changed.username}</strong> as another account, and the server now
						gives a new one with that name. They may have made a new account. It could also be someone
						getting between you, so nothing has been shared or opened.
					{:else if renamed}
						The server now gives the account this device knows as
						<strong>{changed.was.username}</strong> the name <strong>{changed.username}</strong>. A
						name does not normally change. It could be someone getting between you, so nothing has
						been shared or opened.
					{:else}
						The server gave different keys for <strong>{changed.username}</strong> from the ones this
						device first saw. They may have a new account. It could also be someone getting between you,
						so nothing has been shared or opened.
					{/if}
				</p>
				<p class="text">Ask {changed.username} for their safety number before going on.</p>
				{#if swapped}
					<p class="text">
						Trusting this replaces the {changed.username} this device knew. Anything the old account signed
						can no longer be checked here.
					</p>
				{:else if renamed}
					<p class="text">
						Trusting this replaces what this device knew, and it will know them only as {changed.username}.
					</p>
				{/if}
			</div>
		</div>
		<p class="label">
			{sameKeys ? 'The number with their keys' : 'The number with their new keys'}
		</p>
		<ol class="number" data-testid="safety-number-new">
			{#each groupsOf(newNumber) as group, i (i)}<li>{group}</li>{/each}
		</ol>
		{#if !sameKeys}
			<p class="label">The number with the keys you knew</p>
			<ol class="number old">
				{#each groupsOf(oldNumber) as group, i (i)}<li>{group}</li>{/each}
			</ol>
		{/if}
		{#snippet footer()}
			<Button onclick={accept}>
				{swapped ? 'Trust the new account' : renamed ? 'Trust the new name' : 'Trust the new keys'}
			</Button>
			<Button variant="primary" data-autofocus onclick={() => (sharing.changed = null)}>
				{swapped || renamed ? 'Keep what this device knows' : 'Keep the old keys'}
			</Button>
		{/snippet}
	</Dialog>
{/if}

<style>
	.text {
		margin: 0 0 12px;
		color: var(--text-soft);
	}

	.when {
		margin: 0 0 14px;
		font-size: 13px;
		color: var(--text-muted);
	}

	.label {
		margin: 12px 0 6px;
		font-size: 12px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.alarm {
		display: flex;
		gap: 12px;
		color: var(--danger-ink);
	}

	.number {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 6px 14px;
		margin: 0 0 14px;
		padding: 12px 14px;
		border-radius: 10px;
		background: var(--surface-sunken);
		font-family: var(--font-mono);
		font-size: 14px;
		list-style: none;
		color: var(--text-strong);
	}

	.number.old {
		color: var(--text-muted);
	}

	@media (max-width: 480px) {
		.number {
			grid-template-columns: repeat(3, 1fr);
		}
	}
</style>
