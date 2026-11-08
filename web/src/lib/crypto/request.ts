/**
 * File requests, as docs/CRYPTO.md section 20 has them. A request has an X25519 key
 * pair of its own. Its public key travels in the URL's fragment, which is what vouches
 * for it: a sender seals each file's node key to that key and to no key the server
 * names. Its private key is kept under the owner's master key, and opens what arrives.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { base64urlnopad } from '@scure/base';
import { open, seal, SealError } from './aead';
import { encodeFields, idBytes, type Bytes } from './encoding';
import { expand } from './kdf';
import type { KeyPair } from './keys';
import { assertKey, constantTimeEqual, KEY_LENGTH, randomBytes, zero } from './random';

const EPHEMERAL_LENGTH = 32;

/** A fresh key pair for a request. */
export function generateRequestKeys(): KeyPair {
	const privateKey = randomBytes(KEY_LENGTH);
	return { privateKey, publicKey: x25519.getPublicKey(privateKey) as Bytes };
}

const ownerAad = (linkId: string, publicKey: Uint8Array, folderId: string) =>
	encodeFields('yondrive/request/owner/v1', idBytes(linkId), publicKey, idBytes(folderId));

const nodeAad = (ephemeral: Uint8Array, publicKey: Uint8Array, linkId: string, nodeId: string) =>
	encodeFields('yondrive/request/node/v1', ephemeral, publicKey, idBytes(linkId), idBytes(nodeId));

function liveKey(key: Bytes): Bytes {
	if (key.length !== KEY_LENGTH || constantTimeEqual(key, new Uint8Array(KEY_LENGTH))) {
		throw new SealError('format');
	}
	return key;
}

/** The request's private key, sealed under the owner's master key with its public key and its folder bound. */
export function sealRequestPrivateKey(
	keys: KeyPair,
	master: Uint8Array,
	linkId: string,
	folderId: string
): Bytes {
	assertKey(keys.privateKey);
	const wrap = expand(master, 'yondrive/request-owner/v1');
	try {
		return seal(wrap, keys.privateKey, ownerAad(linkId, keys.publicKey, folderId));
	} finally {
		zero(wrap);
	}
}

/**
 * Opens the private key, and checks it against the public key the server has, which
 * is the one the URL carries, and the folder the server names: a mismatch in either means it
 * is not what the owner made.
 */
export function openRequestPrivateKey(
	stored: Uint8Array,
	master: Uint8Array,
	linkId: string,
	publicKey: Uint8Array,
	folderId: string
): Bytes {
	const wrap = expand(master, 'yondrive/request-owner/v1');
	let privateKey: Bytes;
	try {
		privateKey = liveKey(open(wrap, stored, ownerAad(linkId, publicKey, folderId)));
	} finally {
		zero(wrap);
	}
	if (!constantTimeEqual(x25519.getPublicKey(privateKey), publicKey)) {
		zero(privateKey);
		throw new SealError('format');
	}
	return privateKey;
}

function wrapKeyOf(
	privateKey: Uint8Array,
	peer: Uint8Array,
	ephemeral: Uint8Array,
	publicKey: Uint8Array
): Bytes {
	let shared: Uint8Array;
	try {
		shared = x25519.getSharedSecret(privateKey, peer);
	} catch {
		throw new SealError('format');
	}
	try {
		return expand(shared, encodeFields('yondrive/request/key/v1', ephemeral, publicKey));
	} finally {
		zero(shared);
	}
}

/** A file's node key, sealed by its sender to the request's public key. */
export function sealNodeKeyToRequest(
	nodeKey: Uint8Array,
	publicKey: Uint8Array,
	linkId: string,
	nodeId: string
): Bytes {
	assertKey(nodeKey);
	const ephemeral = randomBytes(EPHEMERAL_LENGTH);
	const ephemeralPublic = x25519.getPublicKey(ephemeral);
	const wrap = wrapKeyOf(ephemeral, publicKey, ephemeralPublic, publicKey);
	try {
		const sealed = seal(wrap, nodeKey, nodeAad(ephemeralPublic, publicKey, linkId, nodeId));
		const out = new Uint8Array(EPHEMERAL_LENGTH + sealed.length);
		out.set(ephemeralPublic);
		out.set(sealed, EPHEMERAL_LENGTH);
		return out;
	} finally {
		zero(ephemeral, wrap);
	}
}

/** Opens what `sealNodeKeyToRequest` made, with the request's key pair. */
export function openNodeKeyFromRequest(
	sealed: Uint8Array,
	keys: KeyPair,
	linkId: string,
	nodeId: string
): Bytes {
	assertKey(keys.privateKey);
	if (sealed.length < EPHEMERAL_LENGTH) throw new SealError('length');
	const ephemeralPublic = sealed.subarray(0, EPHEMERAL_LENGTH);
	const wrap = wrapKeyOf(keys.privateKey, ephemeralPublic, ephemeralPublic, keys.publicKey);
	try {
		const aad = nodeAad(ephemeralPublic, keys.publicKey, linkId, nodeId);
		return liveKey(open(wrap, sealed.subarray(EPHEMERAL_LENGTH), aad));
	} finally {
		zero(wrap);
	}
}

/** A request's public key as a URL's fragment carries it: unpadded base64url. */
export function encodeRequestFragment(publicKey: Uint8Array): string {
	return base64urlnopad.encode(publicKey);
}

/** The public key in a fragment, or empty bytes if what is there is not one. */
export function decodeRequestFragment(fragment: string): Bytes {
	try {
		const key = Uint8Array.from(base64urlnopad.decode(fragment));
		return key.length === KEY_LENGTH && !constantTimeEqual(key, new Uint8Array(KEY_LENGTH))
			? key
			: (new Uint8Array(0) as Bytes);
	} catch {
		return new Uint8Array(0) as Bytes;
	}
}
