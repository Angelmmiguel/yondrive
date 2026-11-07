/**
 * Getting a version ready to read, and reading it. Before any frame is touched the
 * signature has to verify and the frame hashes have to add up to the signed content
 * hash, which makes every hash trustworthy on its own: a frame is then checked
 * against it, and opened, one at a time, in any order. In suite `none` the same
 * steps run with nothing to verify the signature against but the hashes still count.
 */
import type { Api } from '$lib/api/client';
import type { KeyLink, PublicVersion, Version } from '$lib/api/types';
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
	/** The generation of the node's key its frames are sealed under. */
	keyGeneration: number | null;
	/** How to reach that key from the current one, newest link first. */
	keyChain: readonly KeyLink[];
	/** Its signer has no edit rights on this node now, which the screen says. */
	formerAuthor: boolean;
}

/** A signer's keys, and whether they have lost the edit rights they wrote this under. */
export interface AuthorKeys extends PublicKeys {
	former?: boolean;
}

export interface ReaderDeps {
	api: Pick<Api, 'getVersion' | 'getBlob'>;
	sealer: Sealer;
	/**
	 * The public keys of the signer of a version of this node, or a refusal. The
	 * owner and those a grant lets edit count; see `Sharing.authorKeys`.
	 */
	authorKeys: (authorId: string, nodeId: string) => Promise<AuthorKeys>;
}

/** What the two kinds of version have in common: all of it is read before the signer. */
type SignedVersion = Pick<
	Version,
	| 'id'
	| 'node_id'
	| 'blob_id'
	| 'suite'
	| 'content_version_id'
	| 'stored_size'
	| 'frame_count'
	| 'frame_size'
	| 'frame_hashes'
	| 'signature'
	| 'manifest'
	| 'key_generation'
	| 'key_chain'
>;

/** What makes a version readable or not. Nothing here needs the mode. */
async function verifySigned(
	version: SignedVersion,
	nodeId: string,
	sealer: Sealer,
	signer: () => Promise<AuthorKeys>
): Promise<VerifiedVersion> {
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
	const author = await signer();
	sealer.verifyVersion(manifest, decodeBase64(version.signature), author);
	return {
		id: version.id,
		blobId: version.blob_id,
		ref: { nodeId, versionId: manifest.versionId, frameSize: manifest.frameSize },
		size: manifest.size,
		storedSize: version.stored_size,
		frameCount: manifest.frameCount,
		hashes,
		keyGeneration: version.key_generation ?? null,
		keyChain: version.key_chain ?? [],
		formerAuthor: author.former === true
	};
}

export function verifyVersion(
	version: Version,
	nodeId: string,
	deps: Pick<ReaderDeps, 'sealer' | 'authorKeys'>
): Promise<VerifiedVersion> {
	return verifySigned(version, nodeId, deps.sealer, () =>
		deps.authorKeys(version.content_author_id, nodeId)
	);
}

/**
 * A version under a public link names its signer by a key alone. A reader with no
 * account has nothing to pin it against, so this says only that the key signed it.
 */
export function verifyPublicVersion(
	version: PublicVersion,
	nodeId: string,
	sealer: Sealer
): Promise<VerifiedVersion> {
	return verifySigned(version, nodeId, sealer, async () => ({
		x25519: new Uint8Array(0) as Bytes,
		ed25519:
			version.author_public_key === undefined
				? (new Uint8Array(0) as Bytes)
				: decodeBase64(version.author_public_key)
	}));
}

export async function openVersion(
	nodeId: string,
	versionId: string,
	deps: ReaderDeps
): Promise<VerifiedVersion> {
	return verifyVersion(await deps.api.getVersion(nodeId, versionId), nodeId, deps);
}

/** Where stored bytes come from: the session's route, or a link's. */
export type BlobReader = (
	blobId: string,
	range?: { start: number; end: number },
	signal?: AbortSignal
) => Promise<Uint8Array<ArrayBuffer>>;

/** The stored bytes of one frame, with the digest they have to match. */
export async function fetchFrame(
	version: VerifiedVersion,
	index: number,
	overhead: number,
	getBlob: BlobReader,
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
	deps: { api: { getBlob: BlobReader }; sealer: Sealer },
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
