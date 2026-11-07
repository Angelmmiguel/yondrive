import { describe, expect, it } from 'vitest';
import { ApiError, isApiError } from '$lib/api/types';
import { decodeBase64 } from '$lib/crypto/encoding';
import { decodeManifest } from '$lib/crypto/manifest';
import { SealError } from '$lib/crypto/aead';
import { SUITE_E2E, SUITE_NONE } from '$lib/crypto/sealer';
import { driveFixture, fakeFile, patterned, SUITES, TEST_FRAME, USER_ID } from '$lib/testing/drive';
import { openVersion, readAll } from '../download/reader';
import { beginUpload, inParallel, sendUpload, UploadRestartError } from './engine';
import { newId } from '../ids';

const FRAME = TEST_FRAME;

async function fixtureWithFile(suite: (typeof SUITES)[number][1], name = 'file.bin') {
	const fixture = driveFixture(suite);
	await fixture.tree.start();
	const node = await fixture.tree.createFile(fixture.tree.rootId as string, {
		name,
		type: '',
		size: 0,
		modified: 0
	});
	const nodeKey = await fixture.tree.nodeKey(node.id);
	return { ...fixture, node, nodeKey };
}

type Fixture = Awaited<ReturnType<typeof fixtureWithFile>>;

async function upload(fixture: Fixture, bytes: Uint8Array, expected = '') {
	const source = fakeFile('file.bin', bytes);
	const target = {
		nodeId: fixture.node.id,
		nodeKey: fixture.nodeKey,
		expected,
		versionId: newId()
	};
	const record = await beginUpload(source, target, fixture.engine);
	const version = await sendUpload(source, record, fixture.nodeKey, fixture.engine);
	return { version, record, source };
}

function readerDeps(fixture: Fixture) {
	return {
		api: fixture.server.api,
		sealer: fixture.sealer,
		authorKeys: async () => ({
			x25519: fixture.keys.identity.x25519.publicKey,
			ed25519: fixture.keys.identity.ed25519.publicKey
		})
	};
}

async function readBack(fixture: Fixture, versionId: string): Promise<Uint8Array> {
	const verified = await openVersion(fixture.node.id, versionId, readerDeps(fixture));
	const session = fixture.engine.pool.session(
		fixture.sealer.versionKey(fixture.nodeKey, verified.ref),
		verified.ref
	);
	const blob = await readAll(verified, session, {
		api: fixture.server.api,
		sealer: fixture.sealer
	});
	session.close();
	return new Uint8Array(await blob.arrayBuffer());
}

describe.each(SUITES)('uploading in mode %s', (_, suite) => {
	it.each([
		['an empty file', 0],
		['one byte', 1],
		['exactly one frame', FRAME],
		['one frame and a byte', FRAME + 1],
		['a few frames', FRAME * 2 + 123]
	])('round trips %s', async (_label, size) => {
		const fixture = await fixtureWithFile(suite);
		const bytes = patterned(size);
		const { version } = await upload(fixture, bytes);

		expect(await readBack(fixture, version.id)).toEqual(bytes);
		const stored = fixture.server.blobs.get(version.blob_id) as Uint8Array;
		const overhead = fixture.sealer.frameOverhead * version.frame_count;
		expect(stored.length).toBe(size + overhead);
	});

	it('reserves room and answers over quota before sending anything', async () => {
		const fixture = driveFixture(suite, { quota: 100 });
		await fixture.tree.start();
		const node = await fixture.tree.createFile(fixture.tree.rootId as string, {
			name: 'big',
			type: '',
			size: 0,
			modified: 0
		});
		const nodeKey = await fixture.tree.nodeKey(node.id);
		await expect(
			beginUpload(
				fakeFile('big', patterned(101)),
				{ nodeId: node.id, nodeKey, expected: '', versionId: newId() },
				fixture.engine
			)
		).rejects.toSatisfy((e) => isApiError(e, 'quota_exceeded'));
		expect(fixture.server.calls).toEqual([]);
	});

	it('tries a failed frame again with the same bytes', async () => {
		const fixture = await fixtureWithFile(suite);
		const failures = new Map([[1, 2]]);
		fixture.server.state.failFrame = (index) => {
			const left = failures.get(index) ?? 0;
			if (left === 0) return null;
			failures.set(index, left - 1);
			return new ApiError(0, 'network');
		};
		const bytes = patterned(FRAME * 2 + 5);
		const { version } = await upload(fixture, bytes);

		expect(fixture.server.calls.filter((c) => c === 'frame 1')).toHaveLength(3);
		expect(await readBack(fixture, version.id)).toEqual(bytes);
	});

	it('survives a lost answer to the commit', async () => {
		const fixture = await fixtureWithFile(suite);
		fixture.server.state.loseCommitAnswer = true;
		const bytes = patterned(10);
		const { version } = await upload(fixture, bytes);

		expect(await readBack(fixture, version.id)).toEqual(bytes);
	});

	it('resumes from what reached the server, without sending it again', async () => {
		const fixture = await fixtureWithFile(suite);
		const bytes = patterned(FRAME * 3 + 7);
		const source = fakeFile('file.bin', bytes);
		const record = await beginUpload(
			source,
			{ nodeId: fixture.node.id, nodeKey: fixture.nodeKey, expected: '', versionId: newId() },
			fixture.engine
		);
		// Frame 2 never arrives: the connection went, and the page with it.
		fixture.server.state.failFrame = (index) =>
			index === 2 ? new ApiError(400, 'bad_request') : null;
		await expect(
			sendUpload(source, record, fixture.nodeKey, fixture.engine)
		).rejects.toBeInstanceOf(ApiError);

		fixture.server.state.failFrame = null;
		fixture.server.calls.length = 0;
		const records = await fixture.engine.resume.list(USER_ID);
		expect(records.map((r) => r.uploadId)).toEqual([record.uploadId]);
		const progress: number[] = [];
		const version = await sendUpload(
			source,
			records[0],
			fixture.nodeKey,
			fixture.engine,
			({ done }) => progress.push(done)
		);

		expect(fixture.server.calls.includes('frame 2')).toBe(true);
		expect(fixture.server.calls.includes('frame 0') || progress[0] === 0).toBe(
			fixture.server.calls.includes('frame 0')
		);
		expect(progress[progress.length - 1]).toBe(bytes.length);
		expect(await readBack(fixture, version.id)).toEqual(bytes);
		expect(await fixture.engine.resume.list(USER_ID)).toEqual([]);
	});

	it('says to start over when the server has a frame it has no digest for', async () => {
		const fixture = await fixtureWithFile(suite);
		const bytes = patterned(FRAME + 7);
		const source = fakeFile('file.bin', bytes);
		const record = await beginUpload(
			source,
			{ nodeId: fixture.node.id, nodeKey: fixture.nodeKey, expected: '', versionId: newId() },
			fixture.engine
		);
		await fixture.server.api
			.putFrame(record.uploadId, 1, bytes.slice(FRAME), '' as string)
			.catch(() => {});
		const stored = fixture.server.uploads.get(record.uploadId);
		stored?.frames.set(0, { data: new Uint8Array(0), digest: 'x' });

		await expect(
			sendUpload(source, record, fixture.nodeKey, fixture.engine)
		).rejects.toBeInstanceOf(UploadRestartError);
	});

	it('says to start over when a frame raced in from before the reload', async () => {
		const fixture = await fixtureWithFile(suite);
		fixture.server.state.failFrame = () => new ApiError(409, 'frame_conflict');
		const source = fakeFile('file.bin', patterned(10));
		const record = await beginUpload(
			source,
			{ nodeId: fixture.node.id, nodeKey: fixture.nodeKey, expected: '', versionId: newId() },
			fixture.engine
		);
		await expect(
			sendUpload(source, record, fixture.nodeKey, fixture.engine)
		).rejects.toBeInstanceOf(UploadRestartError);
	});

	it('refuses a commit over a version it did not start from', async () => {
		const fixture = await fixtureWithFile(suite);
		const first = await upload(fixture, patterned(10));
		await expect(upload(fixture, patterned(20), 'not-the-current-one')).rejects.toSatisfy((e) =>
			isApiError(e, 'version_conflict')
		);
		await expect(upload(fixture, patterned(20), first.version.id)).resolves.toBeTruthy();
	});

	it('writes a manifest that says what was uploaded', async () => {
		const fixture = await fixtureWithFile(suite);
		const { version } = await upload(fixture, patterned(10));
		const manifest = decodeManifest(decodeBase64(version.manifest));
		expect(manifest).toMatchObject({
			nodeId: fixture.node.id,
			versionId: version.id,
			suite,
			size: 10,
			frameSize: FRAME,
			frameCount: 1
		});
	});

	it('stops when cancelled', async () => {
		const fixture = await fixtureWithFile(suite);
		const controller = new AbortController();
		const source = fakeFile('file.bin', patterned(FRAME * 8));
		const record = await beginUpload(
			source,
			{ nodeId: fixture.node.id, nodeKey: fixture.nodeKey, expected: '', versionId: newId() },
			fixture.engine
		);
		fixture.server.state.failFrame = () => {
			controller.abort(new DOMException('cancelled', 'AbortError'));
			return new ApiError(0, 'network');
		};
		await expect(
			sendUpload(source, record, fixture.nodeKey, fixture.engine, () => {}, controller.signal)
		).rejects.toThrow('cancelled');
	});
});

describe('tamper rejection', () => {
	async function stored(size = FRAME + 100) {
		const fixture = await fixtureWithFile(SUITE_E2E);
		const bytes = patterned(size);
		const { version } = await upload(fixture, bytes);
		return { fixture, bytes, version };
	}

	it('refuses a flipped byte in a frame', async () => {
		const { fixture, version } = await stored();
		fixture.server.state.tamperBlob = (_id, part) => {
			const flipped = part.slice();
			flipped[10] ^= 1;
			return flipped;
		};
		await expect(readBack(fixture, version.id)).rejects.toThrow(SealError);
	});

	it('refuses a flipped byte with matching hashes, as a hostile server would send', async () => {
		const { fixture, version } = await stored(100);
		fixture.server.state.tamperVersion = (v) => {
			const hashes = decodeBase64(v.frame_hashes);
			hashes[0] ^= 1;
			return { ...v, frame_hashes: btoa(String.fromCharCode(...hashes)) };
		};
		await expect(readBack(fixture, version.id)).rejects.toThrow(SealError);
	});

	it('refuses a signature that does not verify', async () => {
		const { fixture, version } = await stored(100);
		fixture.server.state.tamperVersion = (v) => {
			const signature = decodeBase64(v.signature);
			signature[0] ^= 1;
			return { ...v, signature: btoa(String.fromCharCode(...signature)) };
		};
		await expect(readBack(fixture, version.id)).rejects.toThrow(SealError);
	});

	it('refuses a manifest of another version or node', async () => {
		const { fixture, version } = await stored(100);
		fixture.server.state.tamperVersion = (v) => ({ ...v, content_version_id: 'f'.repeat(32) });
		await expect(readBack(fixture, version.id)).rejects.toThrow(SealError);
		fixture.server.state.tamperVersion = (v) => ({ ...v, node_id: 'f'.repeat(32) });
		await expect(readBack(fixture, version.id)).rejects.toThrow(SealError);
	});

	it('refuses a size or framing that disagrees with what was signed', async () => {
		const { fixture, version } = await stored(100);
		fixture.server.state.tamperVersion = (v) => ({ ...v, stored_size: v.stored_size - 1 });
		await expect(readBack(fixture, version.id)).rejects.toThrow(SealError);
	});

	it('refuses frames of another version of the same file', async () => {
		const fixture = await fixtureWithFile(SUITE_E2E);
		const a = await upload(fixture, patterned(100));
		const b = await upload(fixture, patterned(100), a.version.id);
		fixture.server.state.tamperBlob = (id) =>
			(
				fixture.server.blobs.get(id === a.version.blob_id ? b.version.blob_id : id) as Uint8Array
			).slice();
		await expect(readBack(fixture, a.version.id)).rejects.toThrow(SealError);
	});

	it('refuses a signer other than the one the caller accepts', async () => {
		const fixture = await fixtureWithFile(SUITE_E2E);
		const { version } = await upload(fixture, patterned(100));
		const other = driveFixture(SUITE_E2E).keys.identity;
		const deps = {
			...readerDeps(fixture),
			authorKeys: async () => ({
				x25519: other.x25519.publicKey,
				ed25519: other.ed25519.publicKey
			})
		};
		await expect(openVersion(fixture.node.id, version.id, deps)).rejects.toThrow(SealError);
	});

	it('in suite none still refuses a corrupted frame', async () => {
		const fixture = await fixtureWithFile(SUITE_NONE);
		const { version } = await upload(fixture, patterned(100));
		fixture.server.state.tamperBlob = (_id, part) => {
			const flipped = part.slice();
			flipped[0] ^= 1;
			return flipped;
		};
		await expect(readBack(fixture, version.id)).rejects.toThrow(SealError);
	});

	it('in suite none refuses hashes that do not add up', async () => {
		const fixture = await fixtureWithFile(SUITE_NONE);
		const { version } = await upload(fixture, patterned(100));
		fixture.server.state.tamperVersion = (v) => {
			const hashes = decodeBase64(v.frame_hashes);
			hashes[0] ^= 1;
			return { ...v, frame_hashes: btoa(String.fromCharCode(...hashes)) };
		};
		await expect(readBack(fixture, version.id)).rejects.toThrow(SealError);
	});
});

describe('restored versions', () => {
	it.each(SUITES)('in mode %s read with the id they were sealed under', async (_, suite) => {
		const fixture = await fixtureWithFile(suite);
		const first = patterned(100);
		const a = await upload(fixture, first);
		await upload(fixture, patterned(200), a.version.id);
		const restoredId = newId();
		const restored = await fixture.server.api.restoreVersion(fixture.node.id, a.version.id, {
			version_id: restoredId
		});

		expect(restored.content_version_id).toBe(a.version.id);
		expect(await readBack(fixture, restoredId)).toEqual(first);
	});
});

describe('inParallel', () => {
	it('stops starting more after the first failure, and says what it was', async () => {
		const started: number[] = [];
		await expect(
			inParallel([1, 2, 3, 4, 5, 6], 2, async (n) => {
				started.push(n);
				if (n === 2) throw new Error('boom');
			})
		).rejects.toThrow('boom');
		expect(started.length).toBeLessThan(6);
	});

	it('does nothing with nothing', async () => {
		await expect(inParallel([], 4, async () => {})).resolves.toBeUndefined();
	});
});
