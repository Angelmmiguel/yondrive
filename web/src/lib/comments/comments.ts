/**
 * The comments on one file, read and written for one unlocked session. A comment
 * is believed only once its signature checks against its author's pinned key, and
 * its author is shown as able to comment only while the owner or a grant says so;
 * an anchor is believed only from the thread's author or from someone who may edit.
 * Everything is built through the `Sealer`, so the same code runs in suite `none`,
 * where bodies are readable JSON and there are no signatures to check.
 */
import type { Api } from '$lib/api/client';
import { isApiError, type Comment, type KeyLink } from '$lib/api/types';
import { SealError } from '$lib/crypto/aead';
import { decodeBase64, encodeBase64 } from '$lib/crypto/encoding';
import type { Sealer, UserKeys } from '$lib/crypto/sealer';
import type { AuthorKeys } from '$lib/drive/download/reader';
import { newId } from '$lib/drive/ids';
import type { DriveTree } from '$lib/drive/tree';

import { bodyOf, parseAnchor, parseBody, type Anchor } from './anchor';

export interface CommentDeps {
	api: Pick<
		Api,
		| 'listComments'
		| 'createComment'
		| 'updateComment'
		| 'deleteComment'
		| 'updateCommentAnchor'
		| 'resolveComment'
	>;
	sealer: Sealer;
	keys: () => UserKeys;
	userId: () => string;
	tree: Pick<DriveTree, 'nodeKey' | 'keyAt' | 'generationOf' | 'refresh'>;
	/** A signer's keys, or a refusal; see `Sharing.signerKeys`. */
	signerKeys: (userId: string, nodeId: string, need: 'edit' | 'comment') => Promise<AuthorKeys>;
}

/** One comment as a screen shows it. Its text is someone else's: plain text, never markup. */
export interface CommentView {
	id: string;
	threadId: string;
	authorId: string;
	authorName: string;
	text: string;
	createdAt: number;
	editedAt: number | null;
	/** Written by this user. */
	mine: boolean;
	/** Its signature checks, but its author may no longer comment here. */
	former: boolean;
}

export interface Thread {
	id: string;
	first: CommentView;
	replies: CommentView[];
	/** Null for a thread about the whole file, or one whose anchor did not check. */
	anchor: Anchor | null;
	/** It had an anchor that did not open or check. */
	anchorRefused: boolean;
	resolved: boolean;
	resolvedBy: string | null;
}

export interface FileComments {
	threads: Thread[];
	/** Comments left out because they did not open or their signature did not check. */
	refused: number;
}

/** The links of a page's key chain that reach `generation`. */
function chainTo(chain: readonly KeyLink[], generation: number): KeyLink[] {
	return chain.filter((link) => link.generation >= generation);
}

/**
 * Whether a failure says something about the comment, rather than the connection. A
 * contact whose keys changed is not one: it goes on to the warning that asks about it.
 */
function untrusted(e: unknown): boolean {
	return e instanceof SealError;
}

/** Ids are 32 lowercase hex characters on the wire; here it is enough that one is plainly an id. */
const ID = /^[0-9a-z]{32}$/;

function generationOf(value: number): number {
	if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) throw new SealError('format');
	return value;
}

/** An id from the server, which enters what is opened and checked. */
function idOf(value: string): string {
	if (!ID.test(value)) throw new SealError('format');
	return value;
}

/** Bytes from the server: anything that is not base64 is a comment that does not open. */
function bytesOf(text: string) {
	try {
		return decodeBase64(text);
	} catch {
		throw new SealError('format');
	}
}

/** Every comment on a file, verified, in threads, oldest first. */
export async function loadComments(nodeId: string, given: CommentDeps): Promise<FileComments> {
	const { api } = given;
	const pages: { comments: Comment[]; chain: KeyLink[] }[] = [];
	let cursor: string | undefined;
	do {
		const page = await api.listComments(nodeId, { cursor });
		pages.push({ comments: page.comments, chain: page.key_chain ?? [] });
		cursor = page.next_cursor;
	} while (cursor !== undefined);

	// One look at who may write per person, however many comments they wrote.
	const asked = new Map<string, Promise<AuthorKeys>>();
	const signerKeys: CommentDeps['signerKeys'] = (user, node, need) => {
		const known = asked.get(`${user}/${need}`);
		if (known !== undefined) return known;
		const keys = given.signerKeys(user, node, need);
		asked.set(`${user}/${need}`, keys);
		return keys;
	};
	const deps = { ...given, signerKeys };

	const firsts = new Map<string, { record: Comment; chain: KeyLink[]; view: CommentView }>();
	const replies: { record: Comment; view: CommentView }[] = [];
	let refused = 0;
	for (const { comments, chain } of pages) {
		for (const record of comments) {
			let view: CommentView;
			try {
				view = await openComment(record, nodeId, chain, deps);
			} catch (e) {
				if (!untrusted(e)) throw e;
				refused++;
				continue;
			}
			if (record.thread_id === record.id) firsts.set(record.id, { record, chain, view });
			else replies.push({ record, view });
		}
	}

	const threads = new Map<string, Thread>();
	for (const { record, chain, view } of firsts.values()) {
		const { anchor, refused: anchorRefused } = await openAnchor(record, nodeId, chain, deps);
		threads.set(record.id, {
			id: record.id,
			first: view,
			replies: [],
			anchor,
			anchorRefused,
			resolved: record.resolved,
			resolvedBy: record.resolved_by ?? null
		});
	}
	for (const { record, view } of replies) {
		const thread = threads.get(record.thread_id);
		// A reply to a thread that did not check stands for nothing either.
		if (thread === undefined) refused++;
		else thread.replies.push(view);
	}
	return { threads: [...threads.values()], refused };
}

async function openComment(
	record: Comment,
	nodeId: string,
	chain: readonly KeyLink[],
	deps: CommentDeps
): Promise<CommentView> {
	const { sealer, tree, userId, signerKeys } = deps;
	if (record.node_id !== nodeId) throw new SealError('format');
	const ref = {
		nodeId,
		threadId: idOf(record.thread_id),
		commentId: idOf(record.id),
		generation: generationOf(record.key_generation)
	};
	const sealed = bytesOf(record.sealed_body);
	const author = await signerKeys(idOf(record.author_id), nodeId, 'comment');
	sealer.verifyComment(
		{ ...ref, authorId: record.author_id, sealed },
		bytesOf(record.signature),
		author
	);
	const key = await tree.keyAt(
		nodeId,
		record.key_generation,
		chainTo(chain, record.key_generation)
	);
	const text = parseBody(sealer.openCommentBody(key, ref, sealed));
	if (text === null) throw new SealError('format');
	return {
		id: record.id,
		threadId: record.thread_id,
		authorId: record.author_id,
		authorName: record.author_username,
		text,
		createdAt: Date.parse(record.created_at),
		editedAt: record.edited_at === undefined ? null : Date.parse(record.edited_at),
		mine: record.author_id === userId(),
		former: author.former === true
	};
}

/**
 * A thread's anchor, from its author or from someone who may edit. One that does not
 * check leaves the thread about nothing in particular, and says so.
 */
async function openAnchor(
	record: Comment,
	nodeId: string,
	chain: readonly KeyLink[],
	deps: CommentDeps
): Promise<{ anchor: Anchor | null; refused: boolean }> {
	const given = record.anchor;
	if (given === undefined) return { anchor: null, refused: false };
	const { sealer, tree, signerKeys } = deps;
	try {
		const ref = { nodeId, threadId: record.id, generation: generationOf(given.key_generation) };
		const sealed = bytesOf(given.sealed_anchor);
		const need = given.signer_id === record.author_id ? 'comment' : 'edit';
		const signer = await signerKeys(idOf(given.signer_id), nodeId, need);
		if (signer.former) throw new SealError('signature');
		sealer.verifyAnchor(
			{ ...ref, signerId: given.signer_id, sealed },
			bytesOf(given.signature),
			signer
		);
		const key = await tree.keyAt(
			nodeId,
			given.key_generation,
			chainTo(chain, given.key_generation)
		);
		const anchor = parseAnchor(sealer.openCommentAnchor(key, ref, sealed));
		if (anchor === null) throw new SealError('format');
		return { anchor, refused: false };
	} catch (e) {
		if (!untrusted(e)) throw e;
		return { anchor: null, refused: true };
	}
}

/**
 * Seals with the node's current key, and seals again with the next one if a rotation
 * gets in between.
 */
async function withCurrentKey<T>(
	nodeId: string,
	deps: CommentDeps,
	write: (key: Uint8Array, generation: number) => Promise<T>
): Promise<T> {
	const { tree } = deps;
	for (let tried = 1; ; tried++) {
		const key = await tree.nodeKey(nodeId);
		const generation = tree.generationOf(nodeId) ?? 1;
		try {
			return await write(key, generation);
		} catch (e) {
			if (tried >= 3 || !isApiError(e, 'key_generation_conflict')) throw e;
			await tree.refresh(nodeId);
		}
	}
}

function sealedBody(
	nodeId: string,
	threadId: string,
	commentId: string,
	text: string,
	key: Uint8Array,
	generation: number,
	deps: CommentDeps
) {
	const { sealer, keys, userId } = deps;
	const ref = { nodeId, threadId, commentId, generation };
	const sealed = sealer.sealCommentBody(key, ref, bodyOf(text));
	const signature = sealer.signComment({ ...ref, authorId: userId(), sealed }, keys());
	return {
		key_generation: generation,
		sealed_body: encodeBase64(sealed),
		signature: encodeBase64(signature)
	};
}

function sealedAnchor(
	nodeId: string,
	threadId: string,
	anchor: Anchor,
	key: Uint8Array,
	generation: number,
	deps: CommentDeps
) {
	const { sealer, keys, userId } = deps;
	const ref = { nodeId, threadId, generation };
	const sealed = sealer.sealCommentAnchor(key, ref, anchor);
	const signature = sealer.signAnchor({ ...ref, signerId: userId(), sealed }, keys());
	return {
		key_generation: generation,
		sealed_anchor: encodeBase64(sealed),
		signature: encodeBase64(signature)
	};
}

/** Starts a thread, about a part of the file or, with no anchor, the whole of it. */
export async function startThread(
	nodeId: string,
	text: string,
	anchor: Anchor | null,
	deps: CommentDeps
): Promise<string> {
	const id = newId();
	await withCurrentKey(nodeId, deps, (key, generation) =>
		deps.api.createComment(nodeId, {
			id,
			...sealedBody(nodeId, id, id, text, key, generation, deps),
			...(anchor === null
				? {}
				: { anchor: sealedAnchor(nodeId, id, anchor, key, generation, deps) })
		})
	);
	return id;
}

export async function reply(
	nodeId: string,
	threadId: string,
	text: string,
	deps: CommentDeps
): Promise<string> {
	const id = newId();
	await withCurrentKey(nodeId, deps, (key, generation) =>
		deps.api.createComment(nodeId, {
			id,
			thread_id: threadId,
			...sealedBody(nodeId, threadId, id, text, key, generation, deps)
		})
	);
	return id;
}

/** Replaces the text of this user's own comment. */
export async function editComment(
	nodeId: string,
	comment: Pick<CommentView, 'id' | 'threadId'>,
	text: string,
	deps: CommentDeps
): Promise<void> {
	await withCurrentKey(nodeId, deps, (key, generation) =>
		deps.api.updateComment(
			nodeId,
			comment.id,
			sealedBody(nodeId, comment.threadId, comment.id, text, key, generation, deps)
		)
	);
}

export async function deleteComment(
	nodeId: string,
	commentId: string,
	deps: Pick<CommentDeps, 'api'>
): Promise<void> {
	await deps.api.deleteComment(nodeId, commentId);
}

export async function resolveThread(
	nodeId: string,
	threadId: string,
	resolved: boolean,
	deps: Pick<CommentDeps, 'api'>
): Promise<void> {
	await deps.api.resolveComment(nodeId, threadId, { resolved });
}

/** Moves a thread's anchor, signed by this user, who may edit. */
export async function moveAnchor(
	nodeId: string,
	threadId: string,
	anchor: Anchor,
	deps: CommentDeps
): Promise<void> {
	await withCurrentKey(nodeId, deps, (key, generation) =>
		deps.api.updateCommentAnchor(
			nodeId,
			threadId,
			sealedAnchor(nodeId, threadId, anchor, key, generation, deps)
		)
	);
}

/** The words of a file's comments, for search on this device. */
export async function commentText(nodeId: string, deps: CommentDeps): Promise<string> {
	const { threads } = await loadComments(nodeId, deps);
	return threads
		.flatMap((t) => [
			t.anchor?.kind === 'text' ? t.anchor.quote : '',
			t.first.text,
			...t.replies.map((r) => r.text)
		])
		.filter((text) => text !== '')
		.join('\n');
}
