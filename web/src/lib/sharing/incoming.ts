/**
 * What arrives through the owner's file requests, and putting it in its folder. An
 * item's node key is sealed to its request: opening it takes the request's private
 * key, which only the owner's master key opens, bound to the request's public key and
 * its folder, so that a server that swapped any of them is refused. Adopting wraps the key under the
 * folder, names the file there and signs its manifest as the owner. The frames are
 * not touched. What came in is untrusted, as anything from someone else is: its name
 * is cleaned, and what the sender said is kept as text, cut to size.
 */
import type { Api } from '$lib/api/client';
import { isApiError, type IncomingItem, type Node } from '$lib/api/types';
import { contentHashOf, frameCountFor } from '$lib/crypto/content';
import { decodeBase64, encodeBase64, type Bytes } from '$lib/crypto/encoding';
import { encodeManifest } from '$lib/crypto/manifest';
import { zero } from '$lib/crypto/random';
import type { Sealer, UserKeys } from '$lib/crypto/sealer';
import type { DriveTree } from '$lib/drive/tree';
import { inferType } from '$lib/drive/kinds';
import { rawMetadata } from '$lib/drive/metadata';
import { cleanName } from '$lib/drive/names';
import { numbered } from '$lib/editing/save';
import { MAX_FROM, MAX_MESSAGE } from './request';

/** An item whose key or metadata does not open: damaged, or not sealed to this request. */
export class UnreadableIncomingError extends Error {
	constructor() {
		super('this item does not open');
		this.name = 'UnreadableIncomingError';
	}
}

export interface IncomingDeps {
	api: Pick<Api, 'listIncoming' | 'adoptIncoming' | 'deleteIncoming'>;
	sealer: Sealer;
	keys: () => UserKeys;
	tree: Pick<DriveTree, 'nodeKey' | 'generationOf' | 'refresh' | 'resolve'>;
	now?: () => number;
}

/** How many names a clash may try before it gives up. */
const NAMES = 50;

/** Everything that waits to be adopted. */
export async function listIncoming(deps: Pick<IncomingDeps, 'api'>): Promise<IncomingItem[]> {
	const out: IncomingItem[] = [];
	let cursor: string | undefined;
	do {
		const page = await deps.api.listIncoming({ cursor });
		out.push(...page.items);
		cursor = page.next_cursor;
	} while (cursor !== undefined);
	return out;
}

const text = (value: unknown, max: number): string | undefined =>
	typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined;

/** A media type as a sender gave it, or none, so that the name's extension decides. */
function mediaTypeOf(value: unknown): string {
	return typeof value === 'string' && value.length <= 255 && /^[\w.+-]+\/[\w.+-]+$/.test(value)
		? value
		: '';
}

/** The metadata the owner keeps of an item, from what its sender sealed. */
export function adoptedMetadata(item: IncomingItem, opened: unknown, now: number) {
	const raw = rawMetadata(opened);
	let name: string;
	try {
		name = cleanName(typeof raw.name === 'string' ? raw.name : '');
	} catch {
		name = 'Untitled file';
	}
	const said = rawMetadata(raw.request);
	const modified =
		typeof raw.modified === 'number' && Number.isFinite(raw.modified) ? raw.modified : now;
	const received = Date.parse(item.created_at);
	return {
		name,
		type: inferType(name, mediaTypeOf(raw.type)),
		created: now,
		modified,
		size: item.size,
		tags: [],
		favorite: false,
		request: {
			link: item.link_id,
			received: Number.isFinite(received) ? received : undefined,
			from: text(said.from, MAX_FROM),
			message: text(said.message, MAX_MESSAGE)
		}
	};
}

/** Opens an item's node key, or `UnreadableIncomingError`. */
function openItem(item: IncomingItem, sealer: Sealer, keys: UserKeys): Bytes {
	const publicKey = decodeBase64(item.public_key);
	let privateKey: Bytes | null = null;
	try {
		privateKey = sealer.openRequestPrivateKey(
			decodeBase64(item.sealed_private_key),
			keys.masterKey,
			item.link_id,
			publicKey,
			item.folder_id
		);
		return sealer.openNodeKeyFromRequest(
			decodeBase64(item.sealed_key),
			{ privateKey, publicKey },
			item.link_id,
			item.id
		);
	} catch {
		throw new UnreadableIncomingError();
	} finally {
		if (privateKey !== null) zero(privateKey);
	}
}

/** Puts an item in its request's folder, under a free name, and returns its node. */
export async function adoptIncoming(item: IncomingItem, deps: IncomingDeps): Promise<Node> {
	const { api, sealer, tree } = deps;
	if (
		item.suite !== sealer.suite ||
		frameCountFor(item.size, item.frame_size) !== item.frame_count
	) {
		throw new UnreadableIncomingError();
	}
	// The folder is the server's word too: only one of the owner's own will take the file.
	const folder = await tree.resolve(item.folder_id).catch(() => null);
	if (folder === null || folder.kind !== 'folder' || folder.role !== 'owner') {
		throw new UnreadableIncomingError();
	}
	const keys = deps.keys();
	const nodeKey = openItem(item, sealer, keys);
	try {
		let opened: unknown;
		try {
			opened = sealer.openMetadata(nodeKey, item.id, decodeBase64(item.sealed_metadata));
		} catch {
			throw new UnreadableIncomingError();
		}
		const metadata = adoptedMetadata(item, opened, deps.now?.() ?? Date.now());
		const manifest = {
			nodeId: item.id,
			versionId: item.version_id,
			suite: sealer.suite,
			size: item.size,
			frameSize: item.frame_size,
			frameCount: item.frame_count,
			contentHash: contentHashOf(decodeBase64(item.frame_hashes))
		};
		const signature = encodeBase64(sealer.signVersion(manifest, keys));
		const encodedManifest = encodeBase64(encodeManifest(manifest));
		let refreshed = false;
		for (let n = 1; ; n++) {
			const name = n === 1 ? metadata.name : numbered(metadata.name, n);
			const folderKey = await tree.nodeKey(item.folder_id);
			try {
				return await api.adoptIncoming(item.id, {
					parent_key_generation: tree.generationOf(item.folder_id) ?? 1,
					wrapped_key: encodeBase64(
						sealer.wrapNodeKey(nodeKey, folderKey, item.folder_id, item.id)
					),
					name_tag: encodeBase64(sealer.nameTag(folderKey, name)),
					sealed_metadata: encodeBase64(
						sealer.sealMetadata(nodeKey, item.id, { ...metadata, name })
					),
					signature,
					manifest: encodedManifest
				});
			} catch (e) {
				if (isApiError(e, 'name_conflict') && n < NAMES) continue;
				if (isApiError(e, 'key_generation_conflict') && !refreshed) {
					refreshed = true;
					await tree.refresh(item.folder_id);
					n -= 1;
					continue;
				}
				throw e;
			}
		}
	} finally {
		zero(nodeKey);
	}
}
