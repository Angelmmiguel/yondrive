/**
 * Node metadata and the name tag. Metadata is JSON sealed under the node's meta
 * subkey and bound to its id. The tag lets the server reject a duplicate name
 * in a folder without learning it, which is why it is keyed by the folder.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { open, seal, SealError } from './aead';
import { encodeFields, idBytes, utf8, type Bytes } from './encoding';
import { expand } from './kdf';
import { zero } from './random';

/** The bytes of a JSON value, as stored in the clear when nothing is encrypted. */
export function encodeMetadata(value: unknown): Bytes {
	const json = JSON.stringify(value);
	if (json === undefined) throw new TypeError('metadata is not JSON');
	return utf8(json);
}

/** Parses metadata bytes; malformed JSON is `SealError('format')`. */
export function decodeMetadata(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		throw new SealError('format');
	}
}

/** Seals a JSON value under the node's meta subkey. */
export function sealMetadata(nodeKey: Uint8Array, nodeId: string, value: unknown): Bytes {
	const key = expand(nodeKey, 'yondrive/meta/v1');
	try {
		return seal(key, encodeMetadata(value), metadataAad(nodeId));
	} finally {
		zero(key);
	}
}

/** Opens metadata sealed for this node. */
export function openMetadata(nodeKey: Uint8Array, nodeId: string, sealed: Uint8Array): unknown {
	const key = expand(nodeKey, 'yondrive/meta/v1');
	try {
		return decodeMetadata(open(key, sealed, metadataAad(nodeId)));
	} finally {
		zero(key);
	}
}

function metadataAad(nodeId: string): Bytes {
	return encodeFields('yondrive/meta/seal/v1', idBytes(nodeId));
}

/**
 * The form two names must share to count as duplicates: NFC, then the Unicode
 * default lower case mapping with no locale, then NFC again because lower-casing
 * can leave a string unnormalised.
 */
export function normalizeName(name: string): string {
	return name.normalize('NFC').toLowerCase().normalize('NFC');
}

/** HMAC-SHA256 of the normalised name under the parent folder's name subkey. */
export function nameHmac(parentKey: Uint8Array, name: string): Bytes {
	const key = expand(parentKey, 'yondrive/name/v1');
	try {
		return hmac(sha256, key, utf8(normalizeName(name))) as Bytes;
	} finally {
		zero(key);
	}
}
