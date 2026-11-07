/**
 * The drive of one unlocked session: the tree, uploads, downloads, thumbnails and
 * the journal wired together, with everything from outside passed in. `stop` is
 * what a lock comes down to: keys zeroed, workers gone, nothing left in memory.
 */
import type { Api } from '$lib/api/client';
import { SealError } from '$lib/crypto/aead';
import type { PublicKeys } from '$lib/crypto/keys';
import type { Sealer, UserKeys } from '$lib/crypto/sealer';
import { openVersion, readAll, type VerifiedVersion } from './download/reader';
import type { FramePool } from './frame-pool';
import { ChangeFeed, changedNodes, REFRESH_ONE_BY_ONE } from './journal';
import type { NodeOpener } from './node-opener';
import { Limiter } from './retry';
import type { StreamClient } from './stream/client';
import { createThumbnails, type Thumbnails } from './thumbs/service';
import { DriveTree, type DriveNode } from './tree';
import type { EngineDeps } from './upload/engine';
import { UploadQueue, type QueuedFile } from './upload/queue';
import type { ResumeStore } from './upload/resume';
import { inferType } from './kinds';
import { isApiError } from '$lib/api/types';

/** The most a browser with no service worker is asked to hold of one file. */
export const BLOB_LIMIT = 1024 * 1024 * 1024;

const FRAMES_IN_FLIGHT = 8;

export interface DriveDeps {
	api: Api;
	sealer: Sealer;
	keys: () => UserKeys;
	userId: () => string;
	open: NodeOpener;
	pool: FramePool;
	resume: ResumeStore;
	streams: StreamClient;
	/** Starts a download of a stream the service worker serves. */
	saveUrl: (url: string) => void;
	saveBlob: (blob: Blob, name: string) => void;
	thumbnails?: Thumbnails;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface Download {
	/** How it went: through the service worker, or held in memory first. */
	via: 'stream' | 'memory';
}

export class Drive {
	readonly tree: DriveTree;
	readonly queue: UploadQueue;
	readonly thumbs: Thumbnails;
	readonly engine: EngineDeps;
	readonly feed: ChangeFeed;
	readonly #deps: DriveDeps;
	readonly #walk = new AbortController();

	constructor(deps: DriveDeps) {
		this.#deps = deps;
		this.tree = new DriveTree({
			api: deps.api,
			sealer: deps.sealer,
			keys: deps.keys,
			open: deps.open
		});
		this.engine = {
			api: deps.api,
			sealer: deps.sealer,
			keys: deps.keys,
			pool: deps.pool,
			resume: deps.resume,
			limiter: new Limiter(FRAMES_IN_FLIGHT),
			userId: deps.userId,
			sleep: deps.sleep
		};
		this.thumbs =
			deps.thumbnails ?? createThumbnails({ api: deps.api, sealer: deps.sealer, tree: this.tree });
		this.queue = new UploadQueue({
			tree: this.tree,
			engine: this.engine,
			afterCommit: (node, file) => {
				void this.thumbs.make(node, file as QueuedFile & Blob);
			}
		});
		this.feed = new ChangeFeed(deps.api);
	}

	/** Opens the root and shows what is there; the rest of the tree fills in behind. */
	async start(): Promise<void> {
		await this.feed.catchUp();
		await this.tree.start();
		const root = this.tree.rootId as string;
		await this.tree.loadFolder(root);
		void this.tree.walk(this.#walk.signal).catch(() => {});
		void this.#findInterrupted().catch(() => {});
	}

	/** Puts uploads a reload interrupted back on the list. */
	async #findInterrupted(): Promise<void> {
		const { api, resume, userId } = this.#deps;
		for (const record of await resume.list(userId())) {
			try {
				await api.getUpload(record.uploadId);
				const node = await this.tree.resolve(record.nodeId);
				this.queue.addPaused(record, node.name);
			} catch (e) {
				if (isApiError(e, 'not_found')) await resume.remove(record.uploadId);
			}
		}
	}

	/** Everything a signed manifest needs to be believed. Until sharing, only the owner writes. */
	authorKeys = async (authorId: string): Promise<PublicKeys> => {
		if (authorId !== this.#deps.userId()) throw new SealError('signature');
		const { identity } = this.#deps.keys();
		return { x25519: identity.x25519.publicKey, ed25519: identity.ed25519.publicKey };
	};

	#reader() {
		return { api: this.#deps.api, sealer: this.#deps.sealer, authorKeys: this.authorKeys };
	}

	/** A version checked and ready to read. */
	openVersion(node: Pick<DriveNode, 'id' | 'currentVersion'>, versionId?: string) {
		const id = versionId ?? node.currentVersion;
		if (id === null) throw new Error('that file has no content yet');
		return openVersion(node.id, id, this.#reader());
	}

	/** Reads a whole version into memory, in the frame workers. */
	async readBlob(
		node: Pick<DriveNode, 'id'>,
		version: VerifiedVersion,
		options: {
			limit?: number;
			type?: string;
			onProgress?: (done: number, total: number) => void;
		} = {}
	): Promise<Blob> {
		const { sealer, pool, api } = this.#deps;
		const key = await this.tree.nodeKey(node.id);
		const session = pool.session(sealer.versionKey(key, version.ref), version.ref);
		try {
			return await readAll(version, session, { api, sealer }, options);
		} finally {
			session.close();
		}
	}

	/** Saves a version: streamed where a service worker can, otherwise through memory. */
	async download(
		node: Pick<DriveNode, 'id' | 'name' | 'currentVersion'>,
		versionId?: string,
		onProgress?: (done: number, total: number) => void
	): Promise<Download> {
		const { streams, saveUrl, saveBlob } = this.#deps;
		const version = await this.openVersion(node, versionId);
		const nodeKey = await this.tree.nodeKey(node.id);
		const url = await streams.open({ version, nodeKey, filename: node.name, mime: null });
		if (url !== null) {
			saveUrl(url);
			return { via: 'stream' };
		}
		const blob = await this.readBlob(node, version, { limit: BLOB_LIMIT, onProgress });
		saveBlob(blob, node.name);
		return { via: 'memory' };
	}

	/** A URL to play a version from, and how to let go of it. Media only streams or loads whole. */
	async mediaUrl(
		node: Pick<DriveNode, 'id' | 'name' | 'type' | 'currentVersion'>,
		version: VerifiedVersion
	): Promise<{ url: string; release: () => void }> {
		const { streams } = this.#deps;
		const nodeKey = await this.tree.nodeKey(node.id);
		const mime = inferType(node.name, node.type);
		const url = await streams.open({ version, nodeKey, filename: node.name, mime });
		if (url !== null) return { url, release: () => streams.release(url) };
		const blob = await this.readBlob(node, version, { limit: BLOB_LIMIT, type: mime });
		const objectUrl = URL.createObjectURL(blob);
		return { url: objectUrl, release: () => URL.revokeObjectURL(objectUrl) };
	}

	/** Reads the journal and brings what changed up to date. Returns whether anything did. */
	async poll(): Promise<boolean> {
		const ids = changedNodes(await this.feed.next());
		if (ids.length === 0) return false;
		if (ids.length > REFRESH_ONE_BY_ONE) {
			await this.tree.start();
			await this.tree.loadFolder(this.tree.rootId as string, true);
			void this.tree.walk(this.#walk.signal).catch(() => {});
			return true;
		}
		for (const id of ids) {
			await this.tree.refresh(id);
			const node = this.tree.nodes.get(id);
			// A folder that came back from the trash or moved here: its contents are read again.
			if (node?.kind === 'folder' && !this.tree.isLoaded(id)) {
				await this.tree.loadFolder(id).catch(() => {});
			}
		}
		return true;
	}

	/** A lock: keys zeroed, workers ended, uploads stopped where they can resume from. */
	stop(): void {
		this.#walk.abort();
		this.queue.stop();
		this.#deps.streams.stop();
		this.#deps.pool.stop();
		this.thumbs.clear();
		this.tree.stop();
	}
}
