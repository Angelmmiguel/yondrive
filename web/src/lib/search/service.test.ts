import { describe, expect, it, vi } from 'vitest';
import type { Api } from '$lib/api/client';
import { ApiError } from '$lib/api/types';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodeBase64 } from '$lib/crypto/encoding';
import { sealerFor } from '$lib/crypto/sealer';
import { Drive } from '$lib/drive/drive';
import { inlineFramePool } from '$lib/drive/frame-pool';
import { openNodes } from '$lib/drive/open-nodes';
import type { StreamClient } from '$lib/drive/stream/client';
import { memoryResumeStore } from '$lib/drive/upload/resume';
import { fakeDriveServer, fakeUser, SUITES, testPublicKeys, USER_ID } from '$lib/testing/drive';
import { memorySegmentCache } from './cache';
import { createEngine } from './engine';
import { registerExtractor } from './extract';
import { searchOfDrive } from './of-drive';
import type { Suite } from '$lib/crypto/sealer';

const streams = { open: async () => null, release() {}, clear() {}, stop() {} } as StreamClient;

/** A drive and its search over one fake server, each file a real Blob. */
function wired(suite: Suite, server = fakeDriveServer(suite), keys = fakeUser(suite)) {
	const sealer = sealerFor(suite);
	const log: string[] = [];
	const api = new Proxy(server.api, {
		get(target, name: keyof Api) {
			const call = target[name] as (...args: unknown[]) => unknown;
			return (...args: unknown[]) => {
				log.push(name);
				return call(...args);
			};
		}
	});
	const drive = new Drive({
		api,
		sealer,
		keys: () => keys,
		userId: () => server.state.actor,
		open: async (key, parent, records) => openNodes(sealer, key, parent, records),
		pool: inlineFramePool(sealer),
		resume: memoryResumeStore(),
		streams,
		saveUrl() {},
		saveBlob() {},
		sleep: async () => {},
		onCommitted: (node, blob) => void current.service.fileCommitted(node.id, blob)
	});
	drive.engine.frameSize = 1024;
	const cache = memorySegmentCache();
	const key = () => sealer.indexKey(keys.masterKey);
	const current = {
		service: searchOfDrive(drive, {
			api,
			sealer,
			cache,
			index: createEngine(suite, key()),
			userId: server.state.actor,
			reconcileMs: 1,
			flushMs: 1,
			pause: async () => {}
		})
	};
	return { server, log, sealer, keys, drive, cache, key, current };
}

const names = async (
	service: { search: (q: { text: string }) => Promise<{ hits: { name: string }[] }> },
	text: string
) => (await service.search({ text })).hits.map((hit) => hit.name);

async function upload(drive: Drive, parent: string, name: string, text: string) {
	drive.queue.addFiles(parent, [{ file: new File([text], name, { type: 'text/plain' }) }]);
	await vi.waitFor(() => expect(drive.queue.active).toBe(false), { interval: 2 });
}

const settled = (service: { status: { phase: string; pending: number } }) =>
	vi.waitFor(
		() => {
			expect(service.status.phase).toBe('ready');
			expect(service.status.pending).toBe(0);
		},
		{ interval: 2, timeout: 5000 }
	);

describe.each(SUITES)('search over the drive in mode %s', (_, suite) => {
	it('finds a file by name and by text on upload, and sends no query anywhere', async () => {
		const { drive, current, log } = wired(suite);
		await drive.start();
		await current.service.start();
		await upload(drive, drive.tree.rootId as string, 'Report.txt', 'the walrus sang');
		await vi.waitFor(async () =>
			expect(await names(current.service, 'walrus')).toEqual(['Report.txt'])
		);
		expect(await names(current.service, 'report')).toEqual(['Report.txt']);

		log.length = 0;
		await current.service.search({ text: 'walrus' });
		expect(log).toEqual([]);
	});

	it('finds what a folder holds, with its path', async () => {
		const { drive, current } = wired(suite);
		await drive.start();
		const root = drive.tree.rootId as string;
		const folder = await drive.tree.createFolder(root, 'Work');
		await upload(drive, folder.id, 'plan.md', 'quarterly');
		await current.service.start();
		await settled(current.service);
		const { hits } = await current.service.search({ text: 'quarterly' });
		expect(hits[0].path).toEqual(['Work']);
		expect(hits[0].parent).toBe(folder.id);
	});

	it('finds tags, follows a rename, and drops what is trashed', async () => {
		const { drive, current } = wired(suite);
		await drive.start();
		const root = drive.tree.rootId as string;
		await upload(drive, root, 'a.txt', 'hello');
		await current.service.start();
		await settled(current.service);
		const file = drive.tree.childrenOf(root)[0];
		const tag = await drive.tree.createTag('Urgent');
		await drive.tree.patch(file.id, { tags: [tag.id] });
		await current.service.reconcileNow();
		expect(await names(current.service, 'urgent')).toEqual(['a.txt']);
		expect((await current.service.search({ text: '', tag: tag.id })).total).toBe(1);

		await drive.tree.rename(file.id, 'b.txt');
		await current.service.reconcileNow();
		expect(await names(current.service, 'a')).toEqual([]);
		expect(await names(current.service, 'b')).toEqual(['b.txt']);

		await drive.tree.trash(file.id);
		await current.service.reconcileNow();
		expect(await names(current.service, 'b')).toEqual([]);
		expect(await names(current.service, 'hello')).toEqual([]);
	});

	it('takes what is under a trashed folder with it', async () => {
		const { drive, current } = wired(suite);
		await drive.start();
		const root = drive.tree.rootId as string;
		const folder = await drive.tree.createFolder(root, 'Old');
		await upload(drive, folder.id, 'inner.txt', 'hello');
		await current.service.start();
		await settled(current.service);
		expect(await names(current.service, 'inner')).toEqual(['inner.txt']);
		await drive.tree.trash(folder.id);
		await current.service.reconcileNow();
		expect(await names(current.service, 'inner')).toEqual([]);
	});

	it('reads text it lacks, for a file another device uploaded', async () => {
		const server = fakeDriveServer(suite);
		const keys = fakeUser(suite);
		const other = wired(suite, server, keys);
		await other.drive.start();
		await upload(other.drive, other.drive.tree.rootId as string, 'away.txt', 'distant words');

		const { drive, current } = wired(suite, server, keys);
		await drive.start();
		await current.service.start();
		await settled(current.service);
		expect(await names(current.service, 'distant')).toEqual(['away.txt']);
	});

	it('stores segments, and a new unlock gets its text from them, not the files', async () => {
		const server = fakeDriveServer(suite);
		const keys = fakeUser(suite);
		const first = wired(suite, server, keys);
		await first.drive.start();
		await first.current.service.start();
		await upload(first.drive, first.drive.tree.rootId as string, 'kept.txt', 'persistent words');
		await vi.waitFor(async () =>
			expect(await names(first.current.service, 'persistent')).toEqual(['kept.txt'])
		);
		await first.current.service.reconcileNow();
		await first.current.service.flushNow();
		expect(first.log).toContain('putSmallBlob');
		const stored = [...first.cache.items.keys()];
		expect(stored.length).toBeGreaterThan(0);

		const second = wired(suite, server, keys);
		await second.drive.start();
		second.log.length = 0;
		await second.current.service.start();
		await settled(second.current.service);
		expect(await names(second.current.service, 'persistent')).toEqual(['kept.txt']);
		expect(second.log).toContain('getBlob');
		expect(second.log).not.toContain('getVersion');
		// And it keeps them as they are stored, for next time.
		expect([...second.cache.items.keys()].sort()).toEqual(stored.sort());
	});

	it('uses the device copy when it has one, and drops what the server no longer lists', async () => {
		const server = fakeDriveServer(suite);
		const keys = fakeUser(suite);
		const first = wired(suite, server, keys);
		await first.drive.start();
		await first.current.service.start();
		await upload(first.drive, first.drive.tree.rootId as string, 'kept.txt', 'words');
		await first.current.service.reconcileNow();
		await first.current.service.flushNow();

		const second = wired(suite, server, keys);
		for (const [id, bytes] of first.cache.items) second.cache.items.set(id, bytes);
		second.cache.items.set('f'.repeat(32), new Uint8Array(3));
		await second.drive.start();
		second.log.length = 0;
		await second.current.service.start();
		expect(second.log).not.toContain('getBlob');
		expect(second.cache.items.has('f'.repeat(32))).toBe(false);
	});

	it('rebuilds from the tree when stored segments are bad, and removes them', async () => {
		const server = fakeDriveServer(suite);
		const keys = fakeUser(suite);
		const first = wired(suite, server, keys);
		await first.drive.start();
		await upload(first.drive, first.drive.tree.rootId as string, 'kept.txt', 'words');
		const badId = 'e'.repeat(32);
		await server.api.putSmallBlob(
			badId,
			{ kind: 'index', suite },
			new Uint8Array(50).fill(9),
			encodeBase64(sha256(new Uint8Array(50).fill(9)))
		);
		await first.current.service.start();
		await settled(first.current.service);
		expect(await names(first.current.service, 'kept')).toEqual(['kept.txt']);
		expect(await names(first.current.service, 'words')).toEqual(['kept.txt']);
		expect(first.log).toContain('deleteSmallBlob');
		const { blobs } = await server.api.listIndexBlobs();
		expect(blobs.map((blob) => blob.id)).not.toContain(badId);
	});

	it('merges segments when they pile up, and the merge holds everything', async () => {
		const server = fakeDriveServer(suite);
		const keys = fakeUser(suite);
		const first = wired(suite, server, keys);
		await first.drive.start();
		await first.current.service.start();
		const root = first.drive.tree.rootId as string;
		for (let i = 0; i < 4; i++) {
			await upload(first.drive, root, `doc${i}.txt`, `word${i}`);
			await vi.waitFor(async () =>
				expect(await names(first.current.service, `word${i}`)).toEqual([`doc${i}.txt`])
			);
			await first.current.service.flushNow(100);
		}
		const piled = (await server.api.listIndexBlobs()).blobs.length;
		expect(piled).toBeGreaterThanOrEqual(4);
		await first.current.service.flushNow(2);
		expect((await server.api.listIndexBlobs()).blobs.length).toBeLessThan(piled);

		const second = wired(suite, server, keys);
		await second.drive.start();
		await second.current.service.start();
		await settled(second.current.service);
		for (let i = 0; i < 4; i++) {
			expect(await names(second.current.service, `word${i}`)).toEqual([`doc${i}.txt`]);
		}
	});

	it('goes on when quota refuses a segment, and stores it once there is room', async () => {
		const { drive, current, server } = wired(suite);
		await drive.start();
		const refuse = vi
			.spyOn(server.api, 'putSmallBlob')
			.mockRejectedValue(new ApiError(413, 'quota_exceeded'));
		await upload(drive, drive.tree.rootId as string, 'a.txt', 'words');
		await current.service.start();
		await settled(current.service);
		await current.service.flushNow();
		expect(current.service.status.unsaved).toBe(true);
		expect(await names(current.service, 'a')).toEqual(['a.txt']);
		refuse.mockRestore();
		await current.service.flushNow();
		expect(current.service.status.unsaved).toBe(false);
		expect((await server.api.listIndexBlobs()).blobs.length).toBeGreaterThan(0);
	});

	it('takes a format from a plug-in', async () => {
		const stop = registerExtractor({
			accepts: (type) => type === 'application/x-test',
			extract: async () => 'plugged in words'
		});
		try {
			const { drive, current } = wired(suite);
			await drive.start();
			await current.service.start();
			const root = drive.tree.rootId as string;
			drive.queue.addFiles(root, [
				{ file: new File(['x'], 'a.bin', { type: 'application/x-test' }) }
			]);
			await vi.waitFor(() => expect(drive.queue.active).toBe(false), { interval: 2 });
			await vi.waitFor(async () =>
				expect(await names(current.service, 'plugged')).toEqual(['a.bin'])
			);
		} finally {
			stop();
		}
	});

	it('stops: the index ends and later calls do nothing', async () => {
		const { drive, current, log } = wired(suite);
		await drive.start();
		await current.service.start();
		current.service.stop();
		log.length = 0;
		await current.service.reconcileNow();
		await current.service.flushNow();
		expect(log).toEqual([]);
	});
});

describe.each(SUITES)('sharing in mode %s', (_, suite) => {
	it('a grantee finds what is shared, and loses it on revocation', async () => {
		const server = fakeDriveServer(suite);
		const sealer = sealerFor(suite);
		const person = (id: string, username: string) => {
			const keys = fakeUser(suite);
			server.users.set(id, { id, username, public_keys: testPublicKeys(keys) });
			const api = server.as(id);
			const drive = new Drive({
				api,
				sealer,
				keys: () => keys,
				userId: () => id,
				open: async (key, parent, records) => openNodes(sealer, key, parent, records),
				pool: inlineFramePool(sealer),
				resume: memoryResumeStore(),
				streams,
				saveUrl() {},
				saveBlob() {},
				sleep: async () => {}
			});
			drive.engine.frameSize = 1024;
			const service = searchOfDrive(drive, {
				api,
				sealer,
				cache: memorySegmentCache(),
				index: createEngine(suite, sealer.indexKey(keys.masterKey)),
				userId: id,
				reconcileMs: 1,
				flushMs: 1,
				pause: async () => {}
			});
			return { id, drive, service };
		};
		const alice = person(USER_ID, 'alice');
		const bob = person('b'.repeat(32), 'bob');
		await alice.drive.start();
		await bob.drive.start();
		const folder = await alice.drive.tree.createFolder(
			alice.drive.tree.rootId as string,
			'Together'
		);
		await upload(alice.drive, folder.id, 'common.txt', 'shared words');
		await alice.drive.sharing.share(folder.id, 'bob', 'viewer');

		await bob.drive.poll();
		await bob.service.start();
		await settled(bob.service);
		const found = await bob.service.search({ text: 'common' });
		expect(found.hits[0].shared).toBe(true);
		expect(found.hits[0].path).toEqual(['Together']);
		expect((await bob.service.search({ text: 'shared', shared: 'with-me' })).total).toBe(1);
		expect((await bob.service.search({ text: 'common', shared: 'mine' })).total).toBe(0);

		const [access] = await alice.drive.sharing.people(folder.id);
		expect(access).toBeDefined();
		const grants = [...server.grants.values()];
		await server.as(USER_ID).deleteGrant(grants[0].id);
		await bob.drive.poll();
		await bob.service.reconcileNow();
		expect((await bob.service.search({ text: 'common' })).total).toBe(0);
		expect((await bob.service.search({ text: 'shared' })).total).toBe(0);
	});
});
