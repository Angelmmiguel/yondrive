/**
 * Sending one version of one file: reserve room, seal and send what is missing,
 * sign the manifest, commit. A digest is written down before its frame leaves, so
 * that a reload can go on from what the server has, and the signature covers all
 * of them in order however the frames travelled.
 */
import type { Api } from '$lib/api/client';
import { isApiError, type Version } from '$lib/api/types';
import { contentHashOf } from '$lib/crypto/content';
import { decodeBase64, encodeBase64, type Bytes } from '$lib/crypto/encoding';
import { encodeManifest, type VersionManifest } from '$lib/crypto/manifest';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Sealer, UserKeys } from '$lib/crypto/sealer';
import type { FramePool } from '../frame-pool';
import { Limiter, withRetry } from '../retry';
import { frameBounds, planFrames, type FramePlan } from './plan';
import type { ResumeRecord, ResumeStore } from './resume';

/** What a file needs to offer: `File` does, and so does a test. */
export interface UploadSource {
	size: number;
	lastModified: number;
	slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface EngineDeps {
	api: Pick<
		Api,
		'createUpload' | 'getUpload' | 'abortUpload' | 'putFrame' | 'commitUpload' | 'getVersion'
	>;
	sealer: Sealer;
	keys: () => UserKeys;
	pool: FramePool;
	resume: ResumeStore;
	/** The frames in flight across all uploads, so that memory stays bounded. */
	limiter: Limiter;
	userId: () => string;
	/** Instead of the default, for tests that would rather not seal megabytes. */
	frameSize?: number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface UploadTarget {
	nodeId: string;
	nodeKey: Uint8Array;
	/** The version this is based on, or '' for a file that has none. */
	expected: string;
	versionId: string;
}

export interface UploadProgress {
	/** Plaintext bytes known to be on the server. */
	done: number;
	total: number;
}

/** The frames on the server do not fit what this device knows, so it has to start over. */
export class UploadRestartError extends Error {
	constructor() {
		super('the upload has to start over');
		this.name = 'UploadRestartError';
	}
}

const FRAMES_PER_UPLOAD = 4;

/** Starts an upload, writing down what a reload needs before anything is sent. */
export async function beginUpload(
	source: UploadSource,
	target: UploadTarget,
	deps: EngineDeps
): Promise<ResumeRecord> {
	const plan = planFrames(source.size, deps.sealer.frameOverhead, deps.frameSize);
	const upload = await withRetry(
		() =>
			deps.api.createUpload({
				node_id: target.nodeId,
				version_id: target.versionId,
				suite: deps.sealer.suite,
				frame_count: plan.frameCount,
				frame_size: plan.frameSize,
				stored_size: plan.storedSize
			}),
		{ sleep: deps.sleep }
	);
	const record: ResumeRecord = {
		uploadId: upload.id,
		userId: deps.userId(),
		nodeId: target.nodeId,
		versionId: target.versionId,
		size: source.size,
		lastModified: source.lastModified,
		frameSize: plan.frameSize,
		expected: target.expected
	};
	await deps.resume.put(record);
	return record;
}

/** Sends what the server does not have, then commits. Works the same for a fresh upload. */
export async function sendUpload(
	source: UploadSource,
	record: ResumeRecord,
	nodeKey: Uint8Array,
	deps: EngineDeps,
	onProgress: (progress: UploadProgress) => void = () => {},
	signal?: AbortSignal
): Promise<Version> {
	const { sealer, api } = deps;
	const plan = planFrames(source.size, sealer.frameOverhead, record.frameSize);
	const retry = { signal, sleep: deps.sleep };

	const upload = await withRetry(() => api.getUpload(record.uploadId), retry);
	const digests = await deps.resume.digests(record.uploadId);
	const arrived = new Set(upload.frames);
	for (const index of arrived) {
		// It went out from another device, or this device has lost its notes.
		if (!digests.has(index)) throw new UploadRestartError();
	}

	const ref = { nodeId: record.nodeId, versionId: record.versionId, frameSize: plan.frameSize };
	const session = deps.pool.session(sealer.versionKey(nodeKey, ref), ref);
	let done = 0;
	for (const index of arrived) {
		const { start, end } = frameBounds(plan, index);
		done += end - start;
	}
	onProgress({ done, total: source.size });

	try {
		const missing = Array.from({ length: plan.frameCount }, (_, i) => i).filter(
			(i) => !arrived.has(i)
		);
		const send = async (index: number) => {
			signal?.throwIfAborted();
			const { start, end, final } = frameBounds(plan, index);
			const plaintext = new Uint8Array(await source.slice(start, end).arrayBuffer());
			signal?.throwIfAborted();
			const frame = await session.seal(index, final, plaintext);
			const digest = encodeBase64(frame.sha256);
			digests.set(index, digest);
			await deps.resume.putDigest(record.uploadId, index, digest);
			await withRetry(
				() => api.putFrame(record.uploadId, index, frame.data, digest, signal),
				retry
			);
			done += end - start;
			onProgress({ done, total: source.size });
		};
		await inParallel(missing, FRAMES_PER_UPLOAD, (index) =>
			deps.limiter.run(() => send(index))
		).catch((e) => {
			if (isApiError(e, 'frame_conflict')) throw new UploadRestartError();
			throw e;
		});
	} finally {
		session.close();
	}

	const manifest = manifestOf(record, plan, sealer, digests);
	const signature = sealer.signVersion(manifest, deps.keys());
	const version = await commit(record, manifest, signature, deps, signal);
	await deps.resume.remove(record.uploadId);
	return version;
}

function manifestOf(
	record: ResumeRecord,
	plan: FramePlan,
	sealer: Sealer,
	digests: Map<number, string>
): VersionManifest {
	const all = new Uint8Array(plan.frameCount * 32);
	for (let i = 0; i < plan.frameCount; i++) {
		const digest = digests.get(i);
		if (digest === undefined) throw new UploadRestartError();
		all.set(decodeBase64(digest), i * 32);
	}
	return {
		nodeId: record.nodeId,
		versionId: record.versionId,
		suite: sealer.suite,
		size: plan.size,
		frameSize: plan.frameSize,
		frameCount: plan.frameCount,
		contentHash: contentHashOf(all)
	};
}

/** After a lost answer the upload is gone and the version is there, which is success. */
async function commit(
	record: ResumeRecord,
	manifest: VersionManifest,
	signature: Bytes,
	deps: EngineDeps,
	signal?: AbortSignal
): Promise<Version> {
	try {
		return await withRetry(
			() =>
				deps.api.commitUpload(record.uploadId, {
					signature: encodeBase64(signature),
					manifest: encodeBase64(encodeManifest(manifest)),
					expected_version: record.expected
				}),
			{ signal, sleep: deps.sleep }
		);
	} catch (e) {
		if (!isApiError(e, 'not_found')) throw e;
		return deps.api.getVersion(record.nodeId, record.versionId);
	}
}

/** Runs at most `limit` at once, and stops starting more after the first failure. */
export async function inParallel<T>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	let failure: { error: unknown } | null = null;
	const runner = async () => {
		while (next < items.length && failure === null) {
			const item = items[next++];
			try {
				await task(item);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
	if (failure !== null) throw (failure as { error: unknown }).error;
}

/** Releases an upload, and what was noted about it. */
export async function abandonUpload(uploadId: string, deps: EngineDeps): Promise<void> {
	await deps.api.abortUpload(uploadId).catch(() => {});
	await deps.resume.remove(uploadId);
}

/** The SHA-256 of some bytes, in the base64 the API's header takes. */
export function digestHeader(bytes: Uint8Array): string {
	return encodeBase64(sha256(bytes));
}
