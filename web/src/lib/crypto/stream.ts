/**
 * Writing and reading a whole version frame by frame, on top of a `Sealer`, so
 * the checks that need state are the same in both modes: frames arrive in order,
 * the stream ends on the final frame, and nothing follows it.
 */
import { SealError } from './aead';
import { assertFrameSize, contentHasher, frameCountFor, type VersionRef } from './content';
import type { Bytes } from './encoding';
import { CONTENT_HASH_LENGTH, type VersionManifest } from './manifest';
import { constantTimeEqual } from './random';
import type { Sealer, SealedFrame, VersionCipher } from './sealer';

/** Seals a version one frame at a time and produces its manifest. */
export class FrameWriter {
	readonly #sealer: Sealer;
	readonly #ref: VersionRef;
	readonly #cipher: VersionCipher;
	readonly #hasher = contentHasher();
	#index = 0;
	#size = 0;
	#ended = false;

	constructor(sealer: Sealer, nodeKey: Uint8Array, ref: VersionRef) {
		assertFrameSize(ref.frameSize);
		this.#sealer = sealer;
		this.#ref = ref;
		this.#cipher = sealer.openVersion(nodeKey, ref);
	}

	/** Seals the next frame: exactly `frameSize` bytes unless `final`. */
	write(plaintext: Uint8Array, final: boolean): SealedFrame {
		if (this.#ended) throw new SealError('extended');
		const frame = this.#cipher.sealFrame({ index: this.#index, final }, plaintext);
		this.#hasher.add(frame.sha256);
		this.#index += 1;
		this.#size += plaintext.length;
		this.#ended = final;
		return frame;
	}

	/** Zeroes the key and returns the manifest to sign. */
	finish(): VersionManifest {
		this.#cipher.close();
		if (!this.#ended) throw new SealError('truncated');
		return {
			...this.#ref,
			suite: this.#sealer.suite,
			size: this.#size,
			frameCount: this.#index,
			contentHash: this.#hasher.digest()
		};
	}

	/** Gives up on the version and zeroes the key. */
	abort(): void {
		this.#cipher.close();
	}
}

/**
 * Opens a version front to back against its manifest, whose signature the caller
 * has already verified. For seeking, use `Sealer.openVersion` directly; a
 * partial read cannot check the content hash, but each frame still authenticates
 * its own position.
 */
export class FrameReader {
	readonly #manifest: VersionManifest;
	readonly #cipher: VersionCipher;
	readonly #hasher = contentHasher();
	#index = 0;
	#size = 0;

	constructor(sealer: Sealer, nodeKey: Uint8Array, manifest: VersionManifest) {
		assertManifest(manifest, sealer);
		this.#manifest = manifest;
		this.#cipher = sealer.openVersion(nodeKey, manifest);
	}

	/** Opens the next frame. */
	read(frame: SealedFrame): Bytes {
		if (this.#index >= this.#manifest.frameCount) throw new SealError('extended');
		const final = this.#index === this.#manifest.frameCount - 1;
		const plaintext = this.#cipher.openFrame({ index: this.#index, final }, frame);
		this.#hasher.add(frame.sha256);
		this.#index += 1;
		this.#size += plaintext.length;
		return plaintext;
	}

	/** Zeroes the key, and throws unless every frame arrived and matches the manifest. */
	finish(): void {
		this.#cipher.close();
		if (this.#index < this.#manifest.frameCount) throw new SealError('truncated');
		if (
			this.#size !== this.#manifest.size ||
			!constantTimeEqual(this.#hasher.digest(), this.#manifest.contentHash)
		) {
			throw new SealError('manifest');
		}
	}

	/** Gives up on the read and zeroes the key. */
	abort(): void {
		this.#cipher.close();
	}
}

/**
 * Refuses a manifest that could not describe a real version of this suite. The
 * suite check is what stops a single item of an encrypted server being served
 * as plaintext.
 */
export function assertManifest(manifest: VersionManifest, sealer: Sealer): void {
	assertFrameSize(manifest.frameSize);
	if (
		manifest.suite !== sealer.suite ||
		!Number.isSafeInteger(manifest.size) ||
		manifest.size < 0 ||
		manifest.frameCount !== frameCountFor(manifest.size, manifest.frameSize) ||
		manifest.contentHash.length !== CONTENT_HASH_LENGTH
	) {
		throw new SealError('manifest');
	}
}
