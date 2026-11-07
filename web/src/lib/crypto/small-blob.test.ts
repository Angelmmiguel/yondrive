import { describe, expect, it } from 'vitest';
import { SealError } from './aead';
import { contentHashOf, contentHasher } from './content';
import { utf8 } from './encoding';
import { decodeManifest, encodeManifest, type VersionManifest } from './manifest';
import { ZeroKeyError } from './random';
import { sealerFor, SUITE_E2E, SUITE_NONE } from './sealer';

const e2e = sealerFor(SUITE_E2E);
const nodeKey = new Uint8Array(32).fill(7);

describe('thumbnails', () => {
	const stored = e2e.sealThumbnail(nodeKey, 'n1', 'b1', utf8('image'));

	it('opens only for its node and its blob, under its key', () => {
		expect(e2e.openThumbnail(nodeKey, 'n1', 'b1', stored)).toEqual(utf8('image'));
		expect(() => e2e.openThumbnail(nodeKey, 'n2', 'b1', stored)).toThrow(SealError);
		expect(() => e2e.openThumbnail(nodeKey, 'n1', 'b2', stored)).toThrow(SealError);
		expect(() => e2e.openThumbnail(new Uint8Array(32).fill(8), 'n1', 'b1', stored)).toThrow(
			SealError
		);
	});

	it('refuses a flipped byte', () => {
		const flipped = stored.slice();
		flipped[flipped.length - 1] ^= 1;
		expect(() => e2e.openThumbnail(nodeKey, 'n1', 'b1', flipped)).toThrow(SealError);
	});

	it('is not an index segment', () => {
		expect(() => e2e.openIndexSegment(nodeKey, 'b1', stored)).toThrow(SealError);
	});

	it('refuses a zeroed key', () => {
		expect(() => e2e.sealThumbnail(new Uint8Array(32), 'n1', 'b1', utf8('x'))).toThrow(
			ZeroKeyError
		);
	});
});

describe.each([
	['end-to-end', e2e, nodeKey],
	['none', sealerFor(SUITE_NONE), new Uint8Array(0)]
])('handing a version key to a worker in mode %s', (_, sealer, key) => {
	const ref = { nodeId: 'n1', versionId: 'v1', frameSize: 1024 };

	it('opens what the node key sealed', () => {
		const frame = sealer.openVersion(key, ref).sealFrame({ index: 0, final: true }, utf8('hi'));
		const cipher = sealer.openVersionKey(sealer.versionKey(key, ref), ref);

		expect(cipher.openFrame({ index: 0, final: true }, frame)).toEqual(utf8('hi'));
	});

	it('seals what the node key opens', () => {
		const frame = sealer
			.openVersionKey(sealer.versionKey(key, ref), ref)
			.sealFrame({ index: 0, final: true }, utf8('hi'));

		expect(sealer.openVersion(key, ref).openFrame({ index: 0, final: true }, frame)).toEqual(
			utf8('hi')
		);
	});
});

it('zeroes a handed over key on close', () => {
	const ref = { nodeId: 'n1', versionId: 'v1', frameSize: 1024 };
	const versionKey = e2e.versionKey(nodeKey, ref);
	const cipher = e2e.openVersionKey(versionKey, ref);
	cipher.close();

	expect(versionKey.every((byte) => byte === 0)).toBe(true);
	expect(() => cipher.sealFrame({ index: 0, final: true }, utf8('x'))).toThrow(ZeroKeyError);
});

describe('the manifest on the wire', () => {
	const manifest: VersionManifest = {
		nodeId: 'n1',
		versionId: 'v1',
		suite: SUITE_E2E,
		size: 5,
		frameSize: 1024,
		frameCount: 1,
		contentHash: new Uint8Array(32).fill(3)
	};

	it('round trips', () => {
		expect(decodeManifest(encodeManifest(manifest))).toEqual(manifest);
	});

	it.each([
		['not JSON', utf8('{')],
		['not an object', utf8('null')],
		['a field of the wrong type', utf8('{"nodeId":1}')],
		[
			'a short hash',
			utf8(
				'{"nodeId":"n","versionId":"v","suite":"none","size":1,"frameSize":1024,"frameCount":1,"contentHash":"AAAA"}'
			)
		],
		['not UTF-8', new Uint8Array([0xff])]
	])('refuses %s', (_, bytes) => {
		expect(() => decodeManifest(bytes)).toThrow(SealError);
	});
});

describe('contentHashOf', () => {
	it('matches the incremental hash', () => {
		const digests = new Uint8Array(64).map((_, i) => i);
		const hasher = contentHasher();
		hasher.add(digests.subarray(0, 32));
		hasher.add(digests.subarray(32));

		expect(contentHashOf(digests)).toEqual(hasher.digest());
	});

	it('refuses a list that is not whole digests', () => {
		expect(() => contentHashOf(new Uint8Array(33))).toThrow(SealError);
	});
});
