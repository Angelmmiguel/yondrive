import { describe, expect, it, vi } from 'vitest';
import { sealerFor } from '$lib/crypto/sealer';
import { Drive } from '$lib/drive/drive';
import { inlineFramePool } from '$lib/drive/frame-pool';
import { openNodes } from '$lib/drive/open-nodes';
import { memoryResumeStore } from '$lib/drive/upload/resume';
import { memorySegmentCache } from '$lib/search/cache';
import { fakeDriveServer, fakeUser, SUITES, USER_ID } from '$lib/testing/drive';
import { backlinks } from './index';
import { NotesIndexer, sealedNotesCache, NOTES_INDEX_ID } from './indexer';
import { isNotesRoot, parseNoteMeta, titleOf } from './model';
import { Notes } from './notes';
import { nodeHref } from './parse';

function wired(suite: (typeof SUITES)[number][1], now = () => new Date(2026, 10, 7, 9).getTime()) {
	const server = fakeDriveServer(suite);
	const sealer = sealerFor(suite);
	const keys = fakeUser(suite);
	const drive = new Drive({
		api: server.api,
		sealer,
		keys: () => keys,
		userId: () => USER_ID,
		open: async (key, parent, records) => openNodes(sealer, key, parent, records),
		pool: inlineFramePool(sealer),
		resume: memoryResumeStore(),
		streams: { open: async () => null, release: vi.fn(), clear: vi.fn(), stop: vi.fn() },
		saveUrl: vi.fn(),
		saveBlob: vi.fn(),
		sleep: async () => {}
	});
	drive.engine.frameSize = 1024;
	const notes = new Notes({
		tree: drive.tree,
		save: { tree: drive.tree, engine: drive.engine, now },
		read: async (node) =>
			new Uint8Array(
				await (await drive.readBlob(node, await drive.openVersion(node))).arrayBuffer()
			),
		now
	});
	return { server, sealer, keys, drive, notes };
}

describe.each(SUITES)('notes in mode %s', (_, suite) => {
	it('keeps notes in one folder under the root, made once and marked in its metadata', async () => {
		const { drive, notes } = wired(suite);
		await drive.start();
		const root = await notes.ensureRoot();
		expect(isNotesRoot(root)).toBe(true);
		expect(root.parentId).toBe(drive.tree.rootId);
		expect((await notes.ensureRoot()).id).toBe(root.id);
		expect(drive.tree.childrenOf(drive.tree.rootId as string)).toHaveLength(1);
	});

	it('makes notes and notebooks, and links survive a rename', async () => {
		const { drive, notes } = wired(suite);
		await drive.start();
		const root = await notes.ensureRoot();
		const work = await notes.createNotebook(root.id, 'Work');
		expect(work.raw.notebook).toEqual({ color: 'blue' });
		const plan = await notes.createNote(work.id, 'Plan', 'The plan.\n', { tags: ['q1'] });
		const log = await notes.createNote(root.id, 'Log', `See [Plan](${nodeHref(plan.id)}).\n`);
		expect(parseNoteMeta(plan.raw).tags).toEqual(['q1']);
		expect(
			notes
				.all(root.id)
				.map((n) => titleOf(n.node.name))
				.sort()
		).toEqual(['Log', 'Plan']);

		const renamed = await notes.renameNote(plan.id, 'Q1 plan');
		expect(renamed.name).toBe('Q1 plan.md');
		const index = new NotesIndexer({
			cache: sealedNotesCache(memorySegmentCache(), sealerFor(suite), new Uint8Array(32)),
			read: async (id) => notes.readText(drive.tree.nodes.get(id)!),
			onchange: () => {}
		});
		await index.reconcile(
			notes
				.all(root.id)
				.map(({ node }) => ({ id: node.id, version: node.currentVersion, size: node.size }))
		);
		const refs = notes.all(root.id).map(({ node }) => ({ id: node.id, title: titleOf(node.name) }));
		expect(backlinks(index.index, plan.id, refs).map((b) => b.from)).toEqual([log.id]);
		index.stop();
	});

	it('numbers a title that is taken in the notebook', async () => {
		const { drive, notes } = wired(suite);
		await drive.start();
		const root = await notes.ensureRoot();
		await notes.createNote(root.id, 'Ideas');
		const second = await notes.createNote(root.id, 'Ideas');
		expect(second.name).toBe('Ideas (2).md');
		const third = await notes.createNote(root.id, 'Other');
		expect((await notes.renameNote(third.id, 'ideas')).name).toBe('ideas (3).md');
	});

	it('makes today’s note once, in the Journal notebook', async () => {
		const { drive, notes } = wired(suite);
		await drive.start();
		const root = await notes.ensureRoot();
		const today = await notes.todayNote(root.id);
		expect(today.name).toBe('2026-11-07.md');
		expect(parseNoteMeta(today.raw).daily).toBe('2026-11-07');
		expect(drive.tree.nodes.get(today.parentId!)?.name).toBe('Journal');
		expect((await notes.todayNote(root.id)).id).toBe(today.id);
		expect(await notes.readText(today)).toContain('## Plan for 2026-11-07');
	});

	it('links an unlinked mention in the other note', async () => {
		const { drive, notes } = wired(suite);
		await drive.start();
		const root = await notes.ensureRoot();
		const target = await notes.createNote(root.id, 'Sync engine', 'Design.\n');
		const other = await notes.createNote(root.id, 'Diary', 'The sync engine beta works.\n');
		expect(await notes.linkMention(other, 'Sync engine', target.id)).toBe(true);
		const after = drive.tree.nodes.get(other.id)!;
		expect(await notes.readText(after)).toBe(
			`The [sync engine](${nodeHref(target.id)}) beta works.\n`
		);
	});

	it('stores the index sealed on the device, and reads it back', async () => {
		const store = memorySegmentCache();
		const key = new Uint8Array(32).fill(7);
		const cache = sealedNotesCache(store, sealerFor(suite), key);
		const indexer = new NotesIndexer({ cache, read: async () => 'A #tag\n', onchange: () => {} });
		await indexer.reconcile([{ id: 'n'.repeat(32), version: 'v1', size: 7 }]);
		await indexer.flush();
		const stored = store.items.get(NOTES_INDEX_ID)!;
		expect(new TextDecoder().decode(stored).includes('#tag')).toBe(!sealerFor(suite).encrypted);
		const again = await cache.load();
		expect(again.get('n'.repeat(32))?.tags).toEqual(['tag']);
		indexer.stop();
	});
});
