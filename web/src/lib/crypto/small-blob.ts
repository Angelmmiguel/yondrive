/**
 * Thumbnails and index segments: small things stored whole. Each is sealed once
 * under its own subkey and bound to the id of the blob it is stored as, so the
 * server cannot hand one in place of another. A client can always make them
 * again, which is why they do not get the framing and signature of a version.
 */
import { open, seal } from './aead';
import { encodeFields, idBytes, type Bytes } from './encoding';
import { expand } from './kdf';
import { zero } from './random';

function under<T>(key: Uint8Array, label: string, use: (subkey: Bytes) => T): T {
	const subkey = expand(key, label);
	try {
		return use(subkey);
	} finally {
		zero(subkey);
	}
}

const thumbAad = (nodeId: string, blobId: string) =>
	encodeFields('yondrive/blob/thumb/v1', idBytes(nodeId), idBytes(blobId));

const indexAad = (blobId: string) => encodeFields('yondrive/blob/index/v1', idBytes(blobId));

/** Seals a thumbnail under its node's thumbnail subkey. */
export function sealThumbnail(
	nodeKey: Uint8Array,
	nodeId: string,
	blobId: string,
	image: Uint8Array
): Bytes {
	return under(nodeKey, 'yondrive/thumb/v1', (key) => seal(key, image, thumbAad(nodeId, blobId)));
}

/** Opens a thumbnail stored as this blob, for this node. */
export function openThumbnail(
	nodeKey: Uint8Array,
	nodeId: string,
	blobId: string,
	stored: Uint8Array
): Bytes {
	return under(nodeKey, 'yondrive/thumb/v1', (key) => open(key, stored, thumbAad(nodeId, blobId)));
}

/** Seals a search index segment under the master key's index subkey. */
export function sealIndexSegment(
	masterKey: Uint8Array,
	blobId: string,
	segment: Uint8Array
): Bytes {
	return under(masterKey, 'yondrive/index/v1', (key) => seal(key, segment, indexAad(blobId)));
}

/** Opens a search index segment stored as this blob. */
export function openIndexSegment(masterKey: Uint8Array, blobId: string, stored: Uint8Array): Bytes {
	return under(masterKey, 'yondrive/index/v1', (key) => open(key, stored, indexAad(blobId)));
}
