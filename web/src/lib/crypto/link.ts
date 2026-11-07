/**
 * Public links, as docs/CRYPTO.md section 19 has them. A link key is what a URL
 * carries or a password wraps. It opens a copy of the node key, and from there down
 * through the wraps it reads what a grant reads. The owner keeps a copy of it under
 * the master key, so that a rotation can seal the new node key for the link.
 */
import { base64urlnopad } from '@scure/base';
import { open, seal, SealError } from './aead';
import { encodeFields, idBytes, type Bytes } from './encoding';
import { expand } from './kdf';
import { constantTimeEqual, KEY_LENGTH, randomBytes, zero } from './random';

/** A fresh 32-byte link key. */
export function generateLinkKey(): Bytes {
	return randomBytes(KEY_LENGTH);
}

function under<T>(key: Uint8Array, label: string, use: (subkey: Bytes) => T): T {
	const subkey = expand(key, label);
	try {
		return use(subkey);
	} finally {
		zero(subkey);
	}
}

function liveKey(key: Bytes): Bytes {
	if (key.length !== KEY_LENGTH || constantTimeEqual(key, new Uint8Array(KEY_LENGTH))) {
		throw new SealError('format');
	}
	return key;
}

const keyAad = (linkId: string, nodeId: string) =>
	encodeFields('yondrive/link/key/v1', idBytes(linkId), idBytes(nodeId));
const ownerAad = (linkId: string) => encodeFields('yondrive/link/owner/v1', idBytes(linkId));
const passwordAad = (linkId: string) => encodeFields('yondrive/link/password/v1', idBytes(linkId));

/** The node key sealed under the link key. */
export function sealLinkNodeKey(
	nodeKey: Uint8Array,
	linkKey: Uint8Array,
	linkId: string,
	nodeId: string
): Bytes {
	return under(linkKey, 'yondrive/link-wrap/v1', (wrap) =>
		seal(wrap, nodeKey, keyAad(linkId, nodeId))
	);
}

export function openLinkNodeKey(
	stored: Uint8Array,
	linkKey: Uint8Array,
	linkId: string,
	nodeId: string
): Bytes {
	return under(linkKey, 'yondrive/link-wrap/v1', (wrap) =>
		liveKey(open(wrap, stored, keyAad(linkId, nodeId)))
	);
}

/** The owner's copy of a link key. */
export function sealLinkOwnerCopy(linkKey: Uint8Array, master: Uint8Array, linkId: string): Bytes {
	return under(master, 'yondrive/link-owner/v1', (wrap) => seal(wrap, linkKey, ownerAad(linkId)));
}

export function openLinkOwnerCopy(stored: Uint8Array, master: Uint8Array, linkId: string): Bytes {
	return under(master, 'yondrive/link-owner/v1', (wrap) =>
		liveKey(open(wrap, stored, ownerAad(linkId)))
	);
}

/**
 * What a password's root splits into: the auth key the server checks, and the KEK
 * that stays here. HKDF is one-way, so the first says nothing about the second.
 */
export function linkAuthKey(root: Uint8Array): Bytes {
	return expand(root, 'yondrive/link-auth/v1');
}

export function linkKek(root: Uint8Array): Bytes {
	return expand(root, 'yondrive/link-kek/v1');
}

export function wrapLinkKey(linkKey: Uint8Array, kek: Uint8Array, linkId: string): Bytes {
	return seal(kek, linkKey, passwordAad(linkId));
}

export function unwrapLinkKey(stored: Uint8Array, kek: Uint8Array, linkId: string): Bytes {
	return liveKey(open(kek, stored, passwordAad(linkId)));
}

/** A link key as a URL's fragment carries it: unpadded base64url. */
export function encodeLinkFragment(linkKey: Uint8Array): string {
	return base64urlnopad.encode(linkKey);
}

/** The key in a fragment, or empty bytes if what is there is not one. */
export function decodeLinkFragment(fragment: string): Bytes {
	try {
		const key = Uint8Array.from(base64urlnopad.decode(fragment));
		return key.length === KEY_LENGTH ? key : (new Uint8Array(0) as Bytes);
	} catch {
		return new Uint8Array(0) as Bytes;
	}
}
