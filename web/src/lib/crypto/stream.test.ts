import { describe, expect, it } from 'vitest';
import { SealError } from './aead';
import { utf8 } from './encoding';
import { sealerFor, SUITE_E2E, SUITE_NONE, type Sealer, type SealedFrame } from './sealer';
import { assertManifest, FrameReader, FrameWriter } from './stream';
import type { VersionManifest } from './manifest';

const ref = { nodeId: 'n1', versionId: 'v1', frameSize: 1024 };
const file = new Uint8Array(2500).map((_, i) => i % 251);

function write(sealer: Sealer, nodeKey: Uint8Array, bytes = file, target = ref) {
	const writer = new FrameWriter(sealer, nodeKey, target);
	const frames: SealedFrame[] = [];
	let at = 0;
	do {
		const end = at + target.frameSize;
		frames.push(writer.write(bytes.subarray(at, end), end >= bytes.length));
		at = end;
	} while (at < bytes.length);
	return { frames, manifest: writer.finish() };
}

function read(
	sealer: Sealer,
	nodeKey: Uint8Array,
	manifest: VersionManifest,
	frames: SealedFrame[]
) {
	const reader = new FrameReader(sealer, nodeKey, manifest);
	const parts = frames.map((frame) => reader.read(frame));
	reader.finish();
	return Buffer.concat(parts);
}

function code(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof SealError) return e.code;
		throw e;
	}
	throw new Error('did not throw');
}

describe.each([
	['end-to-end', sealerFor(SUITE_E2E)],
	['none', sealerFor(SUITE_NONE)]
])('mode %s', (_, sealer) => {
	const nodeKey = sealer.newNodeKey();

	it('round-trips a file and describes it', () => {
		const { frames, manifest } = write(sealer, nodeKey);

		expect(manifest).toMatchObject({ ...ref, suite: sealer.suite, size: 2500, frameCount: 3 });
		expect(new Uint8Array(read(sealer, nodeKey, manifest, frames))).toEqual(file);
	});

	it.each([
		['empty', 0, 1],
		['one byte', 1, 1],
		['exactly one frame', 1024, 1],
		['exactly two frames', 2048, 2]
	])('handles a file that is %s', (_, size, count) => {
		const bytes = new Uint8Array(size).fill(5);
		const { frames, manifest } = write(sealer, nodeKey, bytes);

		expect(frames).toHaveLength(count);
		expect(new Uint8Array(read(sealer, nodeKey, manifest, frames))).toEqual(bytes);
	});

	it('detects a reorder', () => {
		const { frames, manifest } = write(
			sealer,
			nodeKey,
			new Uint8Array(3000).map((_, i) => Math.floor(i / 1024) + 1)
		);
		const swapped = [frames[1], frames[0], frames[2]];

		expect(() => read(sealer, nodeKey, manifest, swapped)).toThrow(SealError);
	});

	it('detects a truncation, even of whole frames', () => {
		const { frames, manifest } = write(sealer, nodeKey);

		expect(code(() => read(sealer, nodeKey, manifest, frames.slice(0, 2)))).toBe('truncated');
		expect(code(() => read(sealer, nodeKey, manifest, []))).toBe('truncated');
	});

	it('detects an extension', () => {
		const { frames, manifest } = write(sealer, nodeKey);

		expect(code(() => read(sealer, nodeKey, manifest, [...frames, frames[2]]))).toBe('extended');
	});

	it('detects a frame replaced along with its digest', () => {
		const { frames, manifest } = write(sealer, nodeKey);
		const other = write(
			sealer,
			nodeKey,
			file.map((b) => b ^ 1)
		);

		expect(() => read(sealer, nodeKey, manifest, [frames[0], other.frames[1], frames[2]])).toThrow(
			SealError
		);
	});

	it('detects a changed frame by its digest', () => {
		const { frames, manifest } = write(sealer, nodeKey);
		const corrupt = frames.map((frame) => ({ ...frame, data: frame.data.slice() }));
		corrupt[1].data[0] ^= 1;

		expect(code(() => read(sealer, nodeKey, manifest, corrupt))).toBe('integrity');
	});

	it('writer refuses anything after the final frame', () => {
		const writer = new FrameWriter(sealer, nodeKey, ref);
		writer.write(utf8('x'), true);

		expect(code(() => writer.write(utf8('y'), true))).toBe('extended');
	});

	it('writer refuses to finish without a final frame', () => {
		const writer = new FrameWriter(sealer, nodeKey, ref);
		writer.write(new Uint8Array(1024), false);

		expect(code(() => writer.finish())).toBe('truncated');
	});

	it('reader refuses a manifest of another suite or impossible shape', () => {
		const { manifest } = write(sealer, nodeKey);
		const otherSuite = sealer.suite === SUITE_E2E ? SUITE_NONE : SUITE_E2E;

		for (const bad of [
			{ suite: otherSuite },
			{ frameCount: 2 },
			{ frameSize: 512 },
			{ size: -1 },
			{ size: 0.5 },
			{ contentHash: new Uint8Array(31) }
		]) {
			expect(code(() => assertManifest({ ...manifest, ...bad }, sealer))).toBe('manifest');
		}
	});

	it('reader detects a manifest with another content hash', () => {
		const { frames, manifest } = write(sealer, nodeKey);

		expect(
			code(() =>
				read(sealer, nodeKey, { ...manifest, contentHash: new Uint8Array(32).fill(1) }, frames)
			)
		).toBe('manifest');
	});
});

describe('end-to-end only', () => {
	const sealer = sealerFor(SUITE_E2E);
	const nodeKey = sealer.newNodeKey();

	it('detects frames moved in with their digests, at once', () => {
		const { frames, manifest } = write(sealer, nodeKey);

		expect(code(() => read(sealer, nodeKey, manifest, [frames[1], frames[0], frames[2]]))).toBe(
			'auth'
		);
	});

	it('detects a final frame cut and the last full frame relabelled', () => {
		const { frames, manifest } = write(sealer, nodeKey);

		expect(
			code(() =>
				read(sealer, nodeKey, { ...manifest, size: 1024, frameCount: 1 }, frames.slice(0, 1))
			)
		).toBe('auth');
	});

	it('detects a frame swapped in from another version of the node', () => {
		const { frames, manifest } = write(sealer, nodeKey);
		const other = write(sealer, nodeKey, file, { ...ref, versionId: 'v2' });

		expect(
			code(() => read(sealer, nodeKey, manifest, [other.frames[0], frames[1], frames[2]]))
		).toBe('auth');
	});

	it('refuses to seal after abort, because the key is zeroed', () => {
		const writer = new FrameWriter(sealer, nodeKey, ref);

		writer.abort();

		expect(() => writer.write(utf8('y'), true)).toThrow('zeroed');
	});
});
