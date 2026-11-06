/**
 * Node keys. Every file or folder has a random key, reached either by unwrapping
 * it under its parent's key or by opening a grant sealed to the user's X25519
 * key. Purpose-bound subkeys derive from it; the node key itself never touches
 * a cipher.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { open, seal, SealError } from './aead';
import { encodeFields, idBytes, type Bytes } from './encoding';
import { expand } from './kdf';
import type { KeyPair } from './keys';
import { assertKey, KEY_LENGTH, randomBytes, zero } from './random';

/** The keys derived from a node key for its own metadata, children's names and content. */
export interface NodeSubkeys {
	meta: Bytes;
	name: Bytes;
	content: Bytes;
}

const EPHEMERAL_LENGTH = 32;

/** A fresh 32-byte node key. */
export function generateNodeKey(): Bytes {
	return randomBytes(KEY_LENGTH);
}

/** Derives the subkeys of a node. Deterministic; the caller zeroes what it no longer needs. */
export function deriveNodeSubkeys(nodeKey: Uint8Array): NodeSubkeys {
	return {
		meta: expand(nodeKey, 'yondrive/meta/v1'),
		name: expand(nodeKey, 'yondrive/name/v1'),
		content: expand(nodeKey, 'yondrive/content/v1')
	};
}

/** Wraps a user's root node key under the master key. */
export function wrapRootNodeKey(nodeKey: Uint8Array, master: Uint8Array, nodeId: string): Bytes {
	return seal(master, nodeKey, rootAad(nodeId));
}

/** Opens a root node key wrapped under the master key. */
export function unwrapRootNodeKey(sealed: Uint8Array, master: Uint8Array, nodeId: string): Bytes {
	return exactKey(open(master, sealed, rootAad(nodeId)));
}

/**
 * Wraps a node key under its parent's. Both ids are bound, so a wrapped key
 * moved to another node or parent no longer opens, and moving a node means
 * wrapping it again under the new parent.
 */
export function wrapNodeKey(
	nodeKey: Uint8Array,
	parentKey: Uint8Array,
	parentId: string,
	nodeId: string
): Bytes {
	const wrapKey = expand(parentKey, 'yondrive/node-wrap/v1');
	try {
		return seal(wrapKey, nodeKey, childAad(parentId, nodeId));
	} finally {
		zero(wrapKey);
	}
}

/** Opens a node key wrapped under its parent's. */
export function unwrapNodeKey(
	sealed: Uint8Array,
	parentKey: Uint8Array,
	parentId: string,
	nodeId: string
): Bytes {
	const wrapKey = expand(parentKey, 'yondrive/node-wrap/v1');
	try {
		return exactKey(open(wrapKey, sealed, childAad(parentId, nodeId)));
	} finally {
		zero(wrapKey);
	}
}

/**
 * Seals a node key to a user's X25519 public key, for a grant. The wire format
 * is the ephemeral public key followed by a sealed message; docs/CRYPTO.md has
 * the exact construction. It does not say who sealed it: anyone holding the
 * public key, the server included, can make one.
 */
export function sealNodeKeyTo(nodeKey: Uint8Array, recipient: Uint8Array, nodeId: string): Bytes {
	assertKey(nodeKey);
	const ephemeral = randomBytes(EPHEMERAL_LENGTH);
	const ephemeralPublic = x25519.getPublicKey(ephemeral);
	const wrapKey = grantKey(ephemeral, recipient, ephemeralPublic, recipient);
	try {
		const sealed = seal(wrapKey, nodeKey, grantAad(ephemeralPublic, recipient, nodeId));
		const out = new Uint8Array(EPHEMERAL_LENGTH + sealed.length);
		out.set(ephemeralPublic);
		out.set(sealed, EPHEMERAL_LENGTH);
		return out;
	} finally {
		zero(ephemeral, wrapKey);
	}
}

/** Opens a node key sealed by `sealNodeKeyTo` with the recipient's keypair. */
export function openNodeKeyFrom(sealed: Uint8Array, recipient: KeyPair, nodeId: string): Bytes {
	if (sealed.length < EPHEMERAL_LENGTH) throw new SealError('length');
	const ephemeralPublic = sealed.subarray(0, EPHEMERAL_LENGTH);
	const wrapKey = grantKey(
		recipient.privateKey,
		ephemeralPublic,
		ephemeralPublic,
		recipient.publicKey
	);
	try {
		const aad = grantAad(ephemeralPublic, recipient.publicKey, nodeId);
		return exactKey(open(wrapKey, sealed.subarray(EPHEMERAL_LENGTH), aad));
	} finally {
		zero(wrapKey);
	}
}

/** Refuses low-order peer keys, which would make the shared secret all zeros. */
function grantKey(
	privateKey: Uint8Array,
	peer: Uint8Array,
	ephemeralPublic: Uint8Array,
	recipientPublic: Uint8Array
): Bytes {
	let shared: Uint8Array;
	try {
		shared = x25519.getSharedSecret(privateKey, peer);
	} catch {
		throw new SealError('format');
	}
	try {
		return expand(shared, encodeFields('yondrive/grant/key/v1', ephemeralPublic, recipientPublic));
	} finally {
		zero(shared);
	}
}

function rootAad(nodeId: string): Bytes {
	return encodeFields('yondrive/node/root/v1', idBytes(nodeId));
}

function childAad(parentId: string, nodeId: string): Bytes {
	return encodeFields('yondrive/node/child/v1', idBytes(parentId), idBytes(nodeId));
}

function grantAad(ephemeralPublic: Uint8Array, recipientPublic: Uint8Array, nodeId: string): Bytes {
	return encodeFields('yondrive/node/grant/v1', ephemeralPublic, recipientPublic, idBytes(nodeId));
}

function exactKey(key: Bytes): Bytes {
	if (key.length !== KEY_LENGTH) throw new SealError('format');
	return key;
}
