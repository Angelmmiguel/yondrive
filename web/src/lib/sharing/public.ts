/**
 * Reading under a public link, with no account: the link's state, its password and
 * what its key opens. Everything is held in memory and goes with `stop`. The token
 * goes in a header, is renewed before it ends and is never written anywhere. The key
 * from the URL never leaves here, and nothing here says who owns what it shows.
 */
import type { Api } from '$lib/api/client';
import { ApiError, isApiError, type PublicLink, type PublicNode } from '$lib/api/types';
import { decodeBase64, encodeBase64, type Bytes } from '$lib/crypto/encoding';
import { parseKdfParams, type KdfParams } from '$lib/crypto/kdf';
import { zero } from '$lib/crypto/random';
import type { Sealer } from '$lib/crypto/sealer';
import { readAll, verifyPublicVersion, type VerifiedVersion } from '$lib/drive/download/reader';
import type { FramePool } from '$lib/drive/frame-pool';
import { parseMetadata, type NodeMetadata } from '$lib/drive/metadata';
import { openNodes } from '$lib/drive/open-nodes';

/** Why a link does not open, or no longer does. */
export type LinkEnding = 'expired' | 'revoked' | 'limit' | 'gone' | 'no-key' | 'bad-key';

export type LinkState =
	{ kind: 'password' } | { kind: 'open'; node: LinkNode } | { kind: 'ended'; why: LinkEnding };

export interface LinkNode extends NodeMetadata {
	id: string;
	parentId: string | null;
	kind: 'file' | 'folder';
	currentVersion: string | null;
	thumbBlobId: string | null;
	readable: boolean;
}

export interface PublicDeps {
	api: Pick<
		Api,
		| 'getPublicLink'
		| 'unlockPublicLink'
		| 'getPublicNode'
		| 'listPublicChildren'
		| 'getPublicVersion'
		| 'getPublicBlob'
	>;
	sealer: Sealer;
	pool: FramePool;
	/** Argon2id over the password; slow, so in a worker in the app. */
	deriveRoot: (password: string, params: KdfParams) => Promise<Bytes>;
	/** Told when a link that was open ends. */
	onended?: (why: LinkEnding) => void;
	now?: () => number;
	/** Timers, for a test to drive. */
	schedule?: (run: () => void, ms: number) => () => void;
}

const ENDINGS: Record<string, LinkEnding> = {
	link_expired: 'expired',
	link_revoked: 'revoked',
	link_limit_reached: 'limit',
	not_found: 'gone',
	invalid_id: 'gone'
};

/** How early a token is renewed. */
const RENEW_MARGIN_MS = 60_000;
const MIN_RENEW_MS = 1_000;

/** Why an unlock was refused, for the screen to say and ask again. */
export class WrongLinkPasswordError extends Error {
	constructor() {
		super('wrong password');
		this.name = 'WrongLinkPasswordError';
	}
}

export class PublicLinkSession {
	readonly #deps: PublicDeps;
	readonly #id: string;
	/** From the fragment, or the password. Empty until there is one, and in suite `none`. */
	#linkKey: Bytes;
	#kdf: KdfParams | null = null;
	#token = '';
	#cancelRenew: (() => void) | null = null;
	#stopped = false;
	readonly #keys = new Map<string, Bytes>();
	readonly nodes = new Map<string, LinkNode>();
	rootId: string | null = null;
	downloadsRemaining: number | null = null;
	expiresAt: number | null = null;

	/** Takes over `linkKey`, which has been read out of the URL. */
	constructor(id: string, linkKey: Bytes, deps: PublicDeps) {
		this.#id = id;
		this.#linkKey = linkKey;
		this.#deps = deps;
	}

	/** Zeroes every key and stops renewing. */
	stop(): void {
		this.#stopped = true;
		this.#cancelRenew?.();
		this.#cancelRenew = null;
		for (const key of this.#keys.values()) zero(key);
		this.#keys.clear();
		this.nodes.clear();
		zero(this.#linkKey);
		this.#token = '';
		this.#deps.pool.stop();
	}

	#ended(e: unknown): LinkState {
		const code = e instanceof ApiError ? ENDINGS[e.code] : undefined;
		if (code === undefined) throw e;
		return { kind: 'ended', why: code };
	}

	/** What the link is now: asks for the password, opens, or says why not. */
	async open(): Promise<LinkState> {
		try {
			return this.#adopt(await this.#deps.api.getPublicLink(this.#id));
		} catch (e) {
			return this.#ended(e);
		}
	}

	/** Derives from the password, and gets what it opens from the server. */
	async unlock(password: string): Promise<LinkState> {
		const { sealer, api, deriveRoot } = this.#deps;
		if (this.#kdf === null) throw new Error('this link has no password');
		const root = await deriveRoot(password, this.#kdf);
		const { authKey, kek } = sealer.linkPasswordKeys(root);
		zero(root);
		try {
			let document: PublicLink;
			try {
				document = await api.unlockPublicLink(this.#id, { auth_key: encodeBase64(authKey) });
			} catch (e) {
				if (isApiError(e, 'link_password_invalid')) throw new WrongLinkPasswordError();
				return this.#ended(e);
			}
			if (document.state !== 'open') return { kind: 'ended', why: 'bad-key' };
			try {
				const wrapped = document.password_wrapped_key;
				zero(this.#linkKey);
				this.#linkKey = sealer.unwrapLinkKey(
					wrapped === undefined ? (new Uint8Array(0) as Bytes) : decodeBase64(wrapped),
					kek,
					this.#id
				);
			} catch {
				return { kind: 'ended', why: 'bad-key' };
			}
			return this.#adopt(document);
		} finally {
			zero(authKey, kek);
		}
	}

	#adopt(document: PublicLink): LinkState {
		if (document.state === 'password_required') {
			this.#kdf = parseKdfParams(document.kdf);
			return { kind: 'password' };
		}
		const { node, sealed_key: sealed, token, token_expires_at: until } = document;
		if (node === undefined || token === undefined || until === undefined) {
			return { kind: 'ended', why: 'bad-key' };
		}
		if (node.suite !== this.#deps.sealer.suite) return { kind: 'ended', why: 'bad-key' };
		this.#token = token;
		this.downloadsRemaining = document.downloads_remaining ?? null;
		this.expiresAt = document.expires_at === undefined ? null : Date.parse(document.expires_at);
		this.#scheduleRenewal(Date.parse(until));
		let key: Bytes;
		try {
			key = this.#deps.sealer.openLinkNodeKey(
				decodeBase64(sealed ?? ''),
				this.#linkKey,
				this.#id,
				node.id
			);
		} catch {
			return {
				kind: 'ended',
				why: this.#linkKey.length === 0 ? 'no-key' : 'bad-key'
			};
		}
		this.rootId = node.id;
		const previous = this.#keys.get(node.id);
		if (previous !== undefined) zero(previous);
		this.#keys.set(node.id, key);
		const opened = this.#open(node, key);
		return { kind: 'open', node: opened };
	}

	#open(node: PublicNode, key: Uint8Array): LinkNode {
		let metadata: unknown = null;
		let readable = true;
		try {
			metadata = this.#deps.sealer.openMetadata(key, node.id, decodeBase64(node.sealed_metadata));
		} catch {
			readable = false;
		}
		return this.#remember(node, metadata, readable);
	}

	#remember(node: PublicNode, metadata: unknown, readable: boolean): LinkNode {
		const parsed = parseMetadata(metadata);
		const stored: LinkNode = {
			...parsed,
			name: readable ? parsed.name : 'Unreadable item',
			id: node.id,
			parentId: node.parent_id ?? null,
			kind: node.kind,
			currentVersion: node.current_version ?? null,
			thumbBlobId: node.thumb_blob_id ?? null,
			readable
		};
		this.nodes.set(node.id, stored);
		return stored;
	}

	#scheduleRenewal(until: number): void {
		this.#cancelRenew?.();
		if (this.#stopped) return;
		const now = this.#deps.now?.() ?? Date.now();
		const wait = Math.max(until - now - RENEW_MARGIN_MS, MIN_RENEW_MS);
		const schedule =
			this.#deps.schedule ??
			((run, ms) => {
				const timer = setTimeout(run, ms);
				return () => clearTimeout(timer);
			});
		this.#cancelRenew = schedule(() => void this.renew(), wait);
	}

	/** Gets a new token within the session, which also shows if the link has ended since. */
	async renew(): Promise<void> {
		if (this.#stopped) return;
		try {
			const state = this.#adopt(await this.#deps.api.getPublicLink(this.#id, this.#token));
			if (state.kind === 'ended') this.#deps.onended?.(state.why);
			if (state.kind === 'password') this.#deps.onended?.('gone');
		} catch (e) {
			if (isApiError(e, 'network', 'rate_limited', 'internal')) {
				// Try again soon: the token has a minute left.
				this.#scheduleRenewal(Date.now() + RENEW_MARGIN_MS + MIN_RENEW_MS * 10);
				return;
			}
			const ended = this.#ended(e);
			if (ended.kind === 'ended') this.#deps.onended?.(ended.why);
		}
	}

	/** Calls a read, seeing an ending through to whoever is drawing this. */
	async #read<T>(attempt: () => Promise<T>): Promise<T> {
		try {
			return await attempt();
		} catch (e) {
			if (isApiError(e, 'link_token_invalid', 'link_token_required')) {
				await this.renew();
				return attempt();
			}
			if (isApiError(e, 'link_expired', 'link_revoked', 'link_limit_reached')) {
				const ended = this.#ended(e);
				if (ended.kind === 'ended') this.#deps.onended?.(ended.why);
			}
			throw e;
		}
	}

	/** A folder's children, opened, with what will not open showing as unreadable. */
	async children(folderId: string): Promise<LinkNode[]> {
		const { api, sealer } = this.#deps;
		const parentKey = this.#keys.get(folderId);
		if (parentKey === undefined) throw new Error('that folder is not open');
		const out: LinkNode[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.#read(() =>
				api.listPublicChildren(this.#id, folderId, this.#token, { cursor, limit: 500 })
			);
			const opened = openNodes(sealer, parentKey, folderId, page.nodes);
			const byId = new Map(opened.map((one) => [one.id, one]));
			for (const node of page.nodes) {
				const one = byId.get(node.id);
				if (one?.key) {
					const held = this.#keys.get(node.id);
					if (held !== undefined) zero(held);
					this.#keys.set(node.id, one.key);
				}
				const stored = this.#remember(node, one?.metadata ?? null, one?.metadata != null);
				if (stored.kind === 'folder' || stored.currentVersion !== null) out.push(stored);
			}
			cursor = page.next_cursor;
		} while (cursor !== undefined);
		return out;
	}

	/** The current version of a file, checked: a link shows no history. */
	async version(nodeId: string): Promise<VerifiedVersion> {
		const { api, sealer } = this.#deps;
		const version = await this.#read(() => api.getPublicVersion(this.#id, nodeId, this.#token));
		return verifyPublicVersion(version, nodeId, sealer);
	}

	/** The key of a version: older ones go down their chain from the current key. */
	#keyOf(nodeId: string, version: VerifiedVersion): Bytes {
		const { sealer } = this.#deps;
		const current = this.#keys.get(nodeId);
		if (current === undefined) throw new Error('that node is not open');
		let key = current;
		const made: Bytes[] = [];
		for (const link of version.keyChain) {
			key = sealer.openPreviousKey(decodeBase64(link.sealed_key), key, nodeId, link.generation);
			made.push(key);
		}
		const out = key.slice() as Bytes;
		zero(...made);
		return out;
	}

	/** Reads a whole version, with the frames opened in workers. This is what counts as a download. */
	async read(
		nodeId: string,
		version: VerifiedVersion,
		options: {
			limit?: number;
			type?: string;
			onProgress?: (done: number, total: number) => void;
		} = {}
	): Promise<Blob> {
		const { sealer, pool, api } = this.#deps;
		const key = this.#keyOf(nodeId, version);
		const session = pool.session(sealer.versionKey(key, version.ref), version.ref);
		zero(key);
		const getBlob = (
			blobId: string,
			range?: { start: number; end: number },
			signal?: AbortSignal
		) => this.#read(() => api.getPublicBlob(this.#id, blobId, this.#token, range, signal));
		try {
			return await readAll(version, session, { api: { getBlob }, sealer }, options);
		} finally {
			session.close();
		}
	}

	/** A thumbnail's image, which does not count as a download. One that will not open is missing. */
	async thumbnail(node: Pick<LinkNode, 'id' | 'thumbBlobId'>): Promise<Blob | null> {
		const { api, sealer } = this.#deps;
		const key = this.#keys.get(node.id);
		if (node.thumbBlobId === null || key === undefined) return null;
		try {
			const stored = await this.#read(() =>
				api.getPublicBlob(this.#id, node.thumbBlobId as string, this.#token)
			);
			const image = sealer.openThumbnail(key, node.id, node.thumbBlobId, stored);
			return new Blob([image], { type: 'image/webp' });
		} catch {
			return null;
		}
	}
}
