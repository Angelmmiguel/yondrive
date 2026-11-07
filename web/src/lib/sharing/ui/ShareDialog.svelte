<!--
  Sharing one node: the people who have it, and its public links. Revoking asks first
  and says what it can and cannot do, then shows the keys being replaced, as closing
  the tab halfway leaves new content under a key the revoked person may hold.
-->
<script lang="ts">
	import { formatDate } from '$lib/app/format';
	import {
		Avatar,
		Banner,
		Button,
		CodeBlock,
		Dialog,
		Field,
		PasswordField,
		ProgressBar,
		Select,
		Tabs,
		Tag,
		TextInput
	} from '$lib/components';
	import { isApiError, type GrantRole, type Link } from '$lib/api/types';
	import { describeDriveError } from '$lib/drive/errors';
	import type { DriveNode } from '$lib/drive/tree';
	import { drive } from '$lib/state/drive.svelte';
	import { session } from '$lib/state/session.svelte';
	import { sharing } from '$lib/state/sharing.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import { linkStatus, type LinkStatus } from '../links';
	import { unrekeyedText } from '../rotation';
	import type { Person } from '../sharing';

	interface Props {
		node: DriveNode;
	}

	let { node }: Props = $props();

	const encrypted = $derived(session.sealer?.encrypted ?? true);
	const ROLES = [
		{ value: 'viewer', label: 'Can view' },
		{ value: 'editor', label: 'Can edit' }
	];
	const STATUS: Record<LinkStatus, { label: string; tone: 'ok' | 'danger' | 'grey' }> = {
		live: { label: 'Live', tone: 'ok' },
		revoked: { label: 'Revoked', tone: 'danger' },
		expired: { label: 'Expired', tone: 'grey' },
		'used-up': { label: 'Downloads used up', tone: 'grey' }
	};

	let tab = $state('people');
	let username = $state('');
	let role = $state('viewer');
	let error = $state('');
	let busy = $state(false);
	let people = $state.raw<Person[]>([]);
	let revoking = $state.raw<Person | null>(null);
	const rotating = $derived(sharing.rotation !== null);

	let expires = $state('');
	let password = $state('');
	let limit = $state('');
	let linkError = $state('');
	let linkBusy = $state(false);
	let made = $state<string | null>(null);

	const links = $derived(
		sharing.links.filter(({ link }) => link.node_id === node.id).map(({ link }) => link)
	);
	const direct = $derived(people.filter((person) => !person.access.inherited));
	const inherited = $derived(people.filter((person) => person.access.inherited));

	/** Keeps the sentence here, and takes a changed key to the warning. */
	function explain(e: unknown): string {
		if (isApiError(e, 'unauthorized')) session.signedOut();
		sharing.warn(e);
		return describeDriveError(e);
	}

	async function load() {
		const core = sharing.core;
		if (core === null) return;
		try {
			people = await core.people(node.id);
		} catch (e) {
			error = explain(e);
		}
	}

	$effect(() => {
		void node.id;
		void load();
	});

	async function share(event: SubmitEvent) {
		event.preventDefault();
		const core = sharing.core;
		if (core === null || username.trim() === '') return;
		busy = true;
		error = '';
		try {
			await core.share(node.id, username.trim(), role as GrantRole);
			username = '';
			await load();
			sharing.publish();
		} catch (e) {
			error = isApiError(e, 'not_found')
				? 'There is nobody with that username. It has to match exactly.'
				: explain(e);
		} finally {
			busy = false;
		}
	}

	async function changeRole(person: Person, next: string) {
		const core = sharing.core;
		if (core === null || next === person.access.role) return;
		error = '';
		try {
			await core.changeRole(person.access, node.id, next as GrantRole);
			await load();
			sharing.publish();
		} catch (e) {
			error = explain(e);
			await load();
		}
	}

	async function revoke(person: Person) {
		if (person.access.grant_id === undefined) return;
		error = '';
		try {
			const unreadable = await sharing.revoke(person.access.grant_id, node.id);
			revoking = null;
			if (unreadable === 0) {
				toasts.push(
					'ok',
					`${person.access.username} no longer has access, and the keys are replaced.`
				);
			} else {
				toasts.push(
					'danger',
					`${person.access.username} no longer has access. ${unrekeyedText(unreadable)}.`
				);
			}
			await load();
		} catch (e) {
			revoking = null;
			error = `${explain(e)} Their access has ended. The keys are replaced the next time you unlock.`;
			await load();
		}
	}

	async function createLink(event: SubmitEvent) {
		event.preventDefault();
		const core = sharing.core;
		if (core === null) return;
		linkError = '';
		const count = limit.trim() === '' ? undefined : Number(limit);
		if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
			linkError = 'A download limit is a whole number, at least 1.';
			return;
		}
		if (password !== '' && Array.from(password).length < 8) {
			linkError = 'A link password needs at least 8 characters.';
			return;
		}
		linkBusy = true;
		try {
			const { url } = await core.createLink(node.id, {
				expiresAt: expires === '' ? undefined : new Date(expires),
				downloadLimit: count,
				password: password === '' ? undefined : password
			});
			made = url;
			expires = '';
			password = '';
			limit = '';
			sharing.publish();
		} catch (e) {
			linkError = explain(e);
		} finally {
			linkBusy = false;
		}
	}

	async function endLink(link: Link) {
		const core = sharing.core;
		if (core === null) return;
		try {
			await core.revokeLink(link.id);
			sharing.publish();
		} catch (e) {
			linkError = explain(e);
		}
	}

	async function forgetLink(link: Link) {
		const core = sharing.core;
		if (core === null) return;
		try {
			await core.deleteLink(link.id);
			sharing.publish();
		} catch (e) {
			linkError = explain(e);
		}
	}

	const urlOf = (link: Link) => sharing.core?.urlOf(link) ?? '';
	const close = () => {
		if (!rotating) drive.dialog = null;
	};
</script>

<Dialog open title="Share {node.name}" width={560} dismissible={!rotating} onclose={close}>
	<Tabs
		label="How to share"
		tabs={[
			{ id: 'people', label: 'People' },
			{ id: 'link', label: 'Public link' }
		]}
		bind:value={tab}
	>
		{#snippet children(selected)}
			{#if selected === 'people'}
				<div class="pane">
					{#if error}<Banner tone="danger">{error}</Banner>{/if}
					{#if revoking}
						<Banner tone="warn" title="Revoke {revoking.access.username}?">
							Their access ends at once. Then the keys of {node.kind === 'folder'
								? 'this folder and everything in it'
								: 'this file'} are replaced, so that what is added from now on is out of their reach.
							What they have already opened or copied may still be with them, and this cannot change that.
						</Banner>
						{#if rotating && sharing.rotation}
							<ProgressBar
								label="Replacing keys"
								value={sharing.rotation.done}
								max={Math.max(sharing.rotation.total, 1)}
							/>
							<p class="note" data-testid="rotation-count">
								Replacing keys: {sharing.rotation.done} of {sharing.rotation.total}. Keep this tab
								open.
							</p>
						{:else}
							<div class="confirm">
								<Button variant="ghost" onclick={() => (revoking = null)}>Keep access</Button>
								<Button variant="primary" onclick={() => revoking && revoke(revoking)}>
									Revoke and replace keys
								</Button>
							</div>
						{/if}
					{:else}
						<form class="add" onsubmit={share}>
							<div class="who">
								<Field label="Username">
									{#snippet children(field)}
										<TextInput {...field} bind:value={username} data-autofocus autocomplete="off" />
									{/snippet}
								</Field>
							</div>
							<Field label="Role">
								{#snippet children(field)}
									<Select {...field} options={ROLES} bind:value={role} />
								{/snippet}
							</Field>
							<Button variant="primary" type="submit" {busy} disabled={username.trim() === ''}>
								Share
							</Button>
						</form>
					{/if}

					<ul class="people" aria-label="People with access">
						{#each direct as person (person.access.grant_id ?? person.access.user_id)}
							<li data-testid="person">
								<Avatar name={person.access.username} size={30} />
								<span class="name">{person.access.username}</span>
								{#if person.unsigned}<Tag tone="danger">Not signed by you</Tag>{/if}
								<span class="end">
									<Select
										aria-label="Role of {person.access.username}"
										options={ROLES}
										value={person.access.role}
										disabled={rotating}
										onchange={(event) => changeRole(person, event.currentTarget.value)}
									/>
									{#if encrypted}
										<Button
											size="sm"
											variant="ghost"
											onclick={() =>
												(sharing.comparing = {
													userId: person.access.user_id,
													username: person.access.username
												})}
										>
											Safety number
										</Button>
									{/if}
									<Button
										size="sm"
										disabled={rotating}
										onclick={() => (revoking = person)}
										label="Revoke {person.access.username}"
									>
										Revoke
									</Button>
								</span>
							</li>
						{/each}
						{#each inherited as person (person.access.user_id)}
							<li>
								<Avatar name={person.access.username} size={30} />
								<span class="name">{person.access.username}</span>
								<Tag tone="grey">
									{person.access.role === 'editor' ? 'Can edit' : 'Can view'}, through a folder
									above
								</Tag>
							</li>
						{/each}
						{#if people.length === 0}<li class="none">Only you have this.</li>{/if}
					</ul>
				</div>
			{:else}
				<div class="pane">
					{#if linkError}<Banner tone="danger">{linkError}</Banner>{/if}
					{#if made}
						<div data-testid="link-url">
							<CodeBlock code={made} label="the link" />
						</div>
						<p class="note">
							{#if made.includes('#')}
								Whoever has this address can open it. The key is in the part after the #, which your
								browser never sends to the server.
							{:else}
								Send the password some other way than the link.
							{/if}
						</p>
					{/if}
					<form class="link-form" onsubmit={createLink}>
						<Field label="Ends" hint="Leave empty for no end.">
							{#snippet children(field)}
								<TextInput {...field} type="datetime-local" bind:value={expires} />
							{/snippet}
						</Field>
						<Field label="Downloads" hint="How many files, in all. Leave empty for no limit.">
							{#snippet children(field)}
								<TextInput {...field} inputmode="numeric" bind:value={limit} />
							{/snippet}
						</Field>
						<div class="wide">
							<Field
								label="Link password"
								hint="Optional. With one, the address carries no key. A long one protects this if the server's data is ever taken."
							>
								{#snippet children(field)}
									<PasswordField {...field} bind:value={password} autocomplete="new-password" />
								{/snippet}
							</Field>
						</div>
						<div class="wide">
							<Button variant="primary" type="submit" busy={linkBusy}>Create link</Button>
						</div>
					</form>
					<ul class="links" aria-label="Public links">
						{#each links as link (link.id)}
							{@const status = linkStatus(link, Date.now())}
							<li data-testid="link">
								<div class="line">
									<Tag tone={STATUS[status].tone}>{STATUS[status].label}</Tag>
									{#if link.has_password}<Tag tone="grey">Password</Tag>{/if}
									<span class="details">
										{link.download_limit === undefined
											? `${link.download_count} downloaded`
											: `${link.download_count} of ${link.download_limit} downloaded`}
										{#if link.expires_at}· ends {formatDate(link.expires_at)}{/if}
									</span>
								</div>
								<div class="line">
									{#if status === 'live'}
										<CodeBlock code={urlOf(link)} label="the link" />
										<Button size="sm" onclick={() => endLink(link)}>Revoke link</Button>
									{:else}
										<Button size="sm" variant="ghost" onclick={() => forgetLink(link)}>
											Remove from this list
										</Button>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		{/snippet}
	</Tabs>
	{#snippet footer()}
		<Button variant="primary" disabled={rotating} onclick={close}>Done</Button>
	{/snippet}
</Dialog>

<style>
	.pane {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding-top: 14px;
	}

	.add {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 10px;
	}

	.who {
		flex: 1 1 200px;
	}

	.confirm {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.note {
		margin: 0;
		font-size: 13px;
		color: var(--text-muted);
	}

	.people,
	.links {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.people li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		min-height: 44px;
	}

	.name {
		font-weight: 500;
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}

	.end {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-left: auto;
	}

	.none {
		color: var(--text-muted);
	}

	.link-form {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	.wide {
		grid-column: 1 / -1;
	}

	.links li {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 12px;
	}

	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.details {
		font-size: 13px;
		color: var(--text-muted);
	}

	@media (max-width: 480px) {
		.link-form {
			grid-template-columns: 1fr;
		}
	}
</style>
