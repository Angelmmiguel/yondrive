/**
 * The signed description of a version. The author's Ed25519 signature ties the
 * node, the version, its size, its framing and the hash of its stored frames
 * together, so a reader can tell who wrote what it is reading: read access
 * alone gives the ability to encrypt, not to sign.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { SealError } from './aead';
import { encodeFields, idBytes, u32, u64, utf8, type Bytes } from './encoding';
import { assertKey } from './random';

export const CONTENT_HASH_LENGTH = 32;

export interface VersionManifest {
	nodeId: string;
	versionId: string;
	/** The suite that sealed the frames. Signed, so it cannot be changed afterwards. */
	suite: string;
	/** Plaintext bytes. */
	size: number;
	frameSize: number;
	frameCount: number;
	contentHash: Bytes;
}

/** The exact bytes that are signed. */
export function versionMessage(manifest: VersionManifest): Bytes {
	if (manifest.contentHash.length !== CONTENT_HASH_LENGTH) throw new SealError('manifest');
	return encodeFields(
		'yondrive/version/v1',
		idBytes(manifest.nodeId),
		idBytes(manifest.versionId),
		utf8(manifest.suite),
		u64(manifest.size),
		u32(manifest.frameSize),
		u32(manifest.frameCount),
		manifest.contentHash
	);
}

/** Signs a manifest with an Ed25519 private key. */
export function signVersion(manifest: VersionManifest, privateKey: Uint8Array): Bytes {
	assertKey(privateKey);
	return ed25519.sign(versionMessage(manifest), privateKey) as Bytes;
}

/**
 * Verifies a manifest strictly as RFC 8032 specifies, without the relaxed
 * encodings consensus systems accept. Throws `SealError('signature')`, so a
 * forgotten check of a return value cannot pass as success. Whether this key's
 * owner may edit the node is the caller's question.
 */
export function verifyVersion(
	manifest: VersionManifest,
	signature: Uint8Array,
	publicKey: Uint8Array
): void {
	let valid: boolean;
	try {
		valid = ed25519.verify(signature, versionMessage(manifest), publicKey, { zip215: false });
	} catch {
		throw new SealError('signature');
	}
	if (!valid) throw new SealError('signature');
}
