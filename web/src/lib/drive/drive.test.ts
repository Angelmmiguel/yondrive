import { describe, expect, it, vi } from 'vitest';
import { ApiError, isApiError } from '$lib/api/types';
import { SealError } from '$lib/crypto/aead';
import { sealerFor, SUITE_E2E } from '$lib/crypto/sealer';
import {
	fakeDriveServer,
	fakeFile,
	fakeUser,
	patterned,
	SUITES,
	USER_ID
} from '$lib/testing/drive';
import { Drive } from './drive';
import { TooLargeForMemoryError } from './errors';
import { inlineFramePool } from './frame-pool';
import { openNodes } from './open-nodes';
import type { StreamClient, StreamRequest } from './stream/client';
import { memoryResumeStore } from './upload/resume';

function wired(suite: (typeof SUITES)[number][1], streamUrl: string | null = null) {
	const server = fakeDriveServer(suite);
	const sealer = sealerFor(suite);
	const keys = fakeUser(suite);
	const opened: StreamRequest[] = [];
	const streams: StreamClient = {
		open: vi.fn(async (request: StreamRequest) => {
			opened.push(request);
			return streamUrl;
		}),
		release: vi.fn(),
		clear: vi.fn(),
		stop: vi.fn()
	};
	const saveUrl = vi.fn();
	const saved: { blob: Blob; name: string }[] = [];
	const drive = new Drive({
		api: server.api,
		sealer,
		keys: () => keys,
		userId: () => USER_ID,
		open: async (key, parent, records) => openNodes(sealer, key, parent, records),
		pool: inlineFramePool(sealer),
		resume: memoryResumeStore(),
		streams,
		saveUrl,
		saveBlob: (blob, name) => saved.push({ blob, name }),
		sleep: async () => {}
	});
	drive.engine.frameSize = 1024;
	return { server, sealer, keys, drive, streams, opened, saveUrl, saved };
}

async function withFile(fixture: ReturnType<typeof wired>, bytes: Uint8Array, name = 'f.bin') {
	const { drive } = fixture;
	await drive.start();
	drive.queue.addFiles(drive.tree.rootId as string, [{ file: fakeFile(name, bytes) }]);
	await vi.waitFor(() => expect(drive.queue.active).toBe(false), { interval: 5 });
	return drive.tree.childrenOf(drive.tree.rootId as string)[0];
}

describe.each(SUITES)('the drive in mode %s', (_, suite) => {
	it('saves through memory when it cannot stream, byte for byte', async () => {
		const fixture = wired(suite);
		const bytes = patterned(5000);
		const node = await withFile(fixture, bytes);

		expect(await fixture.drive.download(node)).toEqual({ via: 'memory' });
		expect(fixture.saved[0].name).toBe('f.bin');
		expect(new Uint8Array(await fixture.saved[0].blob.arrayBuffer()).join()).toBe(bytes.join());
	});

	it('hands a verified version to the stream when it can', async () => {
		const fixture = wired(suite, '/stream/abc');
		const node = await withFile(fixture, patterned(5000));

		expect(await fixture.drive.download(node)).toEqual({ via: 'stream' });
		expect(fixture.saveUrl).toHaveBeenCalledWith('/stream/abc');
		expect(fixture.opened[0]).toMatchObject({ filename: 'f.bin', mime: null });
		expect(fixture.saved).toEqual([]);
	});

	it('does not start a stream for a version that fails to verify', async () => {
		const fixture = wired(suite, '/stream/abc');
		const node = await withFile(fixture, patterned(10));
		fixture.server.state.tamperVersion = (version) => ({ ...version, frame_count: 2 });

		await expect(fixture.drive.download(node)).rejects.toThrow(SealError);
		expect(fixture.streams.open).not.toHaveBeenCalled();
	});

	it('names a signer without edit rights as such', async () => {
		const { drive } = wired(suite);
		await drive.start();
		const root = drive.tree.rootId as string;
		await expect(drive.sharing.authorKeys(USER_ID, root)).resolves.toBeTruthy();
		await expect(drive.sharing.authorKeys('someone-else', root)).resolves.toMatchObject({
			former: true
		});
	});

	it('refuses to read past the limit, before reading anything', async () => {
		const fixture = wired(suite);
		const node = await withFile(fixture, patterned(5000));
		const version = await fixture.drive.openVersion(node);
		fixture.server.state.tamperBlob = () => {
			throw new Error('nothing should be read');
		};

		await expect(fixture.drive.readBlob(node, version, { limit: 100 })).rejects.toThrow(
			TooLargeForMemoryError
		);
	});

	it('follows the journal: what another device did shows up here', async () => {
		const fixture = wired(suite);
		const { drive, server, sealer, keys } = fixture;
		await drive.start();
		const root = drive.tree.rootId as string;
		const { DriveTree } = await import('./tree');
		const other = new DriveTree({
			api: server.api,
			sealer,
			keys: () => keys,
			open: async (key, parent, records) => openNodes(sealer, key, parent, records)
		});
		await other.start();

		expect(await drive.poll()).toBe(false);
		const made = await other.createFolder(root, 'Elsewhere');
		expect(await drive.poll()).toBe(true);
		expect(drive.tree.childrenOf(root).map((n) => n.name)).toEqual(['Elsewhere']);

		await other.rename(made.id, 'Renamed');
		await drive.poll();
		expect(drive.tree.nodes.get(made.id)?.name).toBe('Renamed');

		await other.trash(made.id);
		await drive.poll();
		expect(drive.tree.childrenOf(root)).toEqual([]);
	});

	it('reads the tree again after more changes than it would read one by one', async () => {
		const fixture = wired(suite);
		const { drive, server, sealer, keys } = fixture;
		await drive.start();
		const root = drive.tree.rootId as string;
		const { DriveTree } = await import('./tree');
		const other = new DriveTree({
			api: server.api,
			sealer,
			keys: () => keys,
			open: async (key, parent, records) => openNodes(sealer, key, parent, records)
		});
		await other.start();
		await Promise.all(
			Array.from({ length: 101 }, (_, i) => other.createFolder(root, `folder ${i}`))
		);

		expect(await drive.poll()).toBe(true);
		await vi.waitFor(() => expect(drive.tree.childrenOf(root)).toHaveLength(101));
	});

	it('lists what a reload interrupted, by the name on its node', async () => {
		const fixture = wired(suite);
		const { drive, server, sealer, keys, streams } = fixture;
		await drive.start();
		server.state.failFrame = () => {
			throw new Error('gone');
		};
		drive.queue.addFiles(drive.tree.rootId as string, [
			{ file: fakeFile('held.bin', patterned(9)) }
		]);
		await vi.waitFor(() => expect(drive.queue.active).toBe(false), { interval: 5 });
		server.state.failFrame = null;

		const later = new Drive({
			api: server.api,
			sealer,
			keys: () => keys,
			userId: () => USER_ID,
			open: async (key, parent, records) => openNodes(sealer, key, parent, records),
			pool: inlineFramePool(sealer),
			resume: drive.engine.resume,
			streams,
			saveUrl: () => {},
			saveBlob: () => {}
		});
		await later.start();
		await vi.waitFor(() =>
			expect(later.queue.items.map((i) => [i.name, i.status])).toEqual([['held.bin', 'paused']])
		);
	});

	it('forgets an upload the server has dropped', async () => {
		const fixture = wired(suite);
		const { drive, server } = fixture;
		await drive.start();
		await drive.engine.resume.put({
			uploadId: 'gone',
			userId: USER_ID,
			nodeId: 'n',
			versionId: 'v',
			size: 1,
			lastModified: 1,
			frameSize: 1024,
			expected: ''
		});
		const list = server.api.getUpload;
		expect(list).toBeTruthy();
		await drive.start();
		await vi.waitFor(async () => expect(await drive.engine.resume.list(USER_ID)).toEqual([]));
	});

	it('leaves nothing behind when stopped', async () => {
		const fixture = wired(suite);
		const node = await withFile(fixture, patterned(10));
		const key = await fixture.drive.tree.nodeKey(node.id);
		fixture.drive.stop();

		expect(key.every((byte) => byte === 0)).toBe(true);
		expect(fixture.streams.stop).toHaveBeenCalled();
		expect(fixture.drive.tree.nodes.size).toBe(0);
		expect(fixture.drive.queue.items).toEqual([]);
	});
});

it('a failed read of the journal says so to its caller', async () => {
	const fixture = wired(SUITE_E2E);
	await fixture.drive.start();
	fixture.server.api.listChanges = (async () => {
		throw new (await import('$lib/api/types')).ApiError(401, 'unauthorized');
	}) as never;
	await expect(fixture.drive.poll()).rejects.toSatisfy((e) => isApiError(e, 'unauthorized'));
});

describe('a journal trimmed past the cursor', () => {
	it('reads the whole tree again and starts over', async () => {
		const fixture = wired(SUITE_E2E);
		const { drive, server } = fixture;
		await drive.start();
		const root = drive.tree.rootId as string;
		const folder = await drive.tree.createFolder(root, 'Kept');
		await drive.tree.loadFolder(folder.id);
		// Another device, while the journal's cursor lapsed.
		const other = new Drive({
			api: server.api,
			sealer: fixture.sealer,
			keys: () => fixture.keys,
			userId: () => USER_ID,
			open: async (key, parent, records) => openNodes(fixture.sealer, key, parent, records),
			pool: inlineFramePool(fixture.sealer),
			resume: memoryResumeStore(),
			streams: fixture.streams,
			saveUrl: () => {},
			saveBlob: () => {}
		});
		await other.tree.start();
		await other.tree.loadFolder(root);
		await other.tree.createFolder(folder.id, 'Added away');

		const list = server.api.listChanges;
		server.api.listChanges = vi.fn(async (page) => {
			if (page?.cursor !== undefined) throw new ApiError(410, 'cursor_expired');
			return list(page);
		});
		expect(await drive.poll()).toBe(true);
		await vi.waitFor(() =>
			expect(drive.tree.childrenOf(folder.id).map((child) => child.name)).toEqual(['Added away'])
		);
		server.api.listChanges = list;
		await drive.poll();
	});
});

describe('uploads the server holds', () => {
	it.each(SUITES)(
		'lists those nothing here knows of, and lets go of them, in mode %s',
		async (_, suite) => {
			const fixture = wired(suite);
			const { drive, server } = fixture;
			const file = await withFile(fixture, patterned(10));
			expect(await drive.strayUploads()).toEqual([]);

			const created = await server.api.createUpload({
				node_id: file.id,
				version_id: 'c'.repeat(32),
				suite,
				frame_size: 1024,
				frame_count: 1,
				stored_size: 1024 + fixture.sealer.frameOverhead,
				key_generation: 1
			} as never);
			const [stray] = await drive.strayUploads();
			expect(stray.id).toBe(created.id);
			expect(stray.name).toBe('f.bin');
			expect(stray.frames_received).toBe(0);

			await drive.abortStray(stray);
			expect(await drive.strayUploads()).toEqual([]);
			// The file had content before all this, and it stays.
			expect(drive.tree.nodes.get(file.id)?.trashedAt).toBeNull();
		}
	);

	it('takes a file with it that never had any content', async () => {
		const fixture = wired(SUITE_E2E);
		const { drive, server } = fixture;
		await drive.start();
		const node = await drive.tree.createFile(drive.tree.rootId as string, {
			name: 'empty.bin',
			type: '',
			size: 10,
			modified: 1
		});
		await server.api.createUpload({
			node_id: node.id,
			version_id: 'c'.repeat(32),
			suite: SUITE_E2E,
			frame_size: 1024,
			frame_count: 1,
			stored_size: 1024 + fixture.sealer.frameOverhead,
			key_generation: 1
		} as never);
		const [stray] = await drive.strayUploads();
		await drive.abortStray(stray);
		expect(drive.tree.nodes.has(node.id)).toBe(false);
	});
});
