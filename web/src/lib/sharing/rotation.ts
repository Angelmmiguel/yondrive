/**
 * Replacing a node's key after revoking someone, who may have kept it. One call per
 * node, from the top of the share down, parents first, as each wrap is made under the
 * parent's new key. A job is written down before it starts and notes each node's
 * generation as it goes, so a client that stops can go on: a node at or past the
 * generation noted is done. Nothing about the content is sealed again.
 */
import type { Api } from '$lib/api/client';
import {
	isApiError,
	type Link,
	type Node,
	type NodeAccess,
	type RotateNodeRequest
} from '$lib/api/types';
import { SealError } from '$lib/crypto/aead';
import { decodeBase64, encodeBase64, type Bytes } from '$lib/crypto/encoding';
import type { PublicKeys } from '$lib/crypto/keys';
import { randomBytes, zero } from '$lib/crypto/random';
import type { Sealer, UserKeys } from '$lib/crypto/sealer';
import { parseMetadata } from '$lib/drive/metadata';

export interface RotationJob {
	topId: string;
	/** The generation each node reached, by id. */
	done: Record<string, number>;
}

export interface RotationJobs {
	list(): RotationJob[];
	save(job: RotationJob): void;
	remove(topId: string): void;
}

export function memoryRotationJobs(): RotationJobs {
	const jobs = new Map<string, RotationJob>();
	return {
		list: () => [...jobs.values()],
		save(job) {
			jobs.set(job.topId, job);
		},
		remove(topId) {
			jobs.delete(topId);
		}
	};
}

/** Holds ids and numbers, which the server knows already. */
export function localRotationJobs(userId: string): RotationJobs {
	const name = `yondrive.rotations.${userId}`;
	const read = (): RotationJob[] => {
		try {
			const parsed: unknown = JSON.parse(localStorage.getItem(name) ?? '[]');
			return Array.isArray(parsed) ? (parsed as RotationJob[]) : [];
		} catch {
			return [];
		}
	};
	const write = (jobs: RotationJob[]) => {
		try {
			localStorage.setItem(name, JSON.stringify(jobs));
		} catch {
			// Without storage a stopped rotation is not resumed, and the file of it is lost.
		}
	};
	return {
		list: read,
		save(job) {
			write([...read().filter((other) => other.topId !== job.topId), job]);
		},
		remove(topId) {
			write(read().filter((other) => other.topId !== topId));
		}
	};
}

export interface RotationProgress {
	done: number;
	/** What is known so far: it grows as folders are read. */
	total: number;
}

export interface RotationDeps {
	api: Pick<
		Api,
		'getNode' | 'listChildren' | 'listTrash' | 'listNodeAccess' | 'listLinks' | 'rotateNode'
	>;
	sealer: Sealer;
	keys: () => UserKeys;
	userId: () => string;
	keysOf: (userId: string) => Promise<PublicKeys>;
	/** The key of the folder above the share, read fresh. */
	parentKey: (parentId: string) => Promise<Bytes>;
	jobs: RotationJobs;
	/** Takes a copy of the key if it wants one, as these are zeroed when the job ends. */
	onRotated?: (record: Node, key: Bytes, hadThumbnail: boolean) => void;
	now?: () => number;
}

/** One direct child, as the owner reads it to wrap it again. */
export interface ChildToRewrap {
	id: string;
	wrappedKey: Bytes;
	sealedMetadata: Bytes;
}

export interface RotationInput {
	node: Pick<Node, 'id' | 'sealed_metadata'>;
	generation: number;
	parentId: string;
	parentGeneration: number;
	parentKey: Uint8Array;
	oldKey: Uint8Array;
	newKey: Uint8Array;
	children: readonly ChildToRewrap[];
	grants: readonly { granteeId: string; role: string; keys: PublicKeys }[];
	links: readonly { id: string; linkKey: Uint8Array }[];
	granterId: string;
}

/** The whole body of a rotation, pure: everything sealed anew from what is passed in. */
export function buildRotation(
	input: RotationInput,
	sealer: Sealer,
	keys: UserKeys
): RotateNodeRequest {
	const { node, generation, oldKey, newKey, parentKey, parentId } = input;
	const nextGeneration = generation + 1;
	const stored = decodeBase64(node.sealed_metadata);
	let sealedMetadata = stored;
	try {
		sealedMetadata = sealer.sealMetadata(
			newKey,
			node.id,
			sealer.openMetadata(oldKey, node.id, stored)
		);
	} catch {
		// Already damaged: it stays as unreadable as it was.
	}
	return {
		key_generation: generation,
		parent_key_generation: input.parentGeneration,
		wrapped_key: encodeBase64(sealer.wrapNodeKey(newKey, parentKey, parentId, node.id)),
		previous_key: encodeBase64(sealer.sealPreviousKey(newKey, oldKey, node.id, generation)),
		sealed_metadata: encodeBase64(sealedMetadata),
		children: input.children.map((child) => rewrap(child, oldKey, newKey, node.id, sealer)),
		grants: input.grants.map((grant) => {
			const sealedKey = sealer.sealNodeKeyTo(newKey, grant.keys, node.id);
			return {
				grantee_id: grant.granteeId,
				sealed_key: encodeBase64(sealedKey),
				signature: encodeBase64(
					sealer.signGrant(
						{
							nodeId: node.id,
							granterId: input.granterId,
							granteeId: grant.granteeId,
							role: grant.role,
							generation: nextGeneration,
							sealedKey
						},
						keys
					)
				)
			};
		}),
		links: input.links.map((link) => ({
			id: link.id,
			sealed_key: encodeBase64(sealer.sealLinkNodeKey(newKey, link.linkKey, link.id, node.id))
		}))
	};
}

/**
 * A child's own key under the new key, and the tag of its name. A child that does not
 * open cannot be tagged by its name, and nobody can read that name either: it keeps
 * its wrap, and a random tag that cannot collide with anything.
 */
function rewrap(
	child: ChildToRewrap,
	oldKey: Uint8Array,
	newKey: Uint8Array,
	parentId: string,
	sealer: Sealer
): { id: string; wrapped_key: string; name_tag: string } {
	let key: Bytes;
	try {
		key = sealer.unwrapNodeKey(child.wrappedKey, oldKey, parentId, child.id);
	} catch {
		return {
			id: child.id,
			wrapped_key: encodeBase64(child.wrappedKey),
			name_tag: encodeBase64(randomBytes(32))
		};
	}
	try {
		let tag: Bytes;
		try {
			const { name } = parseMetadata(sealer.openMetadata(key, child.id, child.sealedMetadata));
			tag = sealer.nameTag(newKey, name);
		} catch {
			tag = randomBytes(32);
		}
		return {
			id: child.id,
			wrapped_key: encodeBase64(sealer.wrapNodeKey(key, newKey, parentId, child.id)),
			name_tag: encodeBase64(tag)
		};
	} finally {
		zero(key);
	}
}

const ATTEMPTS = 5;

interface Reads {
	trash: Node[] | null;
	links: Link[] | null;
}

async function allPages<T>(
	read: (cursor: string | undefined) => Promise<{ items: T[]; next?: string }>
): Promise<T[]> {
	const out: T[] = [];
	let cursor: string | undefined;
	do {
		const { items, next } = await read(cursor);
		out.push(...items);
		cursor = next;
	} while (cursor !== undefined);
	return out;
}

/** Every direct child, in the trash too, which a rotation has to name. */
async function childrenOf(id: string, reads: Reads, deps: RotationDeps): Promise<Node[]> {
	const { api } = deps;
	const live = await allPages(async (cursor) => {
		const page = await api.listChildren(id, { cursor });
		return { items: page.nodes, next: page.next_cursor };
	});
	reads.trash ??= await allPages(async (cursor) => {
		const page = await api.listTrash({ cursor });
		return { items: page.nodes, next: page.next_cursor };
	});
	return [...live, ...reads.trash.filter((node) => node.parent_id === id)];
}

async function liveLinks(id: string, reads: Reads, deps: RotationDeps): Promise<Link[]> {
	reads.links ??= await allPages(async (cursor) => {
		const page = await deps.api.listLinks({ cursor });
		return { items: page.items.map((item) => item.link), next: page.next_cursor };
	});
	const now = deps.now?.() ?? Date.now();
	return reads.links.filter(
		(link) =>
			link.node_id === id &&
			link.revoked_at === undefined &&
			(link.expires_at === undefined || Date.parse(link.expires_at) > now)
	);
}

/**
 * The grants on the node, each checked first: a server could add a row of its own, and
 * this is about to seal a new key to whoever is listed. Only grants this user signed count.
 */
async function directGrants(id: string, deps: RotationDeps) {
	const { sealer, userId } = deps;
	const { access } = await deps.api.listNodeAccess(id);
	const direct = access.filter((entry: NodeAccess) => !entry.inherited);
	const granterId = userId();
	const own = await deps.keysOf(granterId);
	return Promise.all(
		direct.map(async (entry) => {
			if (entry.sealed_key === undefined || entry.signature === undefined) {
				throw new SealError('signature');
			}
			sealer.verifyGrant(
				{
					nodeId: id,
					granterId,
					granteeId: entry.user_id,
					role: entry.role,
					generation: entry.key_generation ?? 1,
					sealedKey: decodeBase64(entry.sealed_key)
				},
				decodeBase64(entry.signature),
				own
			);
			return {
				granteeId: entry.user_id,
				role: entry.role as string,
				keys: await deps.keysOf(entry.user_id)
			};
		})
	);
}

/** Rotates one node, reading all it names again on a conflict. Returns its current key. */
async function rotateOne(
	item: { id: string; parentId: string; parentKey: Bytes; parentGeneration: number },
	job: RotationJob,
	reads: Reads,
	deps: RotationDeps
): Promise<{ key: Bytes; generation: number; node: Node }> {
	const { api, sealer, keys, userId } = deps;
	for (let tried = 1; ; tried++) {
		const record = await api.getNode(item.id);
		const oldKey = sealer.unwrapNodeKey(
			decodeBase64(record.wrapped_key),
			item.parentKey,
			item.parentId,
			item.id
		);
		const generation = record.key_generation ?? 1;
		const noted = job.done[item.id];
		if (noted !== undefined && generation >= noted) {
			return { key: oldKey, generation, node: record };
		}
		const newKey = sealer.newNodeKey();
		const linkKeys: Bytes[] = [];
		try {
			const children = record.kind === 'folder' ? await childrenOf(item.id, reads, deps) : [];
			const links = await liveLinks(item.id, reads, deps);
			const body = buildRotation(
				{
					node: record,
					generation,
					parentId: item.parentId,
					parentGeneration: item.parentGeneration,
					parentKey: item.parentKey,
					oldKey,
					newKey,
					children: children.map((child) => ({
						id: child.id,
						wrappedKey: decodeBase64(child.wrapped_key),
						sealedMetadata: decodeBase64(child.sealed_metadata)
					})),
					grants: await directGrants(item.id, deps),
					links: links.map((link) => {
						const linkKey = sealer.openLinkOwnerCopy(
							decodeBase64(link.owner_sealed_key),
							keys().masterKey,
							link.id
						);
						linkKeys.push(linkKey);
						return { id: link.id, linkKey };
					}),
					granterId: userId()
				},
				sealer,
				keys()
			);
			const rotated = await api.rotateNode(item.id, body);
			const reached = rotated.key_generation ?? generation + 1;
			job.done[item.id] = reached;
			deps.jobs.save(job);
			deps.onRotated?.(rotated, newKey, record.thumb_blob_id !== undefined);
			zero(oldKey);
			return { key: newKey, generation: reached, node: rotated };
		} catch (e) {
			zero(oldKey, newKey);
			if (tried >= ATTEMPTS || !isApiError(e, 'rotate_conflict', 'key_generation_conflict')) {
				throw e;
			}
			reads.trash = null;
			reads.links = null;
		} finally {
			zero(...linkKeys);
		}
	}
}

/**
 * Runs a job to its end, and forgets it. The children come from the server each time,
 * so a child added while this runs is either named in its parent's rotation or makes
 * that a conflict, and a resumed job finds what is there now.
 */
export async function runRotation(
	job: RotationJob,
	deps: RotationDeps,
	onProgress: (progress: RotationProgress) => void = () => {}
): Promise<void> {
	const { api, jobs } = deps;
	deps.jobs.save(job);
	const top = await api.getNode(job.topId).catch((e) => {
		// The share went with its node: nothing is left to protect.
		if (isApiError(e, 'not_found')) return null;
		throw e;
	});
	if (top === null) {
		jobs.remove(job.topId);
		return;
	}
	if (top.parent_id === undefined) throw new Error('a root is not rotated');
	const parent = await api.getNode(top.parent_id);
	const topParentKey = await deps.parentKey(top.parent_id);
	const reads: Reads = { trash: null, links: null };
	const held: Bytes[] = [];
	const queue = [
		{
			id: job.topId,
			parentId: top.parent_id,
			parentKey: topParentKey,
			parentGeneration: parent.key_generation ?? 1
		}
	];
	let done = 0;
	onProgress({ done, total: queue.length });
	try {
		while (queue.length > 0) {
			const item = queue.shift() as (typeof queue)[number];
			const { key, generation, node } = await rotateOne(item, job, reads, deps);
			held.push(key);
			if (node.kind === 'folder') {
				for (const child of await childrenOf(node.id, reads, deps)) {
					queue.push({
						id: child.id,
						parentId: node.id,
						parentKey: key,
						parentGeneration: generation
					});
				}
			}
			done += 1;
			onProgress({ done, total: done + queue.length });
		}
		jobs.remove(job.topId);
	} finally {
		zero(...held);
	}
}
