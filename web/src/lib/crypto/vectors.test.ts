/**
 * docs/crypto-vectors.json is produced independently of this code, so passing
 * here means the code implements docs/CRYPTO.md as written. Sealing is checked
 * byte for byte by feeding the recorded nonces and ephemeral keys through our
 * random source. The library draws its own blinding values, which change nothing.
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { open, seal } from './aead';
import { decryptFrame, deriveVersionKey, encryptFrame, frameCountFor } from './content';
import { encodeBase64, encodeFields } from './encoding';
import { deriveRoot, expand, expandRoot, type KdfParams } from './kdf';
import {
	openIdentity,
	sealIdentity,
	unwrapMasterKey,
	wrapMasterKey,
	type WrapPurpose
} from './keys';
import { signVersion, verifyVersion, versionMessage } from './manifest';
import { nameHmac, normalizeName, openMetadata, sealMetadata } from './metadata';
import {
	deriveNodeSubkeys,
	openNodeKeyFrom,
	sealNodeKeyTo,
	unwrapNodeKey,
	unwrapRootNodeKey,
	wrapNodeKey,
	wrapRootNodeKey
} from './node';
import { checkPin, fingerprint, safetyNumber } from './pinning';
import { formatRecoveryKey, parseRecoveryKey } from './recovery';
import { sealerFor, SUITE_E2E, SUITE_NONE } from './sealer';
import { FrameReader, FrameWriter } from './stream';

const v = JSON.parse(
	readFileSync(new URL('../../../../docs/crypto-vectors.json', import.meta.url), 'utf8')
);
const h = hexToBytes;

const draws = vi.hoisted(() => ({ queue: [] as Uint8Array[] }));

vi.mock('./random', async (original) => ({
	...(await original<typeof import('./random')>()),
	randomBytes(n: number) {
		const next = draws.queue.shift();
		if (next === undefined || next.length !== n) throw new Error('unexpected draw of random bytes');
		return next;
	}
}));

/** Makes the next draws of our random source return these values, in order. */
function fixRandom(...values: string[]): void {
	draws.queue = values.map((value) => h(value));
}

afterEach(() => {
	expect(draws.queue).toEqual([]);
});

describe('field encoding', () => {
	it('matches', () => {
		const { label, fields, encoded } = v.fieldsEncoding;

		expect(bytesToHex(encodeFields(label, ...fields.map(h)))).toBe(encoded);
	});
});

describe('kdf', () => {
	it.each(
		v.kdf as {
			passphrase: string;
			salt: string;
			m: number;
			t: number;
			p: number;
			root: string;
			kek: string;
			authKey: string;
		}[]
	)('derives from "$passphrase"', ({ passphrase, salt, m, t, p, root, kek, authKey }) => {
		const params: KdfParams = { name: 'argon2id', m, t, p, salt: encodeBase64(h(salt)) };
		const derived = deriveRoot(passphrase, params);
		const keys = expandRoot(derived);

		expect(bytesToHex(derived)).toBe(root);
		expect(bytesToHex(keys.kek)).toBe(kek);
		expect(bytesToHex(keys.authKey)).toBe(authKey);
	});
});

describe('recovery', () => {
	it('encodes the key and derives from it', () => {
		const { entropy, phrase, kek, authKey } = v.recovery;
		const keys = expandRoot(parseRecoveryKey(phrase));

		expect(formatRecoveryKey(h(entropy))).toBe(phrase);
		expect(bytesToHex(keys.kek)).toBe(kek);
		expect(bytesToHex(keys.authKey)).toBe(authKey);
	});
});

describe('sealed format', () => {
	it('seals and opens', () => {
		const { key, nonce, aad, plaintext, sealed } = v.seal;
		fixRandom(nonce);

		expect(bytesToHex(seal(h(key), h(plaintext), h(aad)))).toBe(sealed);
		expect(bytesToHex(open(h(key), h(sealed), h(aad)))).toBe(plaintext);
	});
});

describe('master key wraps', () => {
	it.each(
		v.masterWrap as {
			purpose: WrapPurpose;
			key: string;
			nonce: string;
			plaintext: string;
			sealed: string;
		}[]
	)('$purpose', ({ purpose, key, nonce, plaintext, sealed }) => {
		fixRandom(nonce);

		expect(bytesToHex(wrapMasterKey(h(plaintext), h(key), purpose))).toBe(sealed);
		expect(bytesToHex(unwrapMasterKey(h(sealed), h(key), purpose))).toBe(plaintext);
	});
});

describe('identity', () => {
	it('seals and opens', () => {
		const i = v.identity;
		const identity = {
			x25519: { publicKey: h(i.x25519Public), privateKey: h(i.x25519Private) },
			ed25519: { publicKey: h(i.ed25519Public), privateKey: h(i.ed25519Private) }
		};
		fixRandom(i.x25519Nonce, i.ed25519Nonce);

		const sealed = sealIdentity(identity, h(i.master));

		expect(bytesToHex(sealed.sealedX25519)).toBe(i.sealedX25519);
		expect(bytesToHex(sealed.sealedEd25519)).toBe(i.sealedEd25519);
		expect(openIdentity(sealed, h(i.master))).toEqual(identity);
	});
});

describe('node keys', () => {
	it('derives the subkeys', () => {
		const { nodeKey, meta, name, content } = v.nodeSubkeys;
		const keys = deriveNodeSubkeys(h(nodeKey));

		expect(bytesToHex(keys.meta)).toBe(meta);
		expect(bytesToHex(keys.name)).toBe(name);
		expect(bytesToHex(keys.content)).toBe(content);
	});

	it('wraps a root node key', () => {
		const { key, nonce, plaintext, nodeId, sealed } = v.rootWrap;
		fixRandom(nonce);

		expect(bytesToHex(wrapRootNodeKey(h(plaintext), h(key), nodeId))).toBe(sealed);
		expect(bytesToHex(unwrapRootNodeKey(h(sealed), h(key), nodeId))).toBe(plaintext);
	});

	it('wraps a child node key', () => {
		const { parentKey, parentId, nodeId, nonce, plaintext, key, sealed } = v.childWrap;
		fixRandom(nonce);

		expect(bytesToHex(expand(h(parentKey), 'yondrive/node-wrap/v1'))).toBe(key);
		expect(bytesToHex(wrapNodeKey(h(plaintext), h(parentKey), parentId, nodeId))).toBe(sealed);
		expect(bytesToHex(unwrapNodeKey(h(sealed), h(parentKey), parentId, nodeId))).toBe(plaintext);
	});

	it('seals a grant', () => {
		const g = v.grant;
		fixRandom(g.ephemeralPrivate, g.nonce);

		expect(bytesToHex(sealNodeKeyTo(h(g.nodeKey), h(g.recipientPublic), g.nodeId))).toBe(g.sealed);
		expect(
			bytesToHex(
				openNodeKeyFrom(
					h(g.sealed),
					{ publicKey: h(g.recipientPublic), privateKey: h(g.recipientPrivate) },
					g.nodeId
				)
			)
		).toBe(g.nodeKey);
	});
});

describe('metadata', () => {
	const { nodeKey, nodeId, json, nonce, sealed, noneStored } = v.metadata;

	it('seals and opens', () => {
		fixRandom(nonce);

		expect(bytesToHex(sealMetadata(h(nodeKey), nodeId, JSON.parse(json)))).toBe(sealed);
		expect(openMetadata(h(nodeKey), nodeId, h(sealed))).toEqual(JSON.parse(json));
	});

	it('is the JSON bytes in suite none', () => {
		const none = sealerFor(SUITE_NONE);

		expect(bytesToHex(none.sealMetadata(new Uint8Array(0), nodeId, JSON.parse(json)))).toBe(
			noneStored
		);
		expect(none.openMetadata(new Uint8Array(0), nodeId, h(noneStored))).toEqual(JSON.parse(json));
	});
});

describe('names', () => {
	it.each(v.names.cases as { name: string; normalized: string; hmac: string; noneTag: string }[])(
		'tags "$name"',
		({ name, normalized, hmac, noneTag }) => {
			expect(normalizeName(name)).toBe(normalized);
			expect(bytesToHex(nameHmac(h(v.names.parentKey), name))).toBe(hmac);
			expect(bytesToHex(sealerFor(SUITE_NONE).nameTag(new Uint8Array(0), name))).toBe(noneTag);
		}
	);
});

interface FrameVector {
	index: number;
	final: boolean;
	plaintext: string;
	nonce: string;
	sealed: string;
	sha256: string;
}

describe('content', () => {
	const c = v.content;
	const ref = { nodeId: c.nodeId, versionId: c.versionId, frameSize: c.frameSize };

	it('derives the version key', () => {
		expect(bytesToHex(deriveVersionKey(h(c.nodeKey), ref))).toBe(c.versionKey);
	});

	it('seals and opens each frame', () => {
		for (const frame of c.frames as FrameVector[]) {
			const position = { index: frame.index, final: frame.final };
			fixRandom(frame.nonce);

			expect(bytesToHex(encryptFrame(h(c.versionKey), ref, position, h(frame.plaintext)))).toBe(
				frame.sealed
			);
			expect(bytesToHex(decryptFrame(h(c.versionKey), ref, position, h(frame.sealed)))).toBe(
				frame.plaintext
			);
		}
	});

	it('writes the same stream and manifest through the sealer', () => {
		const writer = new FrameWriter(sealerFor(SUITE_E2E), h(c.nodeKey), ref);
		for (const frame of c.frames as FrameVector[]) {
			fixRandom(frame.nonce);
			const sealed = writer.write(h(frame.plaintext), frame.final);
			expect(bytesToHex(sealed.data)).toBe(frame.sealed);
			expect(bytesToHex(sealed.sha256)).toBe(frame.sha256);
		}
		const manifest = writer.finish();

		expect(manifest.size).toBe(c.size);
		expect(manifest.frameCount).toBe(c.frames.length);
		expect(frameCountFor(c.size, c.frameSize)).toBe(c.frames.length);
		expect(bytesToHex(manifest.contentHash)).toBe(c.contentHash);
	});

	it('reads the stream back through the sealer', () => {
		const manifest = {
			...ref,
			suite: SUITE_E2E,
			size: c.size,
			frameCount: c.frames.length,
			contentHash: h(c.contentHash)
		};
		const reader = new FrameReader(sealerFor(SUITE_E2E), h(c.nodeKey), manifest);
		for (const frame of c.frames as FrameVector[]) {
			const plaintext = reader.read({ data: h(frame.sealed), sha256: h(frame.sha256) });
			expect(bytesToHex(plaintext)).toBe(frame.plaintext);
		}

		expect(() => reader.finish()).not.toThrow();
	});

	it('writes and reads the same way in suite none', () => {
		const n = v.contentNone;
		const noneRef = { nodeId: n.nodeId, versionId: n.versionId, frameSize: n.frameSize };
		const sealer = sealerFor(SUITE_NONE);
		const writer = new FrameWriter(sealer, new Uint8Array(0), noneRef);
		for (const frame of n.frames as FrameVector[]) {
			const sealed = writer.write(h(frame.plaintext), frame.final);
			expect(bytesToHex(sealed.data)).toBe(frame.plaintext);
			expect(bytesToHex(sealed.sha256)).toBe(frame.sha256);
		}
		const manifest = writer.finish();

		expect(bytesToHex(manifest.contentHash)).toBe(n.contentHash);
		const reader = new FrameReader(sealer, new Uint8Array(0), manifest);
		for (const frame of n.frames as FrameVector[]) {
			expect(bytesToHex(reader.read({ data: h(frame.plaintext), sha256: h(frame.sha256) }))).toBe(
				frame.plaintext
			);
		}
		expect(() => reader.finish()).not.toThrow();
	});
});

describe('version signature', () => {
	const m = v.manifest;
	const manifest = {
		nodeId: m.nodeId,
		versionId: m.versionId,
		suite: m.suite,
		size: m.size,
		frameSize: m.frameSize,
		frameCount: m.frameCount,
		contentHash: h(m.contentHash)
	};

	it('signs the documented message', () => {
		expect(bytesToHex(versionMessage(manifest))).toBe(m.message);
		expect(bytesToHex(signVersion(manifest, h(m.ed25519Private)))).toBe(m.signature);
	});

	it('verifies', () => {
		expect(() => verifyVersion(manifest, h(m.signature), h(m.ed25519Public))).not.toThrow();
	});
});

describe('pinning', () => {
	const { alice, bob, safetyNumber: expected } = v.pinning;
	const print = (user: { x25519: string; ed25519: string }) =>
		fingerprint({ x25519: h(user.x25519), ed25519: h(user.ed25519) });

	it('computes the fingerprints', () => {
		expect(bytesToHex(print(alice))).toBe(alice.fingerprint);
		expect(bytesToHex(print(bob))).toBe(bob.fingerprint);
		expect(checkPin(h(alice.fingerprint), print(alice))).toBe('match');
	});

	it('computes the safety number in either order', () => {
		expect(safetyNumber(print(alice), print(bob))).toBe(expected);
		expect(safetyNumber(print(bob), print(alice))).toBe(expected);
	});
});
