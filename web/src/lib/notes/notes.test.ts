import { describe, expect, it, vi } from 'vitest';
import { sealerFor } from '$lib/crypto/sealer';
import { Drive } from '$lib/drive/drive';
import { inlineFramePool } from '$lib/drive/frame-pool';
import { openNodes } from '$lib/drive/open-nodes';
import { memoryResumeStore } from '$lib/drive/upload/resume';
import { memorySegmentCache } from '$lib/search/cache';
import { fakeDriveServer, fakeUser, SUITES, USER_ID } from '$lib/testing/drive';
import { entryData, readZip } from '$lib/formats/zip';
import { backlinks, NoteRefs } from './index';
import { entryId, NotesIndexer, sealedNotesCache, NOTES_INDEX_ID } from './indexer';
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
		const refs = new NoteRefs(
			notes.all(root.id).map(({ node }) => ({ id: node.id, title: titleOf(node.name) }))
		);
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

	it('exports every note with its links rewritten and its files beside it', async () => {
		const { drive, notes } = wired(suite);
		await drive.start();
		const root = await notes.ensureRoot();
		const work = await notes.createNotebook(root.id, 'Work');
		const pic = await notes.attach(work.id, 'sketch.png', new Uint8Array([137, 80, 78, 71]), 'x');
		const plan = await notes.createNote(work.id, 'Plan', `![sketch](${nodeHref(pic.id)})\n`);
		await notes.createNote(root.id, 'Index', `[Plan](${nodeHref(plan.id)})\n`);
		const zip = readZip(await notes.exportAll(root.id));
		const text = async (name: string) => new TextDecoder().decode(await entryData(zip.get(name)!));
		expect(zip.entries.map((e) => e.name).sort()).toEqual([
			'Index.md',
			'Work/Plan.md',
			'Work/sketch.png'
		]);
		expect(await text('Index.md')).toBe('[Plan](Work/Plan.md)\n');
		expect(await text('Work/Plan.md')).toBe('![sketch](sketch.png)\n');
	});

	it('stores the index sealed on the device, an entry per note, and reads it back', async () => {
		const store = memorySegmentCache();
		const sealer = sealerFor(suite);
		const key = new Uint8Array(32).fill(7);
		const cache = sealedNotesCache(store, sealer, key);
		const N1 = '1'.repeat(32);
		const N2 = '2'.repeat(32);
		// What an earlier build kept: every entry in one blob.
		store.items.set(NOTES_INDEX_ID, new Uint8Array([1]));
		const indexer = new NotesIndexer({ cache, read: async () => 'A #tag\n', onchange: () => {} });
		await indexer.reconcile([
			{ id: N1, version: 'v1', size: 7 },
			{ id: N2, version: 'v1', size: 7 }
		]);
		await indexer.flush();
		expect([...store.items.keys()].sort()).toEqual([entryId(N1), entryId(N2)]);
		const stored = store.items.get(entryId(N1))!;
		expect(new TextDecoder().decode(stored).includes('#tag')).toBe(!sealer.encrypted);
		const again = await cache.load();
		expect(again.get(N1)?.tags).toEqual(['tag']);

		// A save writes the note that changed, and nothing else.
		const put = vi.spyOn(store, 'put');
		const del = vi.spyOn(store, 'delete');
		indexer.saved(N2, 'v2', 'B #other\n');
		await indexer.flush();
		expect(put.mock.calls.map(([id]) => id)).toEqual([entryId(N2)]);
		await indexer.reconcile([{ id: N2, version: 'v2', size: 9 }]);
		await indexer.flush();
		expect(del.mock.calls.map(([id]) => id)).toEqual([entryId(N1)]);
		expect(put).toHaveBeenCalledTimes(1);
		indexer.stop();

		// Each entry is bound to its note: one put in another's place does not open as it.
		if (sealer.encrypted) {
			store.items.set(entryId(N1), store.items.get(entryId(N2))!);
			const swapped = await cache.load();
			expect(swapped.get(N1)).toBeUndefined();
			expect(swapped.get(N2)?.tags).toEqual(['other']);
			expect(store.items.has(entryId(N1))).toBe(false);
		}
	});
});
