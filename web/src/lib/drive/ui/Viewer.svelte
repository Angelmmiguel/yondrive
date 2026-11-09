<!-- Shows a file inside the app, once its version has been verified. -->
<script lang="ts">
	import { untrack } from 'svelte';
	import { Banner, Button, Dialog } from '$lib/components';
	import { drive } from '$lib/state/drive.svelte';
	import { sharing } from '$lib/state/sharing.svelte';
	import { describeDriveError } from '../errors';
	import { editorFor } from '../editors';
	import { canComment, canWrite, isOwner } from '$lib/sharing/roles';
	import { FileCommentsState } from '$lib/state/comments.svelte';
	import { inferType } from '../kinds';
	import { viewerFor } from '../viewers/kinds';
	import type { VerifiedVersion } from '../download/reader';
	import ViewerStage, { type ViewerSource } from './ViewerStage.svelte';

	const node = $derived(drive.viewing);
	const kind = $derived(node === null ? null : viewerFor(node));
	let former = $state(false);

	const source = $derived.by<ViewerSource | null>(() => {
		const opening = node;
		const core = drive.core;
		if (opening === null || core === null) return null;
		const version = async (): Promise<VerifiedVersion> => {
			const verified = await core.openVersion(opening);
			former = verified.formerAuthor;
			return verified;
		};
		return {
			media: async () => core.mediaUrl(opening, await version()),
			blob: async (options) => core.readBlob(opening, await version(), options)
		};
	});

	$effect(() => {
		void node;
		former = false;
	});

	// The file's comments, beside it on demand; the panel's code comes with the first look.
	let commentsOpen = $state(false);
	const viewingId = $derived(node?.id ?? null);
	const comments = $derived(
		viewingId === null
			? null
			: new FileCommentsState(
					viewingId,
					() => drive.core?.commentDeps ?? null,
					() => void sharing.markCommentsRead(viewingId)
				)
	);
	$effect(() => {
		const c = comments;
		void node?.commentSeq;
		untrack(() => void c?.load());
	});

	const describe = (e: unknown) => {
		sharing.warn(e);
		return describeDriveError(e);
	};
	const close = () => (drive.viewing = null);
</script>

{#if node && kind && source}
	<Dialog open title={node.name} width={1100} onclose={close}>
		{#if former}
			<div class="note">
				<Banner tone="warn" title="Written by someone who can no longer edit this">
					The signature on this version checks out, but its author has no edit rights here now. They
					probably had them when they wrote it. If they never did, the server is not to be trusted
					about this file.
				</Banner>
			</div>
		{/if}
		<ViewerStage file={node} {kind} {source} {describe} />
		{#if commentsOpen && comments}
			<div class="comments">
				{#await import('$lib/comments/ui/CommentsPanel.svelte') then { default: CommentsPanel }}
					<CommentsPanel
						{comments}
						canComment={canComment(node)}
						canResolve={canWrite(node)}
						owner={isOwner(node)}
						draft={null}
					/>
				{/await}
			</div>
		{/if}
		{#snippet footer()}
			<span class="type">{inferType(node.name, node.type)}</span>
			<Button
				icon="comment"
				variant="ghost"
				aria-pressed={commentsOpen}
				onclick={() => (commentsOpen = !commentsOpen)}
				>Comments{comments && comments.open.length > 0 ? ` (${comments.open.length})` : ''}</Button
			>
			{#if editorFor(node.name) !== null && canWrite(node)}
				<Button icon="pencil" onclick={() => node && drive.edit(node)}>Edit</Button>
			{/if}
			<Button icon="download" onclick={() => node && drive.download(node)}>Download</Button>
		{/snippet}
	</Dialog>
{/if}

<style>
	.note {
		margin-bottom: 12px;
	}

	.comments {
		margin-top: 12px;
		border-top: 1px solid var(--border);
	}

	.type {
		margin-right: auto;
		align-self: center;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-muted);
	}
</style>
