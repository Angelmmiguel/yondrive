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
	type Comment,
	type ErrorCode,
	type Grant,
	type GrantRole,
	type IncomingItem,
	type KeyLink,
	type Link,
	type Node,
	type NodeRole,
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

/** Whoever else is in a test. */
export interface FakeUser {
	id: string;
	username: string;
	public_keys?: { x25519: string; ed25519: string };
}
export const TEST_FRAME = 1024;

/** A server over one user, for one suite. */
export function fakeDriveServer(suite: Suite, options: { quota?: number } = {}) {
	const overhead = sealerFor(suite).frameOverhead;
	const nodes = new Map<string, Node>();
	const versions = new Map<string, Version[]>();
	const uploads = new Map<string, StoredUpload>();
	const blobs = new Map<string, Uint8Array>();
	const indexBlobs = new Map<string, string>();
	const changes: Change[] = [];
	const calls: string[] = [];
	let seq = 0;
	let reserved = 0;
	let used = 0;
	const roots = new Map<string, string>();
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
		loseCommitAnswer: false,
		/** Who is asking. `as` sets it, for the length of a call. */
		actor: USER_ID,
		/** The server's clock for links, which a test moves. */
		now: 1_760_000_000_000,
		/** Fails the next rotations with this, one each, as a conflict or a stop would. */
		failRotation: [] as ((id: string) => ApiError | null)[],
		/** A public key a hostile server names for a request, in place of its own. */
		requestKey: null as string | null,
		/** Takes no session token any more, as after the server has forgotten them. */
		forgetSessions: false,
		/** Rewrites a comment on its way out. */
		tamperComment: null as ((comment: Comment) => Comment) | null
	};
	const users = new Map<string, FakeUser>();
	const grants = new Map<string, Grant & { read?: boolean }>();
	const links = new Map<
		string,
		Link & {
			password_wrapped_key?: string;
			auth_key?: string;
			kdf?: unknown;
			sessions: Map<string, Set<string>>;
		}
	>();
	/** Uploads through requests, by id, and what has arrived and waits. */
	const requestUploads = new Map<
		string,
		StoredUpload & { linkId: string; nodeId: string; size: number }
	>();
	const incoming = new Map<string, IncomingItem>();
	const history = new Map<string, KeyLink[]>();
	const comments = new Map<string, Comment>();
	let commentSeq = 0;
	let grantSeq = 0;
	let requestSeq = 0;

	const lineage = (node: Node): Node[] => {
		const out: Node[] = [node];
		let at = node;
		while (at.parent_id !== undefined) {
			const parent = nodes.get(at.parent_id);
			if (parent === undefined) break;
			out.push(parent);
			at = parent;
		}
		return out;
	};

	const trashedAbove = (node: Node) => lineage(node).some((n) => n.trashed_at !== undefined);

	/** The one place that says who may do what, as the real server's effective role. */
	function roleOf(node: Node, actor = state.actor): NodeRole | null {
		if (node.owner_id === actor) return 'owner';
		if (trashedAbove(node)) return null;
		const rank: Record<string, number> = { viewer: 1, commenter: 2, editor: 3 };
		let role: NodeRole | null = null;
		for (const at of lineage(node)) {
			for (const grant of grants.values()) {
				if (grant.node_id === at.id && grant.grantee_id === actor) {
					if (role === null || rank[grant.role] > rank[role]) role = grant.role;
				}
			}
		}
		return role;
	}

	/** A node as this user sees it. What belongs to a folder they cannot see does not show. */
	function view(node: Node): Node {
		const role = roleOf(node);
		if (role === null) throw fail(404, 'not_found');
		const parent = node.parent_id === undefined ? undefined : nodes.get(node.parent_id);
		const out: Node = { ...node, role };
		if (parent !== undefined && roleOf(parent) === null) {
			delete out.parent_id;
			delete out.name_tag;
			out.wrapped_key = '';
		}
		return out;
	}

	function needRole(id: string, wanted: 'read' | 'comment' | 'write' | 'own'): Node {
		const node = need(id);
		const role = roleOf(node);
		if (role === null) throw fail(404, 'not_found');
		if (wanted === 'own' && role !== 'owner') throw fail(403, 'forbidden');
		if (wanted === 'write' && (role === 'viewer' || role === 'commenter')) {
			throw fail(403, 'forbidden');
		}
		if (wanted === 'comment' && role === 'viewer') throw fail(403, 'forbidden');
		return node;
	}

	function needParentWrite(node: Node) {
		const parent = node.parent_id === undefined ? undefined : nodes.get(node.parent_id);
		const role = parent === undefined ? null : roleOf(parent);
		if (role === null || role === 'viewer' || role === 'commenter') throw fail(403, 'forbidden');
	}

	/** A comment on a file this user may act on as `wanted` says. */
	function needComment(nodeId: string, id: string, wanted: 'read' | 'comment' | 'write') {
		const node = needRole(nodeId, wanted);
		const comment = comments.get(id);
		if (comment === undefined || comment.node_id !== nodeId) throw fail(404, 'not_found');
		return { node, comment };
	}

	function commented(node: Node) {
		node.comment_seq = (node.comment_seq ?? 0) + 1;
		journal(node.id, 'commented');
	}

	function checkGeneration(node: Node, given: number | undefined) {
		if (given !== undefined && given !== (node.key_generation ?? 1)) {
			throw fail(412, 'key_generation_conflict');
		}
	}

	const keyChainFor = (nodeId: string, generation: number): KeyLink[] | undefined => {
		const chain = (history.get(nodeId) ?? [])
			.filter((link) => link.generation >= generation)
			.sort((a, b) => b.generation - a.generation);
		return chain.length === 0 ? undefined : chain;
	};

	const accessOf = (nodeId: string) => {
		const at = need(nodeId);
		const asking = state.actor;
		const owner = at.owner_id === asking;
		return {
			access: lineage(at).flatMap((node, depth) =>
				[...grants.values()]
					.filter((grant) => grant.node_id === node.id)
					// Anyone but the owner sees their own grants, and those of who may write.
					.filter((grant) => owner || grant.grantee_id === asking || grant.role !== 'viewer')
					.map((grant) => ({
						user_id: grant.grantee_id,
						username: grant.grantee_username,
						role: grant.role,
						inherited: depth > 0,
						grant_id: owner || grant.grantee_id === asking ? grant.id : undefined,
						node_id: owner ? grant.node_id : undefined,
						key_generation: owner ? grant.key_generation : undefined,
						sealed_key: owner ? grant.sealed_key : undefined,
						signature: owner ? grant.signature : undefined
					}))
			)
		};
	};

	const liveLink = (id: string) => {
		const link = links.get(id);
		if (link === undefined) throw fail(404, 'not_found');
		if (link.revoked_at !== undefined) throw fail(410, 'link_revoked');
		if (link.expires_at !== undefined && Date.parse(link.expires_at) <= state.now) {
			throw fail(410, 'link_expired');
		}
		return link;
	};

	const openDoc = (link: ReturnType<typeof liveLink>, session: string) => {
		const node = need(link.node_id);
		return {
			id: link.id,
			state: 'open' as const,
			node: publicNode(node, link.node_id),
			sealed_key: link.sealed_key,
			key_generation: link.key_generation,
			token: `${link.id}.${session}`,
			token_expires_at: new Date(state.now + 900_000).toISOString(),
			password_wrapped_key: link.password_wrapped_key,
			downloads_remaining:
				link.download_limit === undefined
					? undefined
					: Math.max(link.download_limit - link.download_count, 0)
		};
	};

	const publicNode = (node: Node, top: string) => ({
		id: node.id,
		parent_id: node.id === top ? undefined : node.parent_id,
		kind: node.kind,
		suite: node.suite,
		sealed_metadata: node.sealed_metadata,
		wrapped_key: node.id === top ? '' : node.wrapped_key,
		key_generation: node.key_generation ?? 1,
		current_version: node.current_version,
		thumb_blob_id: node.thumb_blob_id,
		created_at: node.created_at,
		updated_at: node.updated_at
	});

	const authorizeLink = (id: string, token: string) => {
		const link = liveLink(id);
		const [linkId, session] = token.split('.');
		if (linkId !== id || session === undefined) throw fail(401, 'link_token_invalid');
		return { link, session };
	};

	const authorizeRequest = (id: string, token: string) => {
		const found = authorizeLink(id, token);
		if (found.link.kind !== 'request') throw fail(404, 'not_found');
		return found;
	};

	const requestDoc = (link: ReturnType<typeof liveLink>, session: string) => ({
		id: link.id,
		state: 'open' as const,
		suite,
		public_key: state.requestKey ?? link.public_key ?? '',
		token: `${link.id}.${session}`,
		token_expires_at: new Date(state.now + 15 * 60_000).toISOString(),
		expires_at: link.expires_at,
		max_file_size: link.max_file_size,
		files_remaining:
			link.file_limit === undefined
				? undefined
				: Math.max(link.file_limit - (link.files_received ?? 0), 0),
		bytes_remaining:
			link.bytes_limit === undefined
				? undefined
				: Math.max(link.bytes_limit - (link.bytes_received ?? 0), 0)
	});

	const requestUpload = (linkId: string, uploadId: string) => {
		const stored = requestUploads.get(uploadId);
		if (stored === undefined || stored.linkId !== linkId) throw fail(404, 'not_found');
		return stored;
	};

	/** Checks and keeps a frame, as the real server does. */
	function putInto(stored: StoredUpload, index: number, bytes: Uint8Array, digest: string) {
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
	}

	/** The stored file of a complete upload, and its frames' digests. */
	function assemble({ upload, frames }: StoredUpload) {
		const hashes = new Uint8Array(upload.frame_count * 32);
		const blob = new Uint8Array(upload.stored_size);
		let at = 0;
		for (let i = 0; i < upload.frame_count; i++) {
			const frame = frames.get(i) as { data: Uint8Array; digest: string };
			blob.set(frame.data, at);
			at += frame.data.length;
			hashes.set(decodeBase64(frame.digest), i * 32);
		}
		return { hashes, blob };
	}

	const underLink = (link: { node_id: string }, id: string) => {
		const node = need(id);
		if (trashedAbove(node) || !lineage(node).some((n) => n.id === link.node_id)) {
			throw fail(404, 'not_found');
		}
		return node;
	};

	const newGrantId = () => (++grantSeq).toString(16).padStart(32, 'a');

	function need(id: string): Node {
		const node = nodes.get(id);
		if (node === undefined) throw fail(404, 'not_found');
		return node;
	}

	const madeGeneration = { key_generation: 1 };

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
			const root = roots.get(state.actor);
			if (root === undefined) throw fail(404, 'not_found');
			return view(need(root));
		},
		createRootNode: async (body) => {
			checkSuite(body.suite);
			const root = roots.get(state.actor);
			if (root !== undefined) return view(need(root));
			const now = clock();
			const node: Node = {
				id: body.id,
				owner_id: state.actor,
				...madeGeneration,
				kind: 'folder',
				suite: body.suite,
				sealed_metadata: body.sealed_metadata ?? '',
				wrapped_key: body.wrapped_key,
				created_at: now,
				updated_at: now
			};
			nodes.set(node.id, node);
			roots.set(state.actor, node.id);
			return view(node);
		},
		createNode: async (body) => {
			checkSuite(body.suite);
			if (nodes.has(body.id)) throw fail(409, 'id_taken');
			const parent = needRole(body.parent_id, 'write');
			if (parent.kind !== 'folder') throw fail(400, 'not_a_folder');
			checkGeneration(parent, body.parent_key_generation);
			if (takenAmong(body.parent_id, body.name_tag)) throw fail(409, 'name_conflict');
			const now = clock();
			const node: Node = {
				id: body.id,
				owner_id: parent.owner_id,
				...madeGeneration,
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
		getNode: async (id) => view(need(id)),
		updateNode: async (id, body) => {
			checkSuite(body.suite);
			const node = needRole(id, 'write');
			if (node.trashed_at !== undefined) throw fail(409, 'node_trashed');
			if (body.name_tag !== undefined) needParentWrite(node);
			if (body.sealed_metadata !== undefined) checkGeneration(node, body.key_generation);
			if (body.name_tag !== undefined && node.parent_id !== undefined) {
				checkGeneration(need(node.parent_id), body.parent_key_generation);
			}
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
			return view(updated);
		},
		listChildren: async (id, { cursor, limit } = {}) => {
			needRole(id, 'read');
			const { items, next } = page(
				[...nodes.values()].filter((n) => n.parent_id === id && n.trashed_at === undefined),
				(n) => n.id,
				cursor,
				limit
			);
			return { nodes: items.map(view), next_cursor: next };
		},
		moveNode: async (id, body) => {
			const node = needRole(id, 'write');
			if (node.parent_id === undefined) throw fail(409, 'root_immutable');
			needParentWrite(node);
			checkGeneration(needRole(body.parent_id, 'write'), body.parent_key_generation);
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
			return view(updated);
		},
		trashNode: async (id) => {
			const node = needRole(id, 'write');
			if (node.parent_id === undefined) throw fail(409, 'root_immutable');
			needParentWrite(node);
			const updated = { ...node, trashed_at: node.trashed_at ?? clock(), updated_at: clock() };
			nodes.set(id, updated);
			journal(id, 'trashed');
			return node.owner_id === state.actor
				? updated
				: { ...updated, role: roleOf(node) ?? 'editor' };
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
			const node = needRole(id, 'own');
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
				[...nodes.values()].filter((n) => n.trashed_at !== undefined && n.owner_id === state.actor),
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
			needRole(id, 'read');
			const found = (versions.get(id) ?? []).find((v) => v.id === versionId);
			if (found === undefined) throw fail(404, 'not_found');
			const answer: Version = {
				...found,
				key_chain: keyChainFor(id, found.key_generation ?? 1)
			};
			return state.tamperVersion ? state.tamperVersion(answer) : answer;
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
			checkGeneration(needRole(body.node_id, 'write'), body.key_generation);
			if (state.quota > 0 && used + reserved + body.stored_size > state.quota) {
				throw fail(413, 'quota_exceeded');
			}
			reserved += body.stored_size;
			const upload: Upload = {
				id: 'b' + String(uploads.size + blobs.size).padStart(31, '0'),
				...body,
				key_generation: body.key_generation ?? need(body.node_id).key_generation,
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
			checkGeneration(node, upload.key_generation);
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
				author_id: state.actor,
				content_version_id: upload.version_id,
				content_author_id: state.actor,
				key_generation: upload.key_generation,
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
			if (params.kind === 'index') indexBlobs.set(id, state.actor);
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
		deleteSmallBlob: async (id) => {
			if (!blobs.delete(id)) throw fail(404, 'not_found');
			indexBlobs.delete(id);
		},
		listIndexBlobs: async ({ cursor, limit = 200 } = {}) => {
			const mine = [...indexBlobs.entries()]
				.filter(([, owner]) => owner === state.actor)
				.map(([id]) => id);
			const { items, next } = page(mine, (id) => id, cursor, limit);
			return {
				blobs: items.map((id) => ({
					id,
					kind: 'index' as const,
					suite,
					size: blobs.get(id)?.length ?? 0,
					created_at: clock()
				})),
				next_cursor: next
			};
		},
		listUploads: async ({ cursor, limit = 200 } = {}) => {
			const open = [...uploads.values()].map(({ upload, frames }) => ({ upload, frames }));
			const { items, next } = page(open, (one) => one.upload.id, cursor, limit);
			return {
				uploads: items.map(({ upload, frames }) => ({
					id: upload.id,
					node_id: upload.node_id,
					version_id: upload.version_id,
					suite: upload.suite,
					frame_count: upload.frame_count,
					frame_size: upload.frame_size,
					stored_size: upload.stored_size,
					frames_received: frames.size,
					created_at: upload.created_at,
					updated_at: upload.created_at
				})),
				next_cursor: next
			};
		},
		listComments: async (id, { cursor, limit = 200 } = {}) => {
			const node = needRole(id, 'read');
			const all = [...comments.values()].filter((c) => c.node_id === id);
			const from = cursor === undefined ? 0 : Number(cursor);
			const chunk = all.slice(from, from + limit);
			const oldest = Math.min(
				node.key_generation ?? 1,
				...chunk.flatMap((c) => [c.key_generation, c.anchor?.key_generation ?? Infinity])
			);
			return {
				comments: chunk.map((c) => (state.tamperComment ? state.tamperComment(c) : c)),
				key_chain: keyChainFor(id, oldest),
				next_cursor: from + limit < all.length ? String(from + limit) : undefined
			};
		},
		createComment: async (id, body) => {
			const node = needRole(id, 'comment');
			if (node.kind !== 'file') throw fail(409, 'not_a_file');
			checkGeneration(node, body.key_generation);
			if (body.anchor) checkGeneration(node, body.anchor.key_generation);
			if (comments.has(body.id)) throw fail(409, 'id_taken');
			const threadId = body.thread_id ?? body.id;
			if (threadId !== body.id) {
				const first = comments.get(threadId);
				if (first === undefined || first.node_id !== id) throw fail(404, 'not_found');
				if (first.thread_id !== first.id || body.anchor) throw fail(400, 'invalid_comment');
			}
			const at = clock();
			const comment: Comment = {
				id: body.id,
				node_id: id,
				thread_id: threadId,
				author_id: state.actor,
				author_username: users.get(state.actor)?.username ?? 'owner',
				key_generation: body.key_generation,
				sealed_body: body.sealed_body,
				signature: body.signature,
				anchor: body.anchor && {
					...body.anchor,
					signer_id: state.actor,
					updated_at: at
				},
				created_at: at,
				resolved: false,
				seq: ++commentSeq
			} as Comment;
			comments.set(comment.id, comment);
			commented(node);
			return comment;
		},
		updateComment: async (id, commentId, body) => {
			const { node, comment } = needComment(id, commentId, 'comment');
			if (comment.author_id !== state.actor) throw fail(403, 'forbidden');
			checkGeneration(node, body.key_generation);
			const updated = { ...comment, ...body, edited_at: clock() };
			comments.set(commentId, updated);
			commented(node);
			return updated;
		},
		deleteComment: async (id, commentId) => {
			const { node, comment } = needComment(id, commentId, 'read');
			const role = roleOf(node);
			const mine = comment.author_id === state.actor && role !== 'viewer';
			if (!mine && role !== 'owner') throw fail(403, 'forbidden');
			const answered = [...comments.values()].some(
				(c) => c.thread_id === commentId && c.id !== commentId && c.author_id !== state.actor
			);
			if (role !== 'owner' && answered) throw fail(409, 'comment_has_replies');
			for (const c of [...comments.values()]) {
				if (c.id === commentId || c.thread_id === commentId) comments.delete(c.id);
			}
			commented(node);
		},
		updateCommentAnchor: async (id, commentId, body) => {
			const { node, comment } = needComment(id, commentId, 'write');
			if (comment.thread_id !== comment.id) throw fail(400, 'invalid_comment');
			checkGeneration(node, body.key_generation);
			const updated = {
				...comment,
				anchor: { ...body, signer_id: state.actor, updated_at: clock() }
			};
			comments.set(commentId, updated);
			commented(node);
			return updated;
		},
		resolveComment: async (id, commentId, body) => {
			const { node, comment } = needComment(id, commentId, 'write');
			if (comment.thread_id !== comment.id) throw fail(400, 'invalid_comment');
			const updated = {
				...comment,
				resolved: body.resolved,
				resolved_by: body.resolved ? state.actor : undefined
			};
			comments.set(commentId, updated);
			commented(node);
			return updated;
		},

		listChanges: async ({ cursor, limit = 200 } = {}) => {
			const from = cursor === undefined ? 0 : Number(cursor);
			const chunk = changes.slice(from, from + limit);
			return { changes: chunk, next_cursor: String(from + chunk.length) };
		},

		lookupUser: async (username) => {
			const user = [...users.values()].find((u) => u.username === username);
			if (user === undefined) throw fail(404, 'not_found');
			return { id: user.id, username: user.username, public_keys: user.public_keys };
		},
		getUserKeys: async (id) => {
			const user = users.get(id);
			if (user === undefined) throw fail(404, 'not_found');
			if (user.public_keys === undefined) throw fail(404, 'no_keys');
			return { user_id: id, username: user.username, public_keys: user.public_keys };
		},
		createGrant: async (body) => {
			const node = needRole(body.node_id, 'own');
			if (node.parent_id === undefined) throw fail(409, 'root_immutable');
			checkGeneration(node, body.key_generation);
			if (body.grantee_id === node.owner_id) throw fail(400, 'invalid_grant');
			const grantee = users.get(body.grantee_id);
			if (grantee === undefined) throw fail(404, 'not_found');
			for (const grant of grants.values()) {
				if (grant.node_id === body.node_id && grant.grantee_id === body.grantee_id) {
					throw fail(409, 'grant_exists');
				}
			}
			const granter = users.get(state.actor);
			const grant: Grant = {
				id: newGrantId(),
				...body,
				grantee_username: grantee.username,
				granter_id: state.actor,
				granter_username: granter?.username ?? 'owner',
				created_at: clock()
			};
			grants.set(grant.id, grant);
			journal(body.node_id, 'granted');
			return grant;
		},
		updateGrant: async (id, body) => {
			const grant = grants.get(id);
			if (grant === undefined) throw fail(404, 'not_found');
			needRole(grant.node_id, 'own');
			const updated: Grant = { ...grant, role: body.role as GrantRole, signature: body.signature };
			grants.set(id, updated);
			journal(grant.node_id, 'role_changed');
			return updated;
		},
		deleteGrant: async (id) => {
			const grant = grants.get(id);
			if (grant === undefined) throw fail(404, 'not_found');
			if (grant.grantee_id !== state.actor) needRole(grant.node_id, 'own');
			grants.delete(id);
			journal(grant.node_id, 'revoked');
		},
		listNodeAccess: async (id) => {
			needRole(id, 'read');
			return accessOf(id);
		},
		listGrantsMade: async ({ cursor } = {}) => {
			const { items, next } = page(
				[...grants.values()].filter((g) => g.granter_id === state.actor),
				(g) => g.id,
				cursor
			);
			return {
				items: items.map((grant) => ({ grant, node: need(grant.node_id) })),
				next_cursor: next
			};
		},
		listSharedWithMe: async ({ cursor } = {}) => {
			const { items, next } = page(
				[...grants.values()].filter(
					(g) => g.grantee_id === state.actor && roleOf(need(g.node_id)) !== null
				),
				(g) => g.id,
				cursor
			);
			return {
				items: items.map((grant) => ({ grant, node: view(need(grant.node_id)) })),
				next_cursor: next
			};
		},
		listNotifications: async () => ({
			notifications: [...grants.values()]
				.filter((g) => g.grantee_id === state.actor && !g.read)
				.map((g) => ({
					grant_id: g.id,
					node_id: g.node_id,
					granter_id: g.granter_id,
					created_at: g.created_at
				})),
			has_more: false,
			comments: []
		}),
		markNotificationsRead: async (body) => {
			for (const grant of grants.values()) {
				if (
					grant.grantee_id === state.actor &&
					(body.grant_ids === undefined || body.grant_ids.includes(grant.id))
				) {
					grant.read = true;
				}
			}
		},
		rotateNode: async (id, body) => {
			const fault = state.failRotation.shift()?.(id);
			if (fault) throw fault;
			const node = needRole(id, 'own');
			if (node.parent_id === undefined) throw fail(409, 'root_immutable');
			checkGeneration(node, body.key_generation);
			checkGeneration(need(node.parent_id), body.parent_key_generation);
			const generation = node.key_generation ?? 1;
			const children = [...nodes.values()].filter((n) => n.parent_id === id);
			const named = new Set(body.children.map((c) => c.id));
			if (named.size !== children.length || children.some((c) => !named.has(c.id))) {
				throw fail(409, 'rotate_conflict');
			}
			const onNode = [...grants.values()].filter((g) => g.node_id === id);
			const dropGrants = body.drop_grants ?? [];
			if (onNode.length !== body.grants.length + dropGrants.length) {
				throw fail(409, 'rotate_conflict');
			}
			for (const given of [...body.grants.map((g) => g.grantee_id), ...dropGrants]) {
				if (!onNode.some((g) => g.grantee_id === given)) throw fail(409, 'rotate_conflict');
			}
			const live = [...links.values()].filter(
				(l) =>
					l.kind === 'view' &&
					l.node_id === id &&
					l.revoked_at === undefined &&
					(l.expires_at === undefined || Date.parse(l.expires_at) > state.now)
			);
			const givenLinks = body.links ?? [];
			const dropLinks = body.drop_links ?? [];
			if (live.some((l) => !givenLinks.some((g) => g.id === l.id) && !dropLinks.includes(l.id))) {
				throw fail(409, 'rotate_conflict');
			}
			for (const grantee of dropGrants) {
				const grant = onNode.find((g) => g.grantee_id === grantee) as Grant;
				grants.delete(grant.id);
			}
			for (const linkId of dropLinks) {
				const link = links.get(linkId);
				if (link !== undefined) link.revoked_at ??= clock();
			}
			for (const child of body.children) {
				const stored = need(child.id);
				nodes.set(child.id, {
					...stored,
					wrapped_key: child.wrapped_key,
					name_tag: child.name_tag
				});
			}
			for (const given of body.grants) {
				const grant = onNode.find((g) => g.grantee_id === given.grantee_id) as Grant;
				grants.set(grant.id, {
					...grant,
					sealed_key: given.sealed_key,
					signature: given.signature,
					key_generation: generation + 1
				});
			}
			for (const given of givenLinks) {
				const link = links.get(given.id);
				if (link !== undefined) {
					link.sealed_key = given.sealed_key;
					link.key_generation = generation + 1;
				}
			}
			if (body.previous_key !== '') {
				history.set(id, [
					...(history.get(id) ?? []),
					{ generation, sealed_key: body.previous_key }
				]);
			}
			const updated: Node = {
				...node,
				key_generation: generation + 1,
				wrapped_key: body.wrapped_key,
				sealed_metadata: body.sealed_metadata,
				updated_at: clock()
			};
			delete updated.thumb_blob_id;
			nodes.set(id, updated);
			journal(id, 'rotated');
			return { ...updated, role: 'owner' };
		},

		createLink: async (body) => {
			const node = needRole(body.node_id, 'own');
			if (node.parent_id === undefined) throw fail(409, 'root_immutable');
			checkGeneration(node, body.key_generation);
			if (links.has(body.id)) throw fail(409, 'id_taken');
			if (body.kind === 'request' && node.kind !== 'folder') throw fail(409, 'not_a_folder');
			const stored = {
				id: body.id,
				node_id: body.node_id,
				kind: body.kind ?? 'view',
				role: body.role,
				public_key: body.public_key,
				max_file_size: body.max_file_size,
				file_limit: body.file_limit,
				bytes_limit: body.bytes_limit,
				files_received: body.kind === 'request' ? 0 : undefined,
				bytes_received: body.kind === 'request' ? 0 : undefined,
				key_generation: body.key_generation,
				sealed_key: body.sealed_key,
				owner_sealed_key: body.owner_sealed_key,
				has_password: body.password !== undefined,
				download_count: 0,
				download_limit: body.download_limit,
				expires_at: body.expires_at,
				created_at: clock(),
				password_wrapped_key: body.password?.wrapped_key,
				auth_key: body.password?.auth_key,
				kdf: body.password?.kdf,
				sessions: new Map<string, Set<string>>()
			};
			links.set(body.id, stored);
			return stored;
		},
		listLinks: async ({ cursor } = {}) => {
			const { items, next } = page(
				[...links.values()].filter((l) => need(l.node_id).owner_id === state.actor),
				(l) => l.id,
				cursor
			);
			return {
				items: items.map((link) => ({ link, node: need(link.node_id) })),
				next_cursor: next
			};
		},
		revokeLink: async (id) => {
			const link = links.get(id);
			if (link === undefined) throw fail(404, 'not_found');
			link.revoked_at = clock();
			return link;
		},
		deleteLink: async (id) => {
			links.delete(id);
		},
		getPublicLink: async (id, token) => {
			const link = liveLink(id);
			if (link.kind !== 'view') throw fail(404, 'not_found');
			let session: string | undefined;
			if (token !== undefined && token.startsWith(`${id}.`)) session = token.split('.')[1];
			if (session === undefined) {
				if (link.download_limit !== undefined && link.download_count >= link.download_limit) {
					throw fail(410, 'link_limit_reached');
				}
				if (link.has_password) {
					return { id, state: 'password_required' as const, kdf: link.kdf as never };
				}
				session = String(link.sessions.size + 1);
			}
			return openDoc(link, session);
		},
		unlockPublicLink: async (id, body) => {
			const link = liveLink(id);
			if (link.auth_key !== body.auth_key) throw fail(401, 'link_password_invalid');
			return openDoc(link, String(link.sessions.size + 1));
		},
		getPublicNode: async (id, nodeId, token) => {
			const { link } = authorizeLink(id, token);
			return publicNode(underLink(link, nodeId), link.node_id);
		},
		listPublicChildren: async (id, nodeId, token, { cursor } = {}) => {
			const { link } = authorizeLink(id, token);
			underLink(link, nodeId);
			const { items, next } = page(
				[...nodes.values()].filter((n) => n.parent_id === nodeId && n.trashed_at === undefined),
				(n) => n.id,
				cursor
			);
			return { nodes: items.map((n) => publicNode(n, link.node_id)), next_cursor: next };
		},
		getPublicVersion: async (id, nodeId, token) => {
			const { link } = authorizeLink(id, token);
			const node = underLink(link, nodeId);
			const found = (versions.get(nodeId) ?? []).find((v) => v.id === node.current_version);
			if (found === undefined) throw fail(404, 'not_found');
			const author = users.get(found.content_author_id);
			return {
				id: found.id,
				node_id: found.node_id,
				blob_id: found.blob_id,
				suite: found.suite,
				content_version_id: found.content_version_id,
				key_generation: found.key_generation ?? 1,
				key_chain: keyChainFor(nodeId, found.key_generation ?? 1),
				stored_size: found.stored_size,
				frame_count: found.frame_count,
				frame_size: found.frame_size,
				frame_hashes: found.frame_hashes,
				signature: found.signature,
				manifest: found.manifest,
				author_public_key: author?.public_keys?.ed25519
			};
		},
		getPublicBlob: async (id, blobId, token, range) => {
			const { link, session } = authorizeLink(id, token);
			const content = [...versions.values()].flat().some((v) => v.blob_id === blobId);
			if (content) {
				const seen = link.sessions.get(session) ?? new Set<string>();
				if (!seen.has(blobId)) {
					if (link.download_limit !== undefined && link.download_count >= link.download_limit) {
						throw fail(410, 'link_limit_reached');
					}
					seen.add(blobId);
					link.sessions.set(session, seen);
					link.download_count += 1;
				}
			}
			const blob = blobs.get(blobId);
			if (blob === undefined) throw fail(404, 'not_found');
			return (range ? blob.slice(range.start, range.end + 1) : blob.slice()) as Bytes;
		},
		getPublicRequest: async (id, token) => {
			const link = liveLink(id);
			if (link.kind !== 'request') throw fail(404, 'not_found');
			let session: string | undefined;
			if (token !== undefined && token.startsWith(`${id}.`) && !state.forgetSessions)
				session = token.split('.')[1];
			if (session === undefined && link.has_password) {
				return { id, state: 'password_required' as const, kdf: link.kdf as never };
			}
			return requestDoc(link, session ?? String(link.sessions.size + 1));
		},
		unlockPublicRequest: async (id, body) => {
			const link = liveLink(id);
			if (link.kind !== 'request') throw fail(404, 'not_found');
			if (link.auth_key !== body.auth_key) throw fail(401, 'link_password_invalid');
			return requestDoc(link, String(link.sessions.size + 1));
		},
		createRequestUpload: async (id, token, body) => {
			const { link } = authorizeRequest(id, token);
			checkSuite(body.suite);
			const size = body.stored_size - body.frame_count * overhead;
			if (link.max_file_size !== undefined && size > link.max_file_size) {
				throw fail(413, 'request_file_too_large');
			}
			if (link.file_limit !== undefined && (link.files_received ?? 0) >= link.file_limit) {
				throw fail(409, 'request_files_reached');
			}
			if (link.bytes_limit !== undefined && (link.bytes_received ?? 0) + size > link.bytes_limit) {
				throw fail(413, 'request_bytes_reached');
			}
			if (state.quota > 0 && used + reserved + body.stored_size > state.quota) {
				throw fail(413, 'quota_exceeded');
			}
			reserved += body.stored_size;
			link.files_received = (link.files_received ?? 0) + 1;
			link.bytes_received = (link.bytes_received ?? 0) + size;
			const upload: Upload = {
				id: 'r' + String(++requestSeq).padStart(31, '0'),
				node_id: link.node_id,
				version_id: 'v' + String(requestSeq).padStart(31, '0'),
				suite: body.suite,
				frame_count: body.frame_count,
				frame_size: body.frame_size,
				stored_size: body.stored_size,
				frames: [],
				created_at: clock()
			};
			requestUploads.set(upload.id, {
				upload,
				frames: new Map(),
				linkId: id,
				nodeId: 'n' + String(requestSeq).padStart(31, '0'),
				size
			});
			return { ...upload, node_id: 'n' + String(requestSeq).padStart(31, '0'), frames: [] };
		},
		getRequestUpload: async (id, uploadId, token) => {
			authorizeRequest(id, token);
			const stored = requestUpload(id, uploadId);
			return {
				...stored.upload,
				node_id: stored.nodeId,
				frames: [...stored.frames.keys()].sort((a, b) => a - b)
			};
		},
		abortRequestUpload: async (id, uploadId, token) => {
			const { link } = authorizeRequest(id, token);
			const stored = requestUpload(id, uploadId);
			reserved -= stored.upload.stored_size;
			link.files_received = (link.files_received ?? 1) - 1;
			link.bytes_received = (link.bytes_received ?? stored.size) - stored.size;
			requestUploads.delete(uploadId);
		},
		putRequestFrame: async (id, uploadId, index, token, bytes, digest) => {
			authorizeRequest(id, token);
			calls.push(`request frame ${index}`);
			const failure = state.failFrame?.(index);
			if (failure) throw failure;
			putInto(requestUpload(id, uploadId), index, bytes, digest);
		},
		commitRequestUpload: async (id, uploadId, token, body) => {
			const { link } = authorizeRequest(id, token);
			const done = [...incoming.values()].some(
				(item) => item.blob_id === uploadId && item.link_id === id
			);
			if (done) return;
			const stored = requestUpload(id, uploadId);
			const { upload, frames } = stored;
			if (frames.size !== upload.frame_count) throw fail(409, 'upload_incomplete');
			const { hashes, blob } = assemble(stored);
			blobs.set(upload.id, blob);
			reserved -= upload.stored_size;
			used += upload.stored_size;
			requestUploads.delete(uploadId);
			incoming.set(stored.nodeId, {
				id: stored.nodeId,
				link_id: id,
				folder_id: link.node_id,
				suite: upload.suite,
				sealed_key: body.sealed_key,
				sealed_metadata: body.sealed_metadata,
				public_key: link.public_key ?? '',
				sealed_private_key: link.owner_sealed_key,
				version_id: upload.version_id,
				blob_id: upload.id,
				size: stored.size,
				stored_size: upload.stored_size,
				frame_count: upload.frame_count,
				frame_size: upload.frame_size,
				frame_hashes: encodeBase64(hashes),
				created_at: clock()
			});
		},

		listIncoming: async ({ cursor } = {}) => {
			const mine = [...incoming.values()].filter(
				(item) => need(item.folder_id).owner_id === state.actor
			);
			const { items, next } = page(mine, (item) => item.id, cursor);
			return { items, next_cursor: next };
		},
		deleteIncoming: async (id) => {
			const item = incoming.get(id);
			if (item === undefined || need(item.folder_id).owner_id !== state.actor) {
				throw fail(404, 'not_found');
			}
			incoming.delete(id);
			blobs.delete(item.blob_id);
			used -= item.stored_size;
		},
		adoptIncoming: async (id, body) => {
			const item = incoming.get(id);
			if (item === undefined) throw fail(404, 'not_found');
			const folder = needRole(item.folder_id, 'own');
			if (trashedAbove(folder)) throw fail(409, 'parent_trashed');
			checkGeneration(folder, body.parent_key_generation);
			if (takenAmong(folder.id, body.name_tag)) throw fail(409, 'name_conflict');
			const now = clock();
			const node: Node = {
				id,
				owner_id: folder.owner_id,
				...madeGeneration,
				parent_id: folder.id,
				kind: 'file',
				suite: item.suite,
				sealed_metadata: body.sealed_metadata,
				wrapped_key: body.wrapped_key,
				name_tag: body.name_tag,
				current_version: item.version_id,
				created_at: now,
				updated_at: now
			};
			const version: Version = {
				id: item.version_id,
				node_id: id,
				blob_id: item.blob_id,
				suite: item.suite,
				author_id: folder.owner_id,
				content_version_id: item.version_id,
				content_author_id: folder.owner_id,
				key_generation: 1,
				stored_size: item.stored_size,
				frame_count: item.frame_count,
				frame_size: item.frame_size,
				frame_hashes: item.frame_hashes,
				signature: body.signature,
				manifest: body.manifest,
				created_at: now
			};
			nodes.set(id, node);
			versions.set(id, [version]);
			incoming.delete(id);
			journal(id, 'created');
			journal(id, 'version');
			return { ...node, role: 'owner' as const };
		}
	};

	return {
		api: api as Api,
		state,
		nodes,
		versions,
		uploads,
		blobs,
		calls,
		journal,
		users,
		grants,
		links,
		incoming,
		comments,
		requestUploads,
		/** The same server, with every call made as this user. */
		as(userId: string): Api {
			return new Proxy(api as Api, {
				get(target, name: keyof Api) {
					const call = target[name] as (...args: unknown[]) => unknown;
					return (...args: unknown[]) => {
						state.actor = userId;
						return call(...args);
					};
				}
			});
		}
	};
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

/** Two or more people on one server, each with their keys and a `Drive`-shaped set of parts. */
export function testPublicKeys(keys: UserKeys): { x25519: string; ed25519: string } | undefined {
	if (keys.identity.x25519.publicKey.length === 0) return undefined;
	return {
		x25519: encodeBase64(keys.identity.x25519.publicKey),
		ed25519: encodeBase64(keys.identity.ed25519.publicKey)
	};
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

/** The cheapest parameters the rules allow, for tests that derive from a link's password. */
export const CHEAP_KDF = () => ({
	name: 'argon2id' as const,
	m: 8192,
	t: 1,
	p: 1,
	salt: encodeBase64(new Uint8Array(16).fill(9))
});
