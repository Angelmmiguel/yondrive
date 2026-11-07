/**
 * Getting a version ready to read, and reading it. Before any frame is touched the
 * signature has to verify and the frame hashes have to add up to the signed content
 * hash, which makes every hash trustworthy on its own: a frame is then checked
 * against it, and opened, one at a time, in any order. In suite `none` the same
 * steps run with nothing to verify the signature against but the hashes still count.
 */
import type { Api } from '$lib/api/client';
import type { Version } from '$lib/api/types';
import { SealError } from '$lib/crypto/aead';
import { contentHashOf, type VersionRef } from '$lib/crypto/content';
import { decodeBase64, type Bytes } from '$lib/crypto/encoding';
import type { PublicKeys } from '$lib/crypto/keys';
import { decodeManifest } from '$lib/crypto/manifest';
import { constantTimeEqual } from '$lib/crypto/random';
import type { Sealer } from '$lib/crypto/sealer';
import { assertManifest } from '$lib/crypto/stream';
import { TooLargeForMemoryError } from '../errors';
import type { FrameSession } from '../frame-pool';
import { Limiter, withRetry } from '../retry';
import { plaintextSize, storedRange } from '../upload/plan';

/** A version whose signature and hashes have been checked. */
export interface VerifiedVersion {
	/** The version asked for. */
	id: string;
	blobId: string;
	/** Where its frames were sealed: `versionId` differs from `id` on a restored version. */
	ref: VersionRef;
	size: number;
	storedSize: number;
	frameCount: number;
	/** 32 bytes per frame. */
	hashes: Bytes;
}

export interface ReaderDeps {
	api: Pick<Api, 'getVersion' | 'getBlob'>;
	sealer: Sealer;
	/**
	 * The public keys of the signer who may have written this, or a refusal. Only
	 * someone who holds edit rights counts; until sharing exists that is the owner.
	 */
	authorKeys: (authorId: string) => Promise<PublicKeys>;
}

/** What makes a version readable or not. Nothing here needs the mode. */
export async function verifyVersion(
	version: Version,
	nodeId: string,
	deps: Pick<ReaderDeps, 'sealer' | 'authorKeys'>
): Promise<VerifiedVersion> {
	const { sealer } = deps;
	const manifest = decodeManifest(decodeBase64(version.manifest));
	assertManifest(manifest, sealer);
	const hashes = decodeBase64(version.frame_hashes);
	if (
		version.suite !== sealer.suite ||
		version.node_id !== nodeId ||
		manifest.nodeId !== nodeId ||
		manifest.versionId !== version.content_version_id ||
		manifest.frameSize !== version.frame_size ||
		manifest.frameCount !== version.frame_count ||
		hashes.length !== manifest.frameCount * 32 ||
		manifest.size !==
			plaintextSize(version.stored_size, version.frame_count, sealer.frameOverhead) ||
		!constantTimeEqual(contentHashOf(hashes), manifest.contentHash)
	) {
		throw new SealError('manifest');
	}
	const author = await deps.authorKeys(version.content_author_id);
	sealer.verifyVersion(manifest, decodeBase64(version.signature), author);
	return {
		id: version.id,
		blobId: version.blob_id,
		ref: { nodeId, versionId: manifest.versionId, frameSize: manifest.frameSize },
		size: manifest.size,
		storedSize: version.stored_size,
		frameCount: manifest.frameCount,
		hashes
	};
}

export async function openVersion(
	nodeId: string,
	versionId: string,
	deps: ReaderDeps
): Promise<VerifiedVersion> {
	return verifyVersion(await deps.api.getVersion(nodeId, versionId), nodeId, deps);
}

/** The stored bytes of one frame, with the digest they have to match. */
export async function fetchFrame(
	version: VerifiedVersion,
	index: number,
	overhead: number,
	getBlob: Api['getBlob'],
	signal?: AbortSignal
): Promise<{ data: Bytes; sha256: Bytes }> {
	const range = storedRange(version.ref.frameSize, overhead, version.storedSize, index);
	const data =
		range === null
			? (new Uint8Array(0) as Bytes)
			: await withRetry(() => getBlob(version.blobId, range, signal), { signal });
	return { data, sha256: version.hashes.slice(index * 32, (index + 1) * 32) };
}

export interface ReadAllOptions {
	onProgress?: (done: number, total: number) => void;
	signal?: AbortSignal;
	/** Refuses, before reading anything, what would not fit. */
	limit?: number;
	type?: string;
}

const FRAMES_AT_ONCE = 4;

/**
 * Reads a whole version into a Blob. For what is shown in a viewer, and for
 * downloads where no service worker is available. A frame that fails stops
 * everything, and nothing read so far is handed out.
 */
export async function readAll(
	version: VerifiedVersion,
	session: FrameSession,
	deps: Pick<ReaderDeps, 'api' | 'sealer'>,
	options: ReadAllOptions = {}
): Promise<Blob> {
	const { signal, limit } = options;
	if (limit !== undefined && version.size > limit) throw new TooLargeForMemoryError(limit);
	const parts = new Array<Bytes>(version.frameCount);
	const limiter = new Limiter(FRAMES_AT_ONCE);
	let done = 0;
	const getBlob = deps.api.getBlob;
	await Promise.all(
		parts.fill(new Uint8Array(0) as Bytes).map((_, index) =>
			limiter.run(async () => {
				signal?.throwIfAborted();
				const frame = await fetchFrame(version, index, deps.sealer.frameOverhead, getBlob, signal);
				const final = index === version.frameCount - 1;
				const plaintext = await session.read(index, final, frame);
				parts[index] = plaintext;
				done += plaintext.length;
				options.onProgress?.(done, version.size);
			})
		)
	);
	if (done !== version.size) throw new SealError('manifest');
	return new Blob(parts, { type: options.type ?? 'application/octet-stream' });
}
