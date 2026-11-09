import { describe, expect, it, vi } from 'vitest';
import { isApiError, type Comment } from '$lib/api/types';
import { ContactKeysChangedError } from '$lib/sharing/contacts';
import { deriveLinkRoot } from '$lib/crypto/kdf';
import { sealerFor, SUITE_E2E, SUITE_NONE, type Suite } from '$lib/crypto/sealer';
import { Drive } from '$lib/drive/drive';
import { inlineFramePool } from '$lib/drive/frame-pool';
import { openNodes } from '$lib/drive/open-nodes';
import { memoryResumeStore } from '$lib/drive/upload/resume';
import { memoryPinStorage } from '$lib/sharing/contacts';
import { memoryRotationJobs } from '$lib/sharing/rotation';
import {
	CHEAP_KDF,
	fakeDriveServer,
	fakeFile,
	fakeUser,
	patterned,
	SUITES,
	testPublicKeys,
	USER_ID
} from '$lib/testing/drive';
import type { Anchor } from './anchor';
import {
	commentText,
	deleteComment,
	editComment,
	loadComments,
	moveAnchor,
	reply,
	resolveThread,
	startThread
} from './comments';

const ALICE = USER_ID;
const BOB = 'b'.repeat(32);
const CAROL = 'c'.repeat(32);
const DAVE = 'd'.repeat(32);

const ANCHOR: Anchor = {
	kind: 'text',
	quote: 'the plan',
	before: 'This is ',
	after: '.',
	block: 0
};

/** Four people on one server: alice owns, bob comments, carol views, dave edits. */
async function world(suite: Suite) {
	const server = fakeDriveServer(suite);
	const sealer = sealerFor(suite);
	const person = (id: string, username: string) => {
		const keys = fakeUser(suite);
		server.users.set(id, { id, username, public_keys: testPublicKeys(keys) });
		const drive = new Drive({
			api: server.as(id),
			sealer,
			keys: () => keys,
			userId: () => id,
			open: async (key, parent, records) => openNodes(sealer, key, parent, records),
			pool: inlineFramePool(sealer),
			resume: memoryResumeStore(),
			streams: { open: async () => null, release: () => {}, clear: () => {}, stop: () => {} },
			saveUrl: () => {},
			saveBlob: () => {},
			pins: memoryPinStorage(),
			rotationJobs: memoryRotationJobs(),
			deriveLinkRoot: async (password, params) => deriveLinkRoot(password, params),
			linkKdf: CHEAP_KDF,
			sleep: async () => {}
		});
		drive.engine.frameSize = 1024;
		return { id, drive };
	};
	const alice = person(ALICE, 'alice');
	const bob = person(BOB, 'bob');
	const carol = person(CAROL, 'carol');
	const dave = person(DAVE, 'dave');
	for (const p of [alice, bob, carol, dave]) await p.drive.start();
	const root = alice.drive.tree.rootId as string;
	const folder = await alice.drive.tree.createFolder(root, 'Project');
	alice.drive.queue.addFiles(folder.id, [{ file: fakeFile('plan.docx', patterned(100)) }]);
	await vi.waitFor(() => expect(alice.drive.queue.active).toBe(false), { interval: 5 });
	const file = alice.drive.tree.childrenOf(folder.id)[0];
	await alice.drive.sharing.share(folder.id, 'bob', 'commenter');
	await alice.drive.sharing.share(folder.id, 'carol', 'viewer');
	await alice.drive.sharing.share(folder.id, 'dave', 'editor');
	for (const p of [bob, carol, dave]) {
		await p.drive.sharing.refreshShared();
		await p.drive.tree.resolve(folder.id);
		await p.drive.tree.loadFolder(folder.id);
	}
	return { server, alice, bob, carol, dave, folder, file };
}

describe.each(SUITES)('comments in mode %s', (_, suite) => {
	it('lets commenters and editors write, viewers read, and editors resolve', async () => {
		const w = await world(suite);
		const id = w.file.id;
		const thread = await startThread(id, 'Is this right?', ANCHOR, w.bob.drive.commentDeps);
		await reply(id, thread, 'Yes, it is.', w.alice.drive.commentDeps);

		const seen = await loadComments(id, w.carol.drive.commentDeps);
		expect(seen.refused).toBe(0);
		expect(seen.threads).toHaveLength(1);
		const [t] = seen.threads;
		expect(t.first).toMatchObject({ text: 'Is this right?', authorName: 'bob', mine: false });
		expect(t.anchor).toEqual(ANCHOR);
		expect(t.replies.map((r) => r.text)).toEqual(['Yes, it is.']);

		await expect(startThread(id, 'Me too', null, w.carol.drive.commentDeps)).rejects.toSatisfy(
			(e) => isApiError(e, 'forbidden')
		);
		await expect(resolveThread(id, thread, true, w.bob.drive.commentDeps)).rejects.toSatisfy((e) =>
			isApiError(e, 'forbidden')
		);
		await resolveThread(id, thread, true, w.dave.drive.commentDeps);
		await editComment(
			id,
			{ id: thread, threadId: thread },
			'Is this still right?',
			w.bob.drive.commentDeps
		);
		const after = await loadComments(id, w.bob.drive.commentDeps);
		expect(after.threads[0]).toMatchObject({ resolved: true, resolvedBy: DAVE });
		expect(after.threads[0].first).toMatchObject({ text: 'Is this still right?', mine: true });
		expect(after.threads[0].first.editedAt).not.toBeNull();

		expect(await commentText(id, w.carol.drive.commentDeps)).toContain('Yes, it is.');
		expect(w.server.nodes.get(id)?.comment_seq).toBe(4);

		await deleteComment(id, thread, w.alice.drive.commentDeps);
		expect((await loadComments(id, w.bob.drive.commentDeps)).threads).toEqual([]);
	});

	it('takes an anchor moved by an editor, and not one signed by anyone else', async () => {
		const w = await world(suite);
		const id = w.file.id;
		const cell: Anchor = { kind: 'cell', sheet: 'Sheet1', row: 4, col: 1 };
		const thread = await startThread(id, 'This cell', cell, w.bob.drive.commentDeps);
		await moveAnchor(id, thread, { ...cell, row: 6 }, w.dave.drive.commentDeps);
		const moved = await loadComments(id, w.carol.drive.commentDeps);
		expect(moved.threads[0].anchor).toEqual({ ...cell, row: 6 });

		// The server names a commenter who did not write the thread as the anchor's signer.
		w.server.users.set(CAROL, { ...w.server.users.get(CAROL)!, username: 'carol' });
		w.server.state.tamperComment = (c) =>
			c.anchor ? { ...c, anchor: { ...c.anchor, signer_id: CAROL } } : c;
		const refused = await loadComments(id, w.alice.drive.commentDeps);
		expect(refused.threads[0]).toMatchObject({ anchor: null, anchorRefused: true });
	});

	it('reads comments sealed before a rotation', async () => {
		const w = await world(suite);
		const id = w.file.id;
		await startThread(id, 'Before', null, w.bob.drive.commentDeps);
		const grant = [...w.server.grants.values()].find((g) => g.grantee_id === CAROL)!;
		await w.alice.drive.sharing.revoke(grant.id, w.folder.id);
		await w.bob.drive.tree.refresh(id);
		await startThread(id, 'After', null, w.bob.drive.commentDeps);
		const seen = await loadComments(id, w.dave.drive.commentDeps);
		expect(seen.refused).toBe(0);
		expect(seen.threads.map((t) => t.first.text)).toEqual(['Before', 'After']);
	});
});

describe('a forged author', () => {
	it('is refused with keys', async () => {
		const w = await world(SUITE_E2E);
		await startThread(w.file.id, 'Mine', null, w.bob.drive.commentDeps);
		w.server.state.tamperComment = (c) => ({ ...c, author_id: DAVE, author_username: 'dave' });
		const seen = await loadComments(w.file.id, w.alice.drive.commentDeps);
		expect(seen).toEqual({ threads: [], refused: 1 });
	});

	it('shows as someone who may not comment without keys', async () => {
		const w = await world(SUITE_NONE);
		await startThread(w.file.id, 'Mine', null, w.bob.drive.commentDeps);
		w.server.state.tamperComment = (c) => ({ ...c, author_id: 'e'.repeat(32) });
		const seen = await loadComments(w.file.id, w.alice.drive.commentDeps);
		expect(seen.threads[0].first.former).toBe(true);
	});
});

describe('what the server sends', () => {
	it('takes a contact whose keys changed to the warning, not to the refused', async () => {
		const w = await world(SUITE_E2E);
		await startThread(w.file.id, 'Mine', null, w.bob.drive.commentDeps);
		const changed = new ContactKeysChangedError(
			BOB,
			'bob',
			{ x25519: new Uint8Array(0), ed25519: new Uint8Array(0) },
			{ x25519: new Uint8Array(0), ed25519: new Uint8Array(0) }
		);
		const deps = { ...w.alice.drive.commentDeps, signerKeys: async () => Promise.reject(changed) };
		await expect(loadComments(w.file.id, deps)).rejects.toBe(changed);
	});

	it('refuses ids, generations and bytes that are not what they should be', async () => {
		const w = await world(SUITE_NONE);
		await startThread(w.file.id, 'Mine', null, w.bob.drive.commentDeps);
		for (const tamper of [
			(c: Comment) => ({ ...c, id: '' }),
			(c: Comment) => ({ ...c, author_id: 'not an id' }),
			(c: Comment) => ({ ...c, key_generation: -1 }),
			(c: Comment) => ({ ...c, sealed_body: '%%%' })
		]) {
			w.server.state.tamperComment = tamper;
			expect(await loadComments(w.file.id, w.alice.drive.commentDeps)).toEqual({
				threads: [],
				refused: 1
			});
		}
	});

	it('keeps others’ replies from a thread’s author, and lets the owner delete it', async () => {
		const w = await world(SUITE_NONE);
		const thread = await startThread(w.file.id, 'Mine', null, w.bob.drive.commentDeps);
		await reply(w.file.id, thread, 'Yours', w.dave.drive.commentDeps);
		await expect(deleteComment(w.file.id, thread, w.bob.drive.commentDeps)).rejects.toSatisfy((e) =>
			isApiError(e, 'comment_has_replies')
		);
		await deleteComment(w.file.id, thread, w.alice.drive.commentDeps);
		expect((await loadComments(w.file.id, w.alice.drive.commentDeps)).threads).toEqual([]);
	});
});
