/**
 * The drive of one unlocked session: the tree, uploads, downloads, thumbnails and
 * the journal wired together, with everything from outside passed in. `stop` is
 * what a lock comes down to: keys zeroed, workers gone, nothing left in memory.
 */
import type { Api } from '$lib/api/client';
import type { Bytes } from '$lib/crypto/encoding';
import { deriveRootInWorker } from '$lib/crypto/kdf-client';
import type { KdfParams } from '$lib/crypto/kdf';
import type { Sealer, UserKeys } from '$lib/crypto/sealer';
import { Contacts, memoryPinStorage, type PinStorage } from '$lib/sharing/contacts';
import {
	memoryRotationJobs,
	type RotationJobs,
	type RotationProgress
} from '$lib/sharing/rotation';
import { Sharing, UntrustedGrantError } from '$lib/sharing/sharing';
import { openVersion, readAll, type VerifiedVersion } from './download/reader';
import type { FramePool } from './frame-pool';
import {
	ChangeFeed,
	changedNodes,
	JournalExpiredError,
	nodesChangedBy,
	REFRESH_ONE_BY_ONE,
	revokedNotRotated
} from './journal';
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
	/** Told of a version just committed, with its bytes in hand: for its text. */
	onCommitted?: (node: DriveNode, blob: Blob) => void;
	/** Where this device keeps the pins of contacts, and rotations still to finish. */
	pins?: PinStorage;
	rotationJobs?: RotationJobs;
	deriveLinkRoot?: (password: string, params: KdfParams) => Promise<Bytes>;
	/** The parameters of a new link's password, instead of the production cost. */
	linkKdf?: () => KdfParams;
	/** Where a link's address starts, instead of this page's origin. */
	origin?: () => string;
	/** Told when a rotation a previous session left goes on, and as it moves. */
	onResumeRotation?: (progress: RotationProgress | null) => void;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The largest file a thumbnail is made again from, after a rotation took the old one. */
const REMAKE_LIMIT = 128 * 1024 * 1024;

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
	readonly sharing: Sharing;
	readonly #deps: DriveDeps;
	readonly #walk = new AbortController();

	constructor(deps: DriveDeps) {
		this.#deps = deps;
		const contacts = new Contacts({
			api: deps.api,
			sealer: deps.sealer,
			keys: deps.keys,
			userId: deps.userId,
			storage: deps.pins ?? memoryPinStorage()
		});
		this.sharing = new Sharing({
			api: deps.api,
			sealer: deps.sealer,
			keys: deps.keys,
			userId: deps.userId,
			contacts,
			jobs: deps.rotationJobs ?? memoryRotationJobs(),
			tree: () => this.tree,
			deriveRoot:
				deps.deriveLinkRoot ?? ((password, params) => deriveRootInWorker(password, params, true)),
			newKdfParams: deps.linkKdf,
			origin: deps.origin,
			onRotated: (node, hadThumbnail) => {
				if (hadThumbnail && node.trashed_at === undefined) void this.#remakeThumbnail(node.id);
			}
		});
		this.tree = new DriveTree({
			api: deps.api,
			sealer: deps.sealer,
			keys: deps.keys,
			open: deps.open,
			grantKey: this.sharing.grantKey
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
				deps.onCommitted?.(node, file as QueuedFile & Blob);
			}
		});
		this.feed = new ChangeFeed(deps.api);
	}

	/** Opens the root and shows what is there; the rest of the tree fills in behind. */
	async start(): Promise<void> {
		const past = await this.feed.catchUp();
		await this.tree.start();
		const root = this.tree.rootId as string;
		await this.tree.loadFolder(root);
		void this.tree.walk(this.#walk.signal).catch(() => {});
		void this.#findInterrupted().catch(() => {});
		await this.sharing.refreshShared().catch(() => {});
		await this.sharing.refreshMade().catch(() => {});
		// Also what was revoked while away, as nobody else is going to replace those keys.
		void this.sharing.queueRotations(revokedNotRotated(past)).then(() => this.#resumeRotations());
	}

	/** Goes on with rotations a previous session left, since a revoked user may hold those keys. */
	async #resumeRotations(): Promise<void> {
		const { onResumeRotation } = this.#deps;
		if (this.sharing.pendingRotations.length === 0) return;
		try {
			await this.sharing.resumeRotations((progress) => onResumeRotation?.(progress));
		} catch {
			// Still written down: it goes on at the next unlock.
		} finally {
			onResumeRotation?.(null);
		}
	}

	async #remakeThumbnail(id: string): Promise<void> {
		try {
			const node = await this.tree.resolve(id);
			if (node.currentVersion === null || node.size > REMAKE_LIMIT) return;
			await this.thumbs.remake(node, async () =>
				this.readBlob(node, await this.openVersion(node), { limit: REMAKE_LIMIT })
			);
		} catch {
			// The icon shows instead.
		}
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

	#reader() {
		return {
			api: this.#deps.api,
			sealer: this.#deps.sealer,
			authorKeys: this.sharing.authorKeys
		};
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
		const key = await this.tree.keyAt(node.id, version.keyGeneration, version.keyChain);
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
		const nodeKey = await this.tree.keyAt(node.id, version.keyGeneration, version.keyChain);
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
		const nodeKey = await this.tree.keyAt(node.id, version.keyGeneration, version.keyChain);
		const mime = inferType(node.name, node.type);
		const url = await streams.open({ version, nodeKey, filename: node.name, mime });
		if (url !== null) return { url, release: () => streams.release(url) };
		const blob = await this.readBlob(node, version, { limit: BLOB_LIMIT, type: mime });
		const objectUrl = URL.createObjectURL(blob);
		return { url: objectUrl, release: () => URL.revokeObjectURL(objectUrl) };
	}

	/** Reads the journal and brings what changed up to date. Returns whether anything did. */
	async poll(): Promise<boolean> {
		let changes;
		try {
			changes = await this.feed.next();
		} catch (e) {
			if (!(e instanceof JournalExpiredError)) throw e;
			await this.#readEverything();
			return true;
		}
		const ids = changedNodes(changes);
		if (ids.length === 0) return false;
		const sharingChanged = nodesChangedBy(changes, 'granted', 'role_changed', 'revoked', 'rotated');
		if (sharingChanged.length > 0) {
			this.sharing.contacts.refresh();
			await this.sharing.refreshShared().catch(() => {});
			await this.sharing.refreshMade().catch(() => {});
			// Someone holding a share may have kept its keys, whoever ended it.
			void this.sharing.queueRotations(revokedNotRotated(changes)).then((queued) => {
				if (queued) void this.#resumeRotations();
			});
		}
		if (ids.length > REFRESH_ONE_BY_ONE) {
			await this.#readEverything();
			return true;
		}
		const rotated = new Set(nodesChangedBy(changes, 'rotated'));
		for (const id of ids) {
			// Refreshing answers a lost way of reaching a node too: a 404 forgets it and all under it.
			await this.tree.refresh(id).catch((e) => {
				if (!(e instanceof UntrustedGrantError)) throw e;
				this.tree.drop(id);
			});
			const node = this.tree.nodes.get(id);
			// A folder that came back from the trash or moved here: its contents are read again.
			// A rotated one holds its children's wraps and tags under the new key.
			if (node?.kind === 'folder' && (rotated.has(id) || !this.tree.isLoaded(id))) {
				await this.tree.loadFolder(id, rotated.has(id)).catch(() => {});
			}
		}
		return true;
	}

	/** Everything this user can reach, as the server has it now. */
	async #readEverything(): Promise<void> {
		this.sharing.contacts.refresh();
		await this.sharing.refreshShared().catch(() => {});
		this.tree.invalidate();
		await this.tree.start();
		await this.tree.loadFolder(this.tree.rootId as string, true);
		void this.walkEverything(this.#walk.signal).catch(() => {});
	}

	/** Reads every folder of this user's own and of each share that verifies. */
	async walkEverything(signal?: AbortSignal): Promise<void> {
		await this.tree.walk(signal);
		for (const id of this.sharedTops()) {
			if (signal?.aborted) return;
			// A share that does not open stays out of what is known here.
			await this.tree.resolve(id).catch(() => {});
			if (this.tree.nodes.has(id)) await this.tree.walk(signal, id).catch(() => {});
		}
	}

	/** The top of each share whose grant verifies: the only shares anything here opens. */
	sharedTops(): string[] {
		return this.sharing.shared
			.filter((entry) => entry.trust === 'verified')
			.map((entry) => entry.node.id);
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
