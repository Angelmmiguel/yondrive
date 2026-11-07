/**
 * A drive server in memory: it holds what the real one holds and refuses what the
 * real one refuses, without any crypto of its own, so tree, upload and download
 * logic can be tested through its whole path. `tamper` plays a hostile server.
 */
import type { Api } from '$lib/api/client';
import {
	ApiError,
	type Change,
	type ChangeOp,
	type ErrorCode,
	type Node,
	type Upload,
	type Version
} from '$lib/api/types';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeBase64, encodeBase64, type Bytes } from '$lib/crypto/encoding';
import { sealerFor, SUITE_E2E, SUITE_NONE, type Suite, type UserKeys } from '$lib/crypto/sealer';
import { Limiter } from '$lib/drive/retry';
import { inlineFramePool } from '$lib/drive/frame-pool';
import { memoryResumeStore, type ResumeStore } from '$lib/drive/upload/resume';
import type { EngineDeps } from '$lib/drive/upload/engine';
import { DriveTree } from '$lib/drive/tree';
import { openNodes } from '$lib/drive/open-nodes';

const fail = (status: number, code: ErrorCode) => new ApiError(status, code);

interface StoredUpload {
	upload: Upload;
	frames: Map<number, { data: Uint8Array; digest: string }>;
}

export const USER_ID = 'u'.repeat(32);
export const TEST_FRAME = 1024;

/** A server over one user, for one suite. */
export function fakeDriveServer(suite: Suite, options: { quota?: number } = {}) {
	const overhead = sealerFor(suite).frameOverhead;
	const nodes = new Map<string, Node>();
	const versions = new Map<string, Version[]>();
	const uploads = new Map<string, StoredUpload>();
	const blobs = new Map<string, Uint8Array>();
	const changes: Change[] = [];
	const calls: string[] = [];
	let seq = 0;
	let reserved = 0;
	let used = 0;
	let root: string | null = null;
	const clock = () => new Date(1_760_000_000_000 + ++seq * 1000).toISOString();
	const state = {
		quota: options.quota ?? 0,
		/** Rewrites stored bytes on their way out. */
		tamperBlob: null as ((blobId: string, bytes: Uint8Array) => Uint8Array) | null,
		/** Rewrites a version on its way out. */
		tamperVersion: null as ((version: Version) => Version) | null,
		/** Makes a frame fail before it is stored, as a dropped connection does. */
		failFrame: null as ((index: number) => ApiError | null) | null,
		/** Answers a commit with this, once the commit has happened. */
		loseCommitAnswer: false
	};

	function need(id: string): Node {
		const node = nodes.get(id);
		if (node === undefined) throw fail(404, 'not_found');
		return node;
	}

	function journal(nodeId: string, op: ChangeOp) {
		changes.push({ seq: changes.length + 1, node_id: nodeId, op, at: clock() });
	}

	function takenAmong(parentId: string, tag: string, except?: string) {
		for (const node of nodes.values()) {
			if (
				node.parent_id === parentId &&
				node.id !== except &&
				node.name_tag === tag &&
				node.trashed_at === undefined
			) {
				return true;
			}
		}
		return false;
	}

	function checkSuite(given: string) {
		if (given !== suite) throw fail(400, 'suite_mismatch');
	}

	function page<T>(items: T[], id: (item: T) => string, cursor?: string, limit = 200) {
		const sorted = [...items].sort((a, b) => (id(a) < id(b) ? -1 : 1));
		const after = cursor === undefined ? sorted : sorted.filter((item) => id(item) > cursor);
		const chunk = after.slice(0, limit);
		return {
			items: chunk,
			next: after.length > limit ? id(chunk[chunk.length - 1]) : undefined
		};
	}

	const api: Partial<Api> = {
		getMyStorage: async () => ({
			quota_bytes: state.quota,
			used_bytes: used,
			reserved_bytes: reserved
		}),
		getRootNode: async () => {
			if (root === null) throw fail(404, 'not_found');
			return need(root);
		},
		createRootNode: async (body) => {
			checkSuite(body.suite);
			if (root !== null) return need(root);
			const now = clock();
			const node: Node = {
				id: body.id,
				owner_id: USER_ID,
				kind: 'folder',
				suite: body.suite,
				sealed_metadata: body.sealed_metadata ?? '',
				wrapped_key: body.wrapped_key,
				created_at: now,
				updated_at: now
			};
			nodes.set(node.id, node);
			root = node.id;
			return node;
		},
		createNode: async (body) => {
			checkSuite(body.suite);
			if (nodes.has(body.id)) throw fail(409, 'id_taken');
			const parent = need(body.parent_id);
			if (parent.kind !== 'folder') throw fail(400, 'not_a_folder');
			if (takenAmong(body.parent_id, body.name_tag)) throw fail(409, 'name_conflict');
			const now = clock();
			const node: Node = {
				id: body.id,
				owner_id: USER_ID,
				parent_id: body.parent_id,
				kind: body.kind,
				suite: body.suite,
				sealed_metadata: body.sealed_metadata,
				wrapped_key: body.wrapped_key,
				name_tag: body.name_tag,
				created_at: now,
				updated_at: now
			};
			nodes.set(node.id, node);
			journal(node.id, 'created');
			return node;
		},
		getNode: async (id) => need(id),
		updateNode: async (id, body) => {
			checkSuite(body.suite);
			const node = need(id);
			if (node.trashed_at !== undefined) throw fail(409, 'node_trashed');
			if (body.name_tag !== undefined && takenAmong(node.parent_id as string, body.name_tag, id)) {
				throw fail(409, 'name_conflict');
			}
			const updated: Node = {
				...node,
				sealed_metadata: body.sealed_metadata ?? node.sealed_metadata,
				name_tag: body.name_tag ?? node.name_tag,
				updated_at: clock()
			};
			nodes.set(id, updated);
			journal(id, 'updated');
			return updated;
		},
		listChildren: async (id, { cursor, limit } = {}) => {
			need(id);
			const { items, next } = page(
				[...nodes.values()].filter((n) => n.parent_id === id && n.trashed_at === undefined),
				(n) => n.id,
				cursor,
				limit
			);
			return { nodes: items, next_cursor: next };
		},
		moveNode: async (id, body) => {
			const node = need(id);
			if (node.parent_id === undefined) throw fail(409, 'root_immutable');
			let at: Node | undefined = need(body.parent_id);
			while (at !== undefined) {
				if (at.id === id) throw fail(409, 'move_cycle');
				at = at.parent_id === undefined ? undefined : nodes.get(at.parent_id);
			}
			if (takenAmong(body.parent_id, body.name_tag, id)) throw fail(409, 'name_conflict');
			const updated: Node = {
				...node,
				parent_id: body.parent_id,
				wrapped_key: body.wrapped_key,
				name_tag: body.name_tag,
				updated_at: clock()
			};
			nodes.set(id, updated);
			journal(id, 'moved');
			return updated;
		},
		trashNode: async (id) => {
			const node = need(id);
			if (node.parent_id === undefined) throw fail(409, 'root_immutable');
			const updated = { ...node, trashed_at: node.trashed_at ?? clock(), updated_at: clock() };
			nodes.set(id, updated);
			journal(id, 'trashed');
			return updated;
		},
		restoreNode: async (id) => {
			const node = need(id);
			if (node.trashed_at === undefined) throw fail(409, 'not_trashed');
			if (takenAmong(node.parent_id as string, node.name_tag as string, id)) {
				throw fail(409, 'name_conflict');
			}
			const updated: Node = { ...node, updated_at: clock() };
			delete updated.trashed_at;
			delete updated.purged_at;
			delete updated.remove_at;
			nodes.set(id, updated);
			journal(id, 'restored');
			return updated;
		},
		purgeNode: async (id) => {
			const node = need(id);
			if (node.trashed_at === undefined) throw fail(409, 'not_trashed');
			const updated = {
				...node,
				purged_at: clock(),
				remove_at: new Date(Date.parse(clock()) + 30 * 86_400_000).toISOString()
			};
			nodes.set(id, updated);
			journal(id, 'purged');
			return updated;
		},
		listTrash: async ({ cursor, limit } = {}) => {
			const { items, next } = page(
				[...nodes.values()].filter((n) => n.trashed_at !== undefined),
				(n) => n.id,
				cursor,
				limit
			);
			return { nodes: items, next_cursor: next };
		},
		emptyTrash: async () => {
			let marked = 0;
			for (const node of nodes.values()) {
				if (node.trashed_at !== undefined && node.remove_at === undefined) {
					await (api as Api).purgeNode(node.id);
					marked += 1;
				}
			}
			return { marked };
		},
		listVersions: async (id) => ({
			versions: [...(versions.get(id) ?? [])].reverse(),
			next_cursor: undefined
		}),
		getVersion: async (id, versionId) => {
			const found = (versions.get(id) ?? []).find((v) => v.id === versionId);
			if (found === undefined) throw fail(404, 'not_found');
			return state.tamperVersion ? state.tamperVersion(found) : found;
		},
		deleteVersion: async (id, versionId) => {
			if (need(id).current_version === versionId) throw fail(409, 'version_current');
			const list = versions.get(id) ?? [];
			const found = list.find((v) => v.id === versionId);
			if (found === undefined) throw fail(404, 'not_found');
			found.deleted_at = clock();
			found.remove_at = new Date(Date.parse(clock()) + 30 * 86_400_000).toISOString();
			journal(id, 'version_deleted');
			return found;
		},
		restoreVersion: async (id, versionId, body) => {
			const node = need(id);
			if (body.expected_version !== undefined && body.expected_version !== node.current_version) {
				throw fail(412, 'version_conflict');
			}
			const list = versions.get(id) ?? [];
			const source = list.find((v) => v.id === versionId);
			if (source === undefined) throw fail(404, 'not_found');
			const restored: Version = { ...source, id: body.version_id, created_at: clock() };
			list.push(restored);
			nodes.set(id, { ...node, current_version: restored.id, updated_at: clock() });
			journal(id, 'version');
			return restored;
		},
		createUpload: async (body) => {
			checkSuite(body.suite);
			need(body.node_id);
			if (state.quota > 0 && used + reserved + body.stored_size > state.quota) {
				throw fail(413, 'quota_exceeded');
			}
			reserved += body.stored_size;
			const upload: Upload = {
				id: 'b' + String(uploads.size + blobs.size).padStart(31, '0'),
				...body,
				frames: [],
				created_at: clock()
			};
			uploads.set(upload.id, { upload, frames: new Map() });
			return upload;
		},
		getUpload: async (id) => {
			const stored = uploads.get(id);
			if (stored === undefined) throw fail(404, 'not_found');
			return { ...stored.upload, frames: [...stored.frames.keys()].sort((a, b) => a - b) };
		},
		abortUpload: async (id) => {
			const stored = uploads.get(id);
			if (stored === undefined) throw fail(404, 'not_found');
			reserved -= stored.upload.stored_size;
			uploads.delete(id);
		},
		putFrame: async (id, index, bytes, digest) => {
			calls.push(`frame ${index}`);
			const failure = state.failFrame?.(index);
			if (failure) throw failure;
			const stored = uploads.get(id);
			if (stored === undefined) throw fail(404, 'not_found');
			const { upload } = stored;
			const stride = upload.frame_size + overhead;
			const length =
				index === upload.frame_count - 1
					? upload.stored_size - (upload.frame_count - 1) * stride
					: stride;
			if (index >= upload.frame_count || bytes.length !== length) throw fail(400, 'frame_length');
			if (encodeBase64(sha256(bytes)) !== digest) throw fail(400, 'frame_hash');
			const existing = stored.frames.get(index);
			if (existing !== undefined && existing.digest !== digest) throw fail(409, 'frame_conflict');
			stored.frames.set(index, { data: bytes.slice(), digest });
		},
		commitUpload: async (id, body) => {
			const stored = uploads.get(id);
			if (stored === undefined) throw fail(404, 'not_found');
			const { upload, frames } = stored;
			if (frames.size !== upload.frame_count) throw fail(409, 'upload_incomplete');
			const node = need(upload.node_id);
			if (
				body.expected_version !== undefined &&
				body.expected_version !== (node.current_version ?? '')
			) {
				throw fail(412, 'version_conflict');
			}
			const parts: Uint8Array[] = [];
			const hashes = new Uint8Array(upload.frame_count * 32);
			for (let i = 0; i < upload.frame_count; i++) {
				const frame = frames.get(i) as { data: Uint8Array; digest: string };
				parts.push(frame.data);
				hashes.set(decodeBase64(frame.digest), i * 32);
			}
			const blob = new Uint8Array(upload.stored_size);
			let at = 0;
			for (const part of parts) {
				blob.set(part, at);
				at += part.length;
			}
			blobs.set(id, blob);
			reserved -= upload.stored_size;
			used += upload.stored_size;
			uploads.delete(id);
			const version: Version = {
				id: upload.version_id,
				node_id: upload.node_id,
				blob_id: id,
				suite: upload.suite,
				author_id: USER_ID,
				content_version_id: upload.version_id,
				content_author_id: USER_ID,
				stored_size: upload.stored_size,
				frame_count: upload.frame_count,
				frame_size: upload.frame_size,
				created_at: clock(),
				frame_hashes: encodeBase64(hashes),
				signature: body.signature,
				manifest: body.manifest
			};
			versions.set(upload.node_id, [...(versions.get(upload.node_id) ?? []), version]);
			nodes.set(upload.node_id, { ...node, current_version: version.id, updated_at: clock() });
			journal(upload.node_id, 'version');
			if (state.loseCommitAnswer) {
				state.loseCommitAnswer = false;
				throw fail(0, 'network');
			}
			return version;
		},
		getBlob: async (id, range) => {
			const blob = blobs.get(id);
			if (blob === undefined) throw fail(404, 'not_found');
			const part = (range ? blob.slice(range.start, range.end + 1) : blob.slice()) as Bytes;
			return (state.tamperBlob ? state.tamperBlob(id, part) : part) as Bytes;
		},
		putSmallBlob: async (id, params, bytes, digest) => {
			checkSuite(params.suite);
			if (encodeBase64(sha256(bytes)) !== digest) throw fail(400, 'frame_hash');
			blobs.set(id, bytes.slice());
			if (params.node_id !== undefined) {
				const node = need(params.node_id);
				nodes.set(node.id, { ...node, thumb_blob_id: id });
				journal(node.id, 'thumbnail');
			}
			return {
				id,
				kind: params.kind,
				suite: params.suite,
				size: bytes.length,
				node_id: params.node_id,
				created_at: clock()
			};
		},
		listChanges: async ({ cursor, limit = 200 } = {}) => {
			const from = cursor === undefined ? 0 : Number(cursor);
			const chunk = changes.slice(from, from + limit);
			return { changes: chunk, next_cursor: String(from + chunk.length) };
		}
	};

	return { api: api as Api, state, nodes, versions, uploads, blobs, calls, journal };
}

/** A user's keys in either mode, made with the real sealer. */
export function fakeUser(suite: Suite): UserKeys {
	return sealerFor(suite).createUser(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).keys;
}

/** Everything the tree and the engine take, over a fake server in this mode. */
export function driveFixture(
	suite: Suite = SUITE_E2E,
	options: { quota?: number; resume?: ResumeStore } = {}
) {
	const server = fakeDriveServer(suite, options);
	const sealer = sealerFor(suite);
	const keys = fakeUser(suite);
	const tree = new DriveTree({
		api: server.api,
		sealer,
		keys: () => keys,
		open: async (parentKey, parentId, records) => openNodes(sealer, parentKey, parentId, records)
	});
	const engine: EngineDeps = {
		api: server.api,
		sealer,
		keys: () => keys,
		pool: inlineFramePool(sealer),
		resume: options.resume ?? memoryResumeStore(),
		limiter: new Limiter(4),
		userId: () => USER_ID,
		frameSize: TEST_FRAME,
		sleep: async () => {}
	};
	return { server, sealer, keys, tree, engine };
}

export const SUITES: [string, Suite][] = [
	['end-to-end', SUITE_E2E],
	['none', SUITE_NONE]
];

/** A file as the queue and the engine see one. */
export function fakeFile(name: string, bytes: Uint8Array, lastModified = 1_750_000_000_000) {
	return {
		name,
		type: '',
		size: bytes.length,
		lastModified,
		slice: (start: number, end: number) => ({
			arrayBuffer: async () => bytes.slice(start, end).buffer as ArrayBuffer
		})
	};
}

/** Bytes that differ everywhere, so that a frame out of place shows. */
export function patterned(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
	return bytes;
}
