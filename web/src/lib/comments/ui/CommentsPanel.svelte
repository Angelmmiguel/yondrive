<!--
  The comments of the file open beside it: a box to start a thread, about what is
  selected or the whole file, and the threads, with replies, resolving and editing.
  Every comment is someone else's text, drawn as plain text and never as markup.
-->
<script lang="ts">
	import { formatWhen } from '$lib/app/format';
	import { Avatar, Banner, Button, Icon } from '$lib/components';
	import { describeDriveError } from '$lib/drive/errors';
	import type { FileCommentsState } from '$lib/state/comments.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import { cellName, MAX_TEXT, type Anchor } from '../anchor';
	import type { CommentView, Thread } from '../comments';

	interface Props {
		comments: FileCommentsState;
		/** Commenter, editor or owner. */
		canComment: boolean;
		/** Editor or owner: resolves and reopens. */
		canResolve: boolean;
		/** The owner deletes anyone's. */
		owner: boolean;
		/** What a new thread would be about: the selection, if there is one. */
		draft: { anchor: Anchor; label: string } | null;
		/** Where a thread points, in words, and whether it can no longer be found. */
		place?: (thread: Thread) => { label: string; lost: boolean } | null;
		/** The thread that is picked, here or in the file. */
		selected?: string | null;
		onselect?: (thread: Thread) => void;
	}

	let {
		comments,
		canComment,
		canResolve,
		owner,
		draft,
		place = describePlace,
		selected = $bindable(null),
		onselect
	}: Props = $props();

	/** Where a thread points, without the file at hand to look: as the viewer shows it. */
	function describePlace(thread: Thread): { label: string; lost: boolean } | null {
		const a = thread.anchor;
		if (a === null) return null;
		if (a.kind === 'text') return { label: `“${a.quote}”`, lost: false };
		return a.lost
			? { label: 'Cell no longer there', lost: true }
			: { label: `Cell ${cellName(a.row, a.col)} on ${a.sheet}`, lost: false };
	}

	const uid = $props.id();
	let text = $state('');
	let showResolved = $state(false);
	let replying = $state<string | null>(null);
	let replyText = $state('');
	let editing = $state<string | null>(null);
	let editText = $state('');

	const shown = $derived(showResolved ? comments.threads : comments.open);
	const resolvedCount = $derived(comments.threads.length - comments.open.length);

	async function run(what: () => Promise<unknown>): Promise<boolean> {
		try {
			await what();
			return true;
		} catch (e) {
			toasts.push(
				'danger',
				e instanceof Error && !('code' in e) ? e.message : describeDriveError(e)
			);
			return false;
		}
	}

	async function start(event: SubmitEvent) {
		event.preventDefault();
		const anchor = draft?.anchor ?? null;
		if (await run(() => comments.start(text, anchor))) text = '';
	}

	async function sendReply(event: SubmitEvent, thread: Thread) {
		event.preventDefault();
		if (await run(() => comments.reply(thread.id, replyText))) {
			replying = null;
			replyText = '';
		}
	}

	async function saveEdit(event: SubmitEvent, comment: CommentView) {
		event.preventDefault();
		if (await run(() => comments.edit(comment, editText))) editing = null;
	}

	function pick(thread: Thread) {
		selected = thread.id;
		onselect?.(thread);
	}
</script>

{#snippet one(comment: CommentView, first: boolean, answered = false)}
	<div class="comment" data-testid="comment" class:first>
		<div class="who">
			<Avatar name={comment.authorName} size={26} />
			<span class="name">{comment.mine ? 'You' : comment.authorName}</span>
			<span class="when">{formatWhen(comment.createdAt)}{comment.editedAt ? ' · edited' : ''}</span>
		</div>
		{#if comment.former}
			<p class="former">No longer allowed to comment here.</p>
		{/if}
		{#if editing === comment.id}
			<form class="compose" onsubmit={(e) => saveEdit(e, comment)}>
				<label class="sr" for="{uid}-edit-{comment.id}">Edit comment</label>
				<textarea
					id="{uid}-edit-{comment.id}"
					bind:value={editText}
					maxlength={MAX_TEXT}
					rows="3"
					data-autofocus></textarea>
				<div class="row">
					<Button size="sm" variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
					<Button
						size="sm"
						variant="primary"
						type="submit"
						busy={comments.busy}
						disabled={editText.trim() === ''}>Save</Button
					>
				</div>
			</form>
		{:else}
			<p class="text">{comment.text}</p>
			<div class="row actions">
				{#if comment.mine && canComment}
					<button
						type="button"
						class="link"
						onclick={() => ((editing = comment.id), (editText = comment.text))}>Edit</button
					>
				{/if}
				{#if (comment.mine && canComment && !(first && answered)) || owner}
					<button
						type="button"
						class="link"
						aria-label={first ? 'Delete thread' : 'Delete comment'}
						onclick={() => void run(() => comments.remove(comment.id))}>Delete</button
					>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

<section class="comments" aria-label="Comments">
	{#if canComment}
		<form class="compose new" onsubmit={start}>
			<p class="about" data-testid="comment-about">
				{#if draft}
					<Icon name="quote" size={14} /> <span class="quote">{draft.label}</span>
				{:else}
					On the whole file. Select something in it to comment on that.
				{/if}
			</p>
			<label class="sr" for="{uid}-new">New comment</label>
			<textarea
				id="{uid}-new"
				bind:value={text}
				maxlength={MAX_TEXT}
				rows="3"
				placeholder="Add a comment"></textarea>
			<div class="row">
				<Button
					size="sm"
					variant="primary"
					type="submit"
					busy={comments.busy}
					disabled={text.trim() === ''}>Comment</Button
				>
			</div>
		</form>
	{/if}

	{#if comments.refused > 0}
		<div class="note">
			<Banner tone="warn" title="Some comments could not be verified">
				{comments.refused === 1 ? 'One comment is' : `${comments.refused} comments are`} not shown, as
				{comments.refused === 1 ? 'it' : 'they'} did not open or {comments.refused === 1
					? 'its signature does'
					: 'their signatures do'} not match who the server says wrote {comments.refused === 1
					? 'it'
					: 'them'}.
			</Banner>
		</div>
	{/if}

	{#if comments.phase === 'failed'}
		<p class="failed">{describeDriveError(comments.error)}</p>
	{:else if comments.phase === 'loading' && comments.threads.length === 0}
		<p class="empty" aria-live="polite">Reading comments…</p>
	{:else if comments.threads.length === 0}
		<p class="empty">No comments yet.</p>
	{/if}

	{#if resolvedCount > 0}
		<label class="toggle">
			<input type="checkbox" bind:checked={showResolved} />
			Show resolved ({resolvedCount})
		</label>
	{/if}

	<ol class="threads">
		{#each shown as thread (thread.id)}
			{@const where = place(thread)}
			<li>
				<article
					class="thread"
					class:selected={selected === thread.id}
					class:resolved={thread.resolved}
					data-testid="comment-thread"
					aria-label="Comment by {thread.first.authorName}"
				>
					{#if where}
						<button
							type="button"
							class="where"
							class:lost={where.lost}
							onclick={() => pick(thread)}
						>
							{#if where.lost}
								<Icon name="warn" size={14} />
							{:else}
								<Icon name="quote" size={14} />
							{/if}
							<span>{where.label}</span>
						</button>
					{:else if thread.anchorRefused}
						<p class="where lost">Its place in the file could not be verified.</p>
					{/if}
					{@render one(
						thread.first,
						true,
						thread.replies.some((r) => !r.mine)
					)}
					{#each thread.replies as r (r.id)}
						{@render one(r, false)}
					{/each}
					{#if replying === thread.id}
						<form class="compose" onsubmit={(e) => sendReply(e, thread)}>
							<label class="sr" for="{uid}-reply-{thread.id}">Reply</label>
							<textarea
								id="{uid}-reply-{thread.id}"
								bind:value={replyText}
								maxlength={MAX_TEXT}
								rows="2"
								placeholder="Reply"
								data-autofocus></textarea>
							<div class="row">
								<Button size="sm" variant="ghost" onclick={() => (replying = null)}>Cancel</Button>
								<Button
									size="sm"
									variant="primary"
									type="submit"
									busy={comments.busy}
									disabled={replyText.trim() === ''}>Reply</Button
								>
							</div>
						</form>
					{/if}
					<div class="row foot">
						{#if thread.resolved}<span class="state"><Icon name="check" size={14} /> Resolved</span
							>{/if}
						{#if canComment && replying !== thread.id && !thread.resolved}
							<Button
								size="sm"
								variant="ghost"
								onclick={() => ((replying = thread.id), (replyText = ''))}>Reply</Button
							>
						{/if}
						{#if canResolve}
							<Button
								size="sm"
								variant="ghost"
								icon={thread.resolved ? 'undo' : 'check'}
								onclick={() => void run(() => comments.resolve(thread.id, !thread.resolved))}
								>{thread.resolved ? 'Reopen' : 'Resolve'}</Button
							>
						{/if}
					</div>
				</article>
			</li>
		{/each}
	</ol>
</section>

<style>
	.comments {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.compose {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.compose textarea {
		box-sizing: border-box;
		width: 100%;
		min-height: 64px;
		padding: 8px 10px;
		border: 1px solid var(--border-field);
		border-radius: 10px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
		resize: vertical;
	}

	.compose textarea:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.about {
		margin: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		color: var(--text-muted);
	}

	.quote {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-body);
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		flex-wrap: wrap;
	}

	.empty,
	.failed {
		margin: 0;
		font-size: 14px;
		color: var(--text-muted);
	}

	.failed {
		color: var(--danger-ink);
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-soft);
	}

	.threads {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.thread {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--surface);
	}

	.thread.selected {
		border-color: var(--warn);
		box-shadow: 0 0 0 1px var(--warn);
	}

	.thread.resolved {
		opacity: 0.75;
	}

	.where {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		padding: 4px 8px;
		border: 0;
		border-left: 3px solid var(--warn-line);
		border-radius: 4px;
		background: var(--warn-soft);
		color: var(--text-body);
		font: inherit;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}

	.where span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.where.lost {
		border-left-color: var(--border-strong);
		background: var(--surface-sunken);
		color: var(--text-muted);
	}

	.where:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.comment {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.comment:not(.first) {
		padding-top: 10px;
		border-top: 1px solid var(--divider);
	}

	.who {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.name {
		font-weight: 600;
		font-size: 14px;
		color: var(--text-strong);
	}

	.when {
		font-size: 12px;
		color: var(--text-muted);
	}

	.text {
		margin: 0;
		font-size: 14px;
		color: var(--text-body);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.former {
		margin: 0;
		font-size: 12px;
		color: var(--warn-ink);
	}

	.actions {
		justify-content: flex-start;
	}

	.link {
		padding: 0;
		border: 0;
		background: none;
		color: var(--text-muted);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.link:hover {
		color: var(--text-strong);
	}

	.link:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-right: auto;
		font-size: 12px;
		color: var(--ok-ink);
	}

	.note {
		margin: 0;
	}
</style>
