import { describe, expect, it, vi } from 'vitest';
import { ApiError, isApiError } from '$lib/api/types';
import { driveFixture, fakeFile, patterned, SUITES, TEST_FRAME, USER_ID } from '$lib/testing/drive';
import { UploadQueue } from './queue';
import { memoryResumeStore } from './resume';

const FRAME = TEST_FRAME;

async function queueOver(suite: (typeof SUITES)[number][1], options: { quota?: number } = {}) {
	const fixture = driveFixture(suite, options);
	await fixture.tree.start();
	const afterCommit = vi.fn();
	const queue = new UploadQueue({ tree: fixture.tree, engine: fixture.engine, afterCommit });
	return { ...fixture, queue, afterCommit, root: fixture.tree.rootId as string };
}

async function settled(queue: UploadQueue) {
	await vi.waitFor(() => expect(queue.active).toBe(false), { timeout: 5000, interval: 5 });
}

describe.each(SUITES)('the queue in mode %s', (_, suite) => {
	it('uploads files, reports progress and ends done', async () => {
		const { queue, tree, root, afterCommit } = await queueOver(suite);
		queue.addFiles(root, [
			{ file: fakeFile('a.txt', patterned(10)) },
			{ file: fakeFile('b.txt', patterned(FRAME + 1)) }
		]);
		expect(queue.items.map((i) => i.status)).toContain('uploading');
		await settled(queue);

		expect(queue.items.map((i) => [i.name, i.status, i.done])).toEqual([
			['a.txt', 'done', 10],
			['b.txt', 'done', FRAME + 1]
		]);
		expect(
			tree
				.childrenOf(root)
				.map((n) => n.name)
				.sort()
		).toEqual(['a.txt', 'b.txt']);
		expect(tree.childrenOf(root).find((n) => n.name === 'a.txt')).toMatchObject({
			size: 10,
			type: 'text/plain'
		});
		expect(afterCommit).toHaveBeenCalledTimes(2);
	});

	it('makes folders once, however many files pass through them', async () => {
		const { queue, tree, root, server } = await queueOver(suite);
		queue.addFiles(
			root,
			['1', '2', '3', '4', '5'].map((n) => ({
				file: fakeFile(`${n}.txt`, patterned(3)),
				path: ['Top', 'Sub']
			}))
		);
		await settled(queue);

		expect(queue.items.every((i) => i.status === 'done')).toBe(true);
		const top = tree.childrenOf(root);
		expect(top.map((n) => n.name)).toEqual(['Top']);
		const sub = tree.childrenOf(top[0].id);
		expect(sub.map((n) => n.name)).toEqual(['Sub']);
		expect(tree.childrenOf(sub[0].id)).toHaveLength(5);
		expect([...server.nodes.values()].filter((n) => n.kind === 'folder')).toHaveLength(3);
	});

	it('reuses a folder that exists, and makes empty ones', async () => {
		const { queue, tree, root } = await queueOver(suite);
		await tree.createFolder(root, 'Top');
		await queue.addFolders(root, [['Top', 'Empty']]);
		queue.addFiles(root, [{ file: fakeFile('x', patterned(1)), path: ['Top'] }]);
		await settled(queue);

		const top = tree.childrenOf(root)[0];
		expect(
			tree
				.childrenOf(top.id)
				.map((n) => n.name)
				.sort()
		).toEqual(['Empty', 'x']);
	});

	it('fails with the name conflict when the name holds a real file', async () => {
		const { queue, root } = await queueOver(suite);
		queue.addFiles(root, [{ file: fakeFile('same', patterned(1)) }]);
		await settled(queue);
		queue.addFiles(root, [{ file: fakeFile('SAME', patterned(2)) }]);
		await settled(queue);

		const failed = queue.items[1];
		expect(failed.status).toBe('failed');
		expect(isApiError(failed.error, 'name_conflict')).toBe(true);
	});

	it('takes over a name held by an upload that never finished', async () => {
		const { queue, tree, root } = await queueOver(suite);
		await tree.createFile(root, { name: 'held', type: '', size: 0, modified: 0 });
		queue.addFiles(root, [{ file: fakeFile('held', patterned(5)) }]);
		await settled(queue);

		expect(queue.items[0].status).toBe('done');
		expect(tree.childrenOf(root).map((n) => n.name)).toEqual(['held']);
	});

	it('over quota: says so and leaves no name behind', async () => {
		const { queue, tree, root, server } = await queueOver(suite, { quota: 5 });
		queue.addFiles(root, [{ file: fakeFile('big', patterned(10_000)) }]);
		await settled(queue);

		const item = queue.items[0];
		expect(item.status).toBe('failed');
		expect(isApiError(item.error, 'quota_exceeded')).toBe(true);
		expect(tree.childrenOf(root)).toEqual([]);
		expect([...server.nodes.values()].find((n) => n.kind === 'file')?.trashed_at).toBeTruthy();

		server.state.quota = 0;
		queue.retry(item.id);
		await settled(queue);
		expect(queue.items[0].status).toBe('done');
	});

	it('cancelling releases the reservation and the name', async () => {
		const { queue, tree, root, server } = await queueOver(suite);
		let hold: (() => void) | null = null;
		const original = server.api.putFrame;
		server.api.putFrame = (async (...args: Parameters<typeof original>) => {
			await new Promise<void>((resolve) => (hold = resolve));
			return original(...args);
		}) as typeof original;
		queue.addFiles(root, [{ file: fakeFile('gone', patterned(FRAME * 2)) }]);
		await vi.waitFor(() => expect(hold).not.toBeNull(), { interval: 5 });

		await queue.cancel(queue.items[0].id);
		expect(queue.items[0].status).toBe('cancelled');
		expect(server.uploads.size).toBe(0);
		expect(tree.childrenOf(root)).toEqual([]);
		(hold as unknown as () => void)();

		server.api.putFrame = original;
		queue.addFiles(root, [{ file: fakeFile('gone', patterned(5)) }]);
		await settled(queue);
		expect(tree.childrenOf(root).map((n) => n.name)).toEqual(['gone']);
		queue.clearFinished();
		expect(queue.items).toEqual([]);
	});

	it('marks a failed upload, and a retry goes on from where it was', async () => {
		const { queue, root, server } = await queueOver(suite);
		server.state.failFrame = (index) => (index === 1 ? new ApiError(400, 'bad_request') : null);
		queue.addFiles(root, [{ file: fakeFile('later', patterned(FRAME + 1)) }]);
		await settled(queue);
		expect(queue.items[0].status).toBe('failed');
		expect(server.uploads.size).toBe(1);

		server.state.failFrame = null;
		queue.retry(queue.items[0].id);
		await settled(queue);
		expect(queue.items[0].status).toBe('done');
		expect(server.uploads.size).toBe(0);
	});

	it('uploads a new version of a file, keeping the old one', async () => {
		const { queue, tree, root, server } = await queueOver(suite);
		queue.addFiles(root, [{ file: fakeFile('doc.txt', patterned(3)) }]);
		await settled(queue);
		const node = tree.childrenOf(root)[0];

		queue.addVersion(node.id, fakeFile('anything', patterned(7)));
		await settled(queue);

		expect(server.versions.get(node.id)).toHaveLength(2);
		expect(tree.nodes.get(node.id)).toMatchObject({ size: 7, name: 'doc.txt' });
	});

	it('after a reload: lists it as paused, resumes with the same file, refuses another', async () => {
		const resume = memoryResumeStore();
		const fixture = driveFixture(suite, { resume });
		await fixture.tree.start();
		const root = fixture.tree.rootId as string;
		const first = new UploadQueue({ tree: fixture.tree, engine: fixture.engine });
		fixture.server.state.failFrame = (index) =>
			index === 1 ? new ApiError(400, 'bad_request') : null;
		const bytes = patterned(FRAME + 1);
		first.addFiles(root, [{ file: fakeFile('r.bin', bytes) }]);
		await settled(first);
		fixture.server.state.failFrame = null;

		const records = await resume.list(USER_ID);
		expect(records).toHaveLength(1);
		const second = new UploadQueue({ tree: fixture.tree, engine: fixture.engine });
		second.addPaused(records[0], 'r.bin');
		expect(second.items[0].status).toBe('paused');

		expect(second.resumeWith(second.items[0].id, fakeFile('r.bin', patterned(3)))).toBe(false);
		expect(second.resumeWith(second.items[0].id, fakeFile('other', bytes))).toBe(false);
		expect(second.resumeWith(second.items[0].id, fakeFile('r.bin', bytes))).toBe(true);
		await settled(second);

		expect(second.items[0].status).toBe('done');
		expect(fixture.tree.childrenOf(root).map((n) => n.name)).toEqual(['r.bin']);
		expect(await resume.list(USER_ID)).toEqual([]);
	});

	it('dropping the same file again picks up the interrupted upload', async () => {
		const fixture = driveFixture(suite);
		await fixture.tree.start();
		const root = fixture.tree.rootId as string;
		const first = new UploadQueue({ tree: fixture.tree, engine: fixture.engine });
		fixture.server.state.failFrame = (index) =>
			index === 1 ? new ApiError(400, 'bad_request') : null;
		const bytes = patterned(FRAME + 1);
		first.addFiles(root, [{ file: fakeFile('again.bin', bytes) }]);
		await settled(first);
		fixture.server.state.failFrame = null;
		fixture.server.calls.length = 0;

		const second = new UploadQueue({ tree: fixture.tree, engine: fixture.engine });
		second.addFiles(root, [{ file: fakeFile('again.bin', bytes) }]);
		await settled(second);

		expect(second.items[0].status).toBe('done');
		expect(fixture.server.calls).toEqual(['frame 1']);
	});

	it('stop leaves what is on the server to resume from', async () => {
		const { queue, root, server, engine } = await queueOver(suite);
		const original = server.api.putFrame;
		let reached = false;
		server.api.putFrame = (async (...args: Parameters<typeof original>) => {
			reached = true;
			await new Promise(() => {});
			return original(...args);
		}) as typeof original;
		queue.addFiles(root, [{ file: fakeFile('held', patterned(5)) }]);
		await vi.waitFor(() => expect(reached).toBe(true), { interval: 5 });

		queue.stop();
		expect(queue.items).toEqual([]);
		expect(server.uploads.size).toBe(1);
		expect(await engine.resume.list(USER_ID)).toHaveLength(1);
	});

	it('runs a few files at a time', async () => {
		const { queue, root, server } = await queueOver(suite);
		const original = server.api.createUpload;
		let active = 0;
		let peak = 0;
		server.api.createUpload = (async (...args: Parameters<typeof original>) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 2));
			active -= 1;
			return original(...args);
		}) as typeof original;
		queue.addFiles(
			root,
			Array.from({ length: 8 }, (_, i) => ({ file: fakeFile(`${i}`, patterned(2)) }))
		);
		await settled(queue);
		expect(peak).toBeLessThanOrEqual(3);
		expect(queue.items.every((i) => i.status === 'done')).toBe(true);
	});
});
