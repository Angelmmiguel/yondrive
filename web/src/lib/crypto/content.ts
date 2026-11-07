/**
 * Content framing. A version is a sequence of frames of `frameSize` plaintext
 * bytes, the last one shorter or equal, sealed one at a time under a key unique
 * to the version. Each frame's AAD names its node, version, frame size, index
 * and whether it is final, so frames cannot move, cross versions or be cut off.
 * Everything here is pure and works on one frame, so it runs in a worker.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { open, OVERHEAD, seal, SealError } from './aead';
import { encodeFields, idBytes, u32, type Bytes } from './encoding';
import { expand } from './kdf';
import { zero } from './random';

export const DEFAULT_FRAME_SIZE = 4 * 1024 * 1024;
export const MIN_FRAME_SIZE = 1024;
export const MAX_FRAME_SIZE = 64 * 1024 * 1024;

/** What a frame belongs to. `frameSize` is recorded per version. */
export interface VersionRef {
	nodeId: string;
	versionId: string;
	frameSize: number;
}

export interface FramePosition {
	index: number;
	final: boolean;
}

/** Refuses a frame size outside the bounds; a stored one is untrusted until checked. */
export function assertFrameSize(frameSize: number): void {
	if (!Number.isInteger(frameSize) || frameSize < MIN_FRAME_SIZE || frameSize > MAX_FRAME_SIZE) {
		throw new SealError('manifest');
	}
}

/**
 * How many frames a version of `size` bytes has. An empty file still has one,
 * so that deleting every frame of a version is detectable.
 */
export function frameCountFor(size: number, frameSize: number): number {
	return Math.max(1, Math.ceil(size / frameSize));
}

/**
 * Refuses a plaintext length the position does not allow: a full frame unless
 * final, and a final frame is empty only if it is the only one. There is one
 * framing per file, which is what makes `frameCountFor` exact.
 */
export function assertFrameLength(ref: VersionRef, position: FramePosition, length: number): void {
	const valid = position.final
		? length <= ref.frameSize && (length > 0 || position.index === 0)
		: length === ref.frameSize;
	if (!valid) throw new SealError('length');
}

/** Derives the content key of one version from the node key. */
export function deriveVersionKey(nodeKey: Uint8Array, ref: VersionRef): Bytes {
	const content = expand(nodeKey, 'yondrive/content/v1');
	try {
		return expand(
			content,
			encodeFields('yondrive/content/version/v1', idBytes(ref.nodeId), idBytes(ref.versionId))
		);
	} finally {
		zero(content);
	}
}

/** Seals one frame under the version's content key. */
export function encryptFrame(
	versionKey: Uint8Array,
	ref: VersionRef,
	position: FramePosition,
	plaintext: Uint8Array
): Bytes {
	assertFrameLength(ref, position, plaintext.length);
	return seal(versionKey, plaintext, frameAad(ref, position));
}

/** Opens one frame; a frame from any other position fails authentication. */
export function decryptFrame(
	versionKey: Uint8Array,
	ref: VersionRef,
	position: FramePosition,
	sealed: Uint8Array
): Bytes {
	assertFrameLength(ref, position, sealed.length - OVERHEAD);
	return open(versionKey, sealed, frameAad(ref, position));
}

function frameAad(ref: VersionRef, position: FramePosition): Bytes {
	return encodeFields(
		'yondrive/frame/v1',
		idBytes(ref.nodeId),
		idBytes(ref.versionId),
		u32(ref.frameSize),
		u32(position.index),
		new Uint8Array([position.final ? 1 : 0])
	);
}

/**
 * Accumulates the content hash of a version from the SHA-256 of each stored
 * frame, in order. It covers what is stored, so anyone holding the frames can
 * check it without keys.
 */
export function contentHasher(): { add(frameSha256: Uint8Array): void; digest(): Bytes } {
	const hash = sha256.create().update(encodeFields('yondrive/content/hash/v1'));
	return {
		add(frameSha256) {
			hash.update(frameSha256);
		},
		digest() {
			return hash.digest() as Bytes;
		}
	};
}
