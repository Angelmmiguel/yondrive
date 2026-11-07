import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { seal, SealError } from './aead';
import { encodeFields, utf8 } from './encoding';
import { generateIdentity } from './keys';
import {
	deriveNodeSubkeys,
	generateNodeKey,
	openNodeKeyFrom,
	sealNodeKeyTo,
	unwrapNodeKey,
	unwrapRootNodeKey,
	wrapNodeKey,
	wrapRootNodeKey
} from './node';
import { ZeroKeyError } from './random';

const nodeKey = new Uint8Array(32).map((_, i) => i + 10);
const parentKey = new Uint8Array(32).map((_, i) => i + 90);
const master = new Uint8Array(32).map((_, i) => i + 170);

describe('generateNodeKey', () => {
	it('is 32 random bytes', () => {
		const key = generateNodeKey();

		expect(key).toHaveLength(32);
		expect(key).not.toEqual(generateNodeKey());
	});
});

describe('deriveNodeSubkeys', () => {
	it('is HKDF-SHA256 without salt under the documented labels', () => {
		const derive = (label: string) => hkdf(sha256, nodeKey, undefined, utf8(label), 32);

		expect(deriveNodeSubkeys(nodeKey)).toEqual({
			meta: derive('yondrive/meta/v1'),
			name: derive('yondrive/name/v1'),
			content: derive('yondrive/content/v1')
		});
	});

	it('gives three distinct keys', () => {
		const { meta, name, content } = deriveNodeSubkeys(nodeKey);

		expect(meta).not.toEqual(name);
		expect(name).not.toEqual(content);
		expect(meta).not.toEqual(content);
	});

	it('refuses a zeroed or absent node key', () => {
		expect(() => deriveNodeSubkeys(new Uint8Array(32))).toThrow(ZeroKeyError);
		expect(() => deriveNodeSubkeys(new Uint8Array(0))).toThrow(RangeError);
	});
});

describe('root node key', () => {
	it('round-trips under the master key', () => {
		expect(unwrapRootNodeKey(wrapRootNodeKey(nodeKey, master, 'n1'), master, 'n1')).toEqual(
			nodeKey
		);
	});

	it('is bound to its node', () => {
		const sealed = wrapRootNodeKey(nodeKey, master, 'n1');

		expect(() => unwrapRootNodeKey(sealed, master, 'n2')).toThrow(SealError);
	});
});

describe('zeroed key material', () => {
	const zeroed = new Uint8Array(32);

	it('cannot be wrapped', () => {
		expect(() => wrapRootNodeKey(zeroed, master, 'n1')).toThrow(ZeroKeyError);
		expect(() => wrapNodeKey(zeroed, parentKey, 'parent', 'child')).toThrow(ZeroKeyError);
	});

	it('is refused when opened', () => {
		const root = seal(master, zeroed, encodeFields('yondrive/node/root/v1', utf8('n1')));

		expect(() => unwrapRootNodeKey(root, master, 'n1')).toThrow(
			expect.objectContaining({ code: 'format' })
		);
	});
});

describe('wrapNodeKey', () => {
	const sealed = wrapNodeKey(nodeKey, parentKey, 'parent', 'child');

	it('round-trips under the parent key', () => {
		expect(unwrapNodeKey(sealed, parentKey, 'parent', 'child')).toEqual(nodeKey);
	});

	it('does not use the parent key directly as a cipher key', () => {
		const aad = encodeFields('yondrive/node/child/v1', utf8('parent'), utf8('child'));

		expect(() =>
			unwrapNodeKey(seal(parentKey, nodeKey, aad), parentKey, 'parent', 'child')
		).toThrow(SealError);
	});

	it.each([
		['node', 'parent', 'other'],
		['parent', 'other', 'child'],
		['moved between the two ids', 'child', 'parent']
	])('is bound to its %s', (_, parentId, nodeId) => {
		expect(() => unwrapNodeKey(sealed, parentKey, parentId, nodeId)).toThrow(SealError);
	});

	it('refuses another parent key and empty ids', () => {
		expect(() => unwrapNodeKey(sealed, master, 'parent', 'child')).toThrow(SealError);
		expect(() => wrapNodeKey(nodeKey, parentKey, '', 'child')).toThrow(TypeError);
	});
});

describe('sealNodeKeyTo', () => {
	const alice = generateIdentity().x25519;
	const bob = generateIdentity().x25519;

	it('round-trips to the recipient, with the documented size', () => {
		const sealed = sealNodeKeyTo(nodeKey, alice.publicKey, 'n1');

		expect(sealed).toHaveLength(32 + 41 + 32);
		expect(openNodeKeyFrom(sealed, alice, 'n1')).toEqual(nodeKey);
	});

	it('uses a fresh ephemeral key every time', () => {
		const a = sealNodeKeyTo(nodeKey, alice.publicKey, 'n1');
		const b = sealNodeKeyTo(nodeKey, alice.publicKey, 'n1');

		expect(a.subarray(0, 32)).not.toEqual(b.subarray(0, 32));
	});

	it('refuses anyone else', () => {
		const sealed = sealNodeKeyTo(nodeKey, alice.publicKey, 'n1');

		expect(() => openNodeKeyFrom(sealed, bob, 'n1')).toThrow(SealError);
	});

	it('is bound to the node', () => {
		const sealed = sealNodeKeyTo(nodeKey, alice.publicKey, 'n1');

		expect(() => openNodeKeyFrom(sealed, alice, 'n2')).toThrow(SealError);
	});

	it('binds the recipient public key', () => {
		const sealed = sealNodeKeyTo(nodeKey, alice.publicKey, 'n1');
		const liar = { privateKey: alice.privateKey, publicKey: bob.publicKey };

		expect(() => openNodeKeyFrom(sealed, liar, 'n1')).toThrow(SealError);
	});

	it('binds the ephemeral public key', () => {
		const sealed = sealNodeKeyTo(nodeKey, alice.publicKey, 'n1');
		sealed[0] ^= 0x01;

		expect(() => openNodeKeyFrom(sealed, alice, 'n1')).toThrow(SealError);
	});

	it.each([
		['zero', new Uint8Array(32)],
		['one', new Uint8Array(32).map((_, i) => (i === 0 ? 1 : 0))]
	])('refuses the low-order public key %s', (_, lowOrder) => {
		expect(() => sealNodeKeyTo(nodeKey, lowOrder, 'n1')).toThrow(SealError);
		const forged = new Uint8Array(32 + 41 + 32);
		forged.set(lowOrder);
		expect(() => openNodeKeyFrom(forged, alice, 'n1')).toThrow(SealError);
	});

	it('refuses data too short to hold an ephemeral key', () => {
		expect(() => openNodeKeyFrom(new Uint8Array(31), alice, 'n1')).toThrow(SealError);
	});

	it('refuses to open with a zeroed private key, which anyone could seal to', () => {
		const zeroed = { publicKey: alice.publicKey, privateKey: new Uint8Array(32) };
		const sealed = sealNodeKeyTo(nodeKey, alice.publicKey, 'n1');

		expect(() => openNodeKeyFrom(sealed, zeroed, 'n1')).toThrow(ZeroKeyError);
	});

	it('refuses a zeroed node key', () => {
		expect(() => sealNodeKeyTo(new Uint8Array(32), alice.publicKey, 'n1')).toThrow(ZeroKeyError);
	});
});
