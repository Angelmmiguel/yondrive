/**
 * docs/crypto-vectors.json is produced independently of this code, so passing
 * here means the code implements docs/CRYPTO.md as written. Sealing is checked
 * byte for byte by feeding the recorded nonces and ephemeral keys through our
 * random source. The library draws its own blinding values, which change nothing.
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { open, seal, SealError } from './aead';
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
import { grantMessage, signGrant, verifyGrant } from './grant';
import {
	anchorMessage,
	commentMessage,
	openCommentAnchor,
	openCommentBody,
	sealCommentAnchor,
	sealCommentBody,
	signAnchor,
	signComment,
	verifyAnchor,
	verifyComment
} from './comment';
import {
	decodeLinkFragment,
	encodeLinkFragment,
	linkAuthKey,
	linkKek,
	openLinkNodeKey,
	openLinkOwnerCopy,
	sealLinkNodeKey,
	sealLinkOwnerCopy,
	unwrapLinkKey,
	wrapLinkKey
} from './link';
import {
	decodeRequestFragment,
	encodeRequestFragment,
	openNodeKeyFromRequest,
	openRequestPrivateKey,
	sealNodeKeyToRequest,
	sealRequestPrivateKey
} from './request';
import { signVersion, verifyVersion, versionMessage } from './manifest';
import { nameHmac, normalizeName, openMetadata, sealMetadata } from './metadata';
import {
	deriveNodeSubkeys,
	openNodeKeyFrom,
	openPreviousKey,
	sealNodeKeyTo,
	sealPreviousKey,
	unwrapNodeKey,
	unwrapRootNodeKey,
	wrapNodeKey,
	wrapRootNodeKey
} from './node';
import { checkPin, fingerprint, openPins, safetyNumber, sealPins } from './pinning';
import { formatRecoveryKey, parseRecoveryKey } from './recovery';
import { openIndexSegment, openThumbnail, sealIndexSegment, sealThumbnail } from './small-blob';
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

describe('small blobs', () => {
	const { thumbnail: t, index: i } = v.smallBlobs;

	it('seals and opens a thumbnail', () => {
		fixRandom(t.nonce);

		expect(bytesToHex(sealThumbnail(h(t.nodeKey), t.nodeId, t.blobId, h(t.plaintext)))).toBe(
			t.sealed
		);
		expect(bytesToHex(openThumbnail(h(t.nodeKey), t.nodeId, t.blobId, h(t.sealed)))).toBe(
			t.plaintext
		);
	});

	it('seals and opens an index segment', () => {
		fixRandom(i.nonce);

		expect(bytesToHex(sealIndexSegment(h(i.masterKey), i.blobId, h(i.plaintext)))).toBe(i.sealed);
		expect(bytesToHex(openIndexSegment(h(i.masterKey), i.blobId, h(i.sealed)))).toBe(i.plaintext);
	});

	it('stores them as they are in suite none', () => {
		const none = sealerFor(SUITE_NONE);
		const nothing = new Uint8Array(0);

		expect(bytesToHex(none.sealThumbnail(nothing, t.nodeId, t.blobId, h(t.plaintext)))).toBe(
			t.plaintext
		);
		expect(bytesToHex(none.openThumbnail(nothing, t.nodeId, t.blobId, h(t.plaintext)))).toBe(
			t.plaintext
		);
		expect(bytesToHex(none.sealIndexSegment(nothing, i.blobId, h(i.plaintext)))).toBe(i.plaintext);
		expect(bytesToHex(none.openIndexSegment(nothing, i.blobId, h(i.plaintext)))).toBe(i.plaintext);
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

describe('grant signature', () => {
	const g = v.grantSignature;
	const grant = {
		nodeId: g.nodeId,
		granterId: g.granterId,
		granteeId: g.granteeId,
		role: g.role,
		generation: g.generation,
		sealedKey: h(g.grant)
	};

	it('signs the documented message', () => {
		expect(bytesToHex(grantMessage(grant))).toBe(g.message);
		expect(bytesToHex(signGrant(grant, h(g.ed25519Private)))).toBe(g.signature);
	});

	it('verifies, and refuses a change to anything signed', () => {
		expect(() => verifyGrant(grant, h(g.signature), h(g.ed25519Public))).not.toThrow();
		expect(() =>
			verifyGrant({ ...grant, role: 'viewer' }, h(g.signature), h(g.ed25519Public))
		).toThrow(SealError);
		expect(() =>
			verifyGrant({ ...grant, generation: 4 }, h(g.signature), h(g.ed25519Public))
		).toThrow(SealError);
	});
});

describe('previous key', () => {
	const p = v.previousKey;

	it('derives the subkey, seals and opens', () => {
		fixRandom(p.nonce);

		expect(bytesToHex(expand(h(p.newKey), 'yondrive/node-previous/v1'))).toBe(p.subkey);
		expect(bytesToHex(sealPreviousKey(h(p.newKey), h(p.plaintext), p.nodeId, p.generation))).toBe(
			p.sealed
		);
		expect(bytesToHex(openPreviousKey(h(p.sealed), h(p.newKey), p.nodeId, p.generation))).toBe(
			p.plaintext
		);
		expect(() => openPreviousKey(h(p.sealed), h(p.newKey), p.nodeId, p.generation + 1)).toThrow(
			SealError
		);
	});
});

describe('public link', () => {
	const l = v.link;

	it('seals and opens the node key under the link key', () => {
		fixRandom(l.nodeKey.nonce);

		expect(
			bytesToHex(sealLinkNodeKey(h(l.nodeKey.plaintext), h(l.linkKey), l.linkId, l.nodeId))
		).toBe(l.nodeKey.sealed);
		expect(bytesToHex(openLinkNodeKey(h(l.nodeKey.sealed), h(l.linkKey), l.linkId, l.nodeId))).toBe(
			l.nodeKey.plaintext
		);
	});

	it('seals and opens the owner copy', () => {
		fixRandom(l.owner.nonce);

		expect(bytesToHex(sealLinkOwnerCopy(h(l.linkKey), h(l.owner.masterKey), l.linkId))).toBe(
			l.owner.sealed
		);
		expect(bytesToHex(openLinkOwnerCopy(h(l.owner.sealed), h(l.owner.masterKey), l.linkId))).toBe(
			l.linkKey
		);
	});

	it('splits a password root and wraps the link key', () => {
		const { root, authKey, kek, nonce, sealed } = l.password;
		fixRandom(nonce);

		expect(bytesToHex(linkAuthKey(h(root)))).toBe(authKey);
		expect(bytesToHex(linkKek(h(root)))).toBe(kek);
		expect(bytesToHex(wrapLinkKey(h(l.linkKey), h(kek), l.linkId))).toBe(sealed);
		expect(bytesToHex(unwrapLinkKey(h(sealed), h(kek), l.linkId))).toBe(l.linkKey);
	});

	it('gives the same auth key in suite none, and no key at all', () => {
		const none = sealerFor(SUITE_NONE);

		expect(bytesToHex(none.linkPasswordKeys(h(l.password.root)).authKey)).toBe(l.password.authKey);
		expect(none.linkPasswordKeys(h(l.password.root)).kek).toHaveLength(0);
		expect(none.linkFragment(h(l.linkKey))).toBe('');
	});

	it('carries the key as unpadded base64url', () => {
		expect(encodeLinkFragment(h(l.linkKey))).toBe(l.fragment);
		expect(bytesToHex(decodeLinkFragment(l.fragment))).toBe(l.linkKey);
		expect(decodeLinkFragment('not a key')).toHaveLength(0);
	});
});

describe('pins', () => {
	const p = v.pins;

	it('seals and opens under a key from the master key', () => {
		fixRandom(p.nonce);

		expect(bytesToHex(sealPins(h(p.plaintext), h(p.masterKey), p.userId))).toBe(p.sealed);
		expect(bytesToHex(openPins(h(p.sealed), h(p.masterKey), p.userId))).toBe(p.plaintext);
		expect(() => openPins(h(p.sealed), h(p.masterKey), 'someone-else')).toThrow(SealError);
	});
});

describe('file request', () => {
	const r = v.request;
	const keys = { privateKey: h(r.privateKey), publicKey: h(r.publicKey) };

	it('seals and opens the private key under the master key, bound to its key and folder', () => {
		fixRandom(r.owner.nonce);
		const master = h(r.owner.masterKey);
		const sealed = h(r.owner.sealed);

		expect(bytesToHex(sealRequestPrivateKey(keys, master, r.linkId, r.folderId))).toBe(
			r.owner.sealed
		);
		expect(
			bytesToHex(openRequestPrivateKey(sealed, master, r.linkId, keys.publicKey, r.folderId))
		).toBe(r.privateKey);
		const other = h(v.grant.recipientPublic);
		expect(() => openRequestPrivateKey(sealed, master, r.linkId, other, r.folderId)).toThrow(
			SealError
		);
		expect(() =>
			openRequestPrivateKey(sealed, master, r.linkId, keys.publicKey, 'node-elsewhere')
		).toThrow(SealError);
	});

	it('seals a node key to the request and opens it with its private key', () => {
		const n = r.nodeKey;
		fixRandom(n.ephemeralPrivate, n.nonce);

		expect(
			bytesToHex(sealNodeKeyToRequest(h(n.plaintext), keys.publicKey, r.linkId, r.nodeId))
		).toBe(n.sealed);
		expect(bytesToHex(openNodeKeyFromRequest(h(n.sealed), keys, r.linkId, r.nodeId))).toBe(
			n.plaintext
		);
		expect(() => openNodeKeyFromRequest(h(n.sealed), keys, 'link-other', r.nodeId)).toThrow(
			SealError
		);
		expect(() => openNodeKeyFromRequest(h(n.sealed), keys, r.linkId, 'node-other')).toThrow(
			SealError
		);
	});

	it('carries the public key as unpadded base64url, and nothing in suite none', () => {
		expect(encodeRequestFragment(keys.publicKey)).toBe(r.fragment);
		expect(bytesToHex(decodeRequestFragment(r.fragment))).toBe(r.publicKey);
		expect(decodeRequestFragment('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toHaveLength(0);
		expect(decodeRequestFragment('short')).toHaveLength(0);
		expect(sealerFor(SUITE_NONE).requestFragment(keys.publicKey)).toBe('');
	});
});

describe('comment', () => {
	const c = v.comment;
	const ref = {
		nodeId: c.nodeId,
		threadId: c.threadId,
		commentId: c.commentId,
		generation: c.generation
	};
	const at = { nodeId: c.nodeId, threadId: c.threadId, generation: c.generation };

	it('derives the comment subkey', () => {
		expect(bytesToHex(expand(h(c.nodeKey), 'yondrive/comment/v1'))).toBe(c.commentKey);
	});

	it('seals and opens a body and an anchor', () => {
		fixRandom(c.body.nonce, c.anchor.nonce);

		expect(bytesToHex(sealCommentBody(h(c.nodeKey), ref, JSON.parse(c.body.json)))).toBe(
			c.body.sealed
		);
		expect(bytesToHex(sealCommentAnchor(h(c.nodeKey), at, JSON.parse(c.anchor.json)))).toBe(
			c.anchor.sealed
		);
		expect(openCommentBody(h(c.nodeKey), ref, h(c.body.sealed))).toEqual(JSON.parse(c.body.json));
		expect(openCommentAnchor(h(c.nodeKey), at, h(c.anchor.sealed))).toEqual(
			JSON.parse(c.anchor.json)
		);
	});

	it('binds the ids and the generation', () => {
		for (const other of [
			{ ...ref, commentId: c.threadId },
			{ ...ref, threadId: c.commentId },
			{ ...ref, nodeId: 'node-2' },
			{ ...ref, generation: 3 }
		]) {
			expect(() => openCommentBody(h(c.nodeKey), other, h(c.body.sealed))).toThrow(SealError);
		}
		expect(() =>
			openCommentAnchor(h(c.nodeKey), { ...at, generation: 1 }, h(c.anchor.sealed))
		).toThrow(SealError);
	});

	it('signs the documented messages', () => {
		const body = { ...ref, authorId: c.authorId, sealed: h(c.body.sealed) };
		const anchor = { ...at, signerId: c.signerId, sealed: h(c.anchor.sealed) };

		expect(bytesToHex(commentMessage(body))).toBe(c.body.message);
		expect(bytesToHex(signComment(body, h(c.body.ed25519Private)))).toBe(c.body.signature);
		expect(bytesToHex(anchorMessage(anchor))).toBe(c.anchor.message);
		expect(bytesToHex(signAnchor(anchor, h(c.anchor.ed25519Private)))).toBe(c.anchor.signature);
	});

	it('verifies, and refuses another author, signer or comment', () => {
		const body = { ...ref, authorId: c.authorId, sealed: h(c.body.sealed) };
		const anchor = { ...at, signerId: c.signerId, sealed: h(c.anchor.sealed) };
		const pub = h(c.body.ed25519Public);

		expect(() => verifyComment(body, h(c.body.signature), pub)).not.toThrow();
		expect(() =>
			verifyComment({ ...body, authorId: 'user-other' }, h(c.body.signature), pub)
		).toThrow(SealError);
		expect(() =>
			verifyComment({ ...body, commentId: 'comment-3' }, h(c.body.signature), pub)
		).toThrow(SealError);
		expect(() => verifyComment(body, h(c.body.signature), h(c.anchor.ed25519Public))).toThrow(
			SealError
		);
		expect(() =>
			verifyAnchor(anchor, h(c.anchor.signature), h(c.anchor.ed25519Public))
		).not.toThrow();
		expect(() =>
			verifyAnchor({ ...anchor, signerId: c.authorId }, h(c.anchor.signature), pub)
		).toThrow(SealError);
	});

	it('is readable JSON with no signature in suite none', () => {
		const none = sealerFor(SUITE_NONE);
		const nothing = new Uint8Array(0);
		const stored = none.sealCommentBody(nothing, ref, JSON.parse(c.body.json));

		expect(new TextDecoder().decode(stored)).toBe(c.body.json);
		expect(none.openCommentBody(nothing, ref, stored)).toEqual(JSON.parse(c.body.json));
		const anchor = new TextEncoder().encode(c.anchor.json);
		expect(none.openCommentAnchor(nothing, at, anchor)).toEqual(JSON.parse(c.anchor.json));
		const { keys } = none.createUser(nothing, nothing);
		const signed = { ...ref, authorId: c.authorId, sealed: stored };
		expect(none.signComment(signed, keys)).toHaveLength(0);
		expect(() =>
			none.verifyComment(signed, nothing, { x25519: nothing, ed25519: nothing })
		).not.toThrow();
	});
});
