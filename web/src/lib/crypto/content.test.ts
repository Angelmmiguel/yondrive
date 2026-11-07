import { describe, expect, it } from 'vitest';
import { OVERHEAD, SealError } from './aead';
import {
	assertFrameSize,
	contentHasher,
	decryptFrame,
	DEFAULT_FRAME_SIZE,
	deriveVersionKey,
	encryptFrame,
	frameCountFor,
	MAX_FRAME_SIZE,
	MIN_FRAME_SIZE,
	type VersionRef
} from './content';
import { ZeroKeyError } from './random';

const nodeKey = new Uint8Array(32).map((_, i) => i + 1);
const ref: VersionRef = { nodeId: 'n1', versionId: 'v1', frameSize: 1024 };
const key = deriveVersionKey(nodeKey, ref);
const full = new Uint8Array(1024).fill(7);
const tail = new Uint8Array(10).fill(8);

function code(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof SealError) return e.code;
		throw e;
	}
	throw new Error('did not throw');
}

describe('parameters', () => {
	it('defaults to 4 MiB', () => {
		expect(DEFAULT_FRAME_SIZE).toBe(4194304);
		expect(() => assertFrameSize(DEFAULT_FRAME_SIZE)).not.toThrow();
	});

	it.each([MIN_FRAME_SIZE - 1, MAX_FRAME_SIZE + 1, 1024.5, NaN, 0, -1024])(
		'refuses a frame size of %d',
		(size) => {
			expect(code(() => assertFrameSize(size))).toBe('manifest');
		}
	);

	it.each([
		[0, 1],
		[1, 1],
		[1024, 1],
		[1025, 2],
		[2048, 2]
	])('a version of %d bytes has %d frames of 1 KiB', (size, count) => {
		expect(frameCountFor(size, 1024)).toBe(count);
	});
});

describe('deriveVersionKey', () => {
	it('gives a different key per version and per node', () => {
		expect(deriveVersionKey(nodeKey, { ...ref, versionId: 'v2' })).not.toEqual(key);
		expect(deriveVersionKey(nodeKey, { ...ref, nodeId: 'n2' })).not.toEqual(key);
		expect(deriveVersionKey(nodeKey, ref)).toEqual(key);
	});

	it('refuses a zeroed node key', () => {
		expect(() => deriveVersionKey(new Uint8Array(32), ref)).toThrow(ZeroKeyError);
	});
});

describe('frames', () => {
	it('round-trip with the documented overhead', () => {
		const position = { index: 3, final: false };
		const sealed = encryptFrame(key, ref, position, full);

		expect(sealed).toHaveLength(1024 + OVERHEAD);
		expect(decryptFrame(key, ref, position, sealed)).toEqual(full);
	});

	it.each([
		['moved to another index', { index: 1, final: false }, ref],
		['claimed as final', { index: 0, final: true }, ref],
		['taken to another version', { index: 0, final: false }, { ...ref, versionId: 'v2' }],
		['taken to another node', { index: 0, final: false }, { ...ref, nodeId: 'n2' }]
	])('refuse a frame %s', (_, position, otherRef) => {
		const sealed = encryptFrame(key, ref, { index: 0, final: false }, full);

		expect(code(() => decryptFrame(key, otherRef, position, sealed))).toBe('auth');
	});

	it('refuse a final frame claimed as not final', () => {
		const sealed = encryptFrame(key, ref, { index: 1, final: true }, full);

		expect(code(() => decryptFrame(key, ref, { index: 1, final: false }, sealed))).toBe('auth');
	});

	it('bind the frame size', () => {
		const sealed = encryptFrame(key, ref, { index: 0, final: true }, tail);

		expect(
			code(() => decryptFrame(key, { ...ref, frameSize: 2048 }, { index: 0, final: true }, sealed))
		).toBe('auth');
	});

	it('refuse another version key', () => {
		const sealed = encryptFrame(key, ref, { index: 0, final: true }, tail);
		const other = deriveVersionKey(nodeKey, { ...ref, versionId: 'v2' });

		expect(code(() => decryptFrame(other, ref, { index: 0, final: true }, sealed))).toBe('auth');
	});

	it.each([
		['a short frame that is not final', { index: 0, final: false }, tail],
		['a long frame', { index: 0, final: true }, new Uint8Array(1025)],
		['an empty final frame after others', { index: 1, final: true }, new Uint8Array(0)]
	])('refuse to seal %s', (_, position, plaintext) => {
		expect(code(() => encryptFrame(key, ref, position, plaintext))).toBe('length');
	});

	it('allow an empty only frame, for an empty file', () => {
		const position = { index: 0, final: true };
		const sealed = encryptFrame(key, ref, position, new Uint8Array(0));

		expect(decryptFrame(key, ref, position, sealed)).toEqual(new Uint8Array(0));
	});

	it('refuse a stored frame of an impossible length without decrypting', () => {
		expect(code(() => decryptFrame(key, ref, { index: 0, final: false }, tail))).toBe('length');
	});

	it('refuse a zeroed version key', () => {
		expect(() => encryptFrame(new Uint8Array(32), ref, { index: 0, final: true }, tail)).toThrow(
			ZeroKeyError
		);
	});
});

describe('contentHasher', () => {
	it('depends on the frames and their order', () => {
		const a = new Uint8Array(32).fill(1);
		const b = new Uint8Array(32).fill(2);
		const digest = (...frames: Uint8Array[]) => {
			const hasher = contentHasher();
			for (const frame of frames) hasher.add(frame);
			return hasher.digest();
		};

		expect(digest(a, b)).toEqual(digest(a, b));
		expect(digest(a, b)).not.toEqual(digest(b, a));
		expect(digest(a)).not.toEqual(digest(a, b));
	});
});
