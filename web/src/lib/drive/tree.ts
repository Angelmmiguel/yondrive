/**
 * The tree as this device knows it: which nodes exist, their opened metadata and
 * their keys. Everything goes through the `Sealer`, so the code is the same in
 * both modes: in `none` the keys are empty strings that flow through untouched.
 * Keys live in memory only and `stop` zeroes them.
 */
import type { Api } from '$lib/api/client';
import { isApiError, type KeyLink, type Node, type NodeRole } from '$lib/api/types';
import { SealError } from '$lib/crypto/aead';
import { encodeBase64, decodeBase64, type Bytes } from '$lib/crypto/encoding';
import { normalizeName } from '$lib/crypto/metadata';
import { constantTimeEqual, zero } from '$lib/crypto/random';
import type { Sealer, Suite, UserKeys } from '$lib/crypto/sealer';
import { newId } from './ids';
import {
	nextTone,
	parseMetadata,
	parseRootMetadata,
	rawMetadata,
	type NodeMetadata,
	type RawMetadata,
	type TagDefinition
} from './metadata';
import { cleanName } from './names';
import type { NodeOpener } from './node-opener';
import type { OpenedNode } from './open-nodes';

const PAGE = 500;

export interface DriveNode extends NodeMetadata {
	id: string;
	ownerId: string;
	/** Null on a root, and on the top of a share, whose folder is not this user's to see. */
	parentId: string | null;
	/** What this user may do with it; only the server can really say. */
	role: NodeRole;
	/** The generation of its key on the server, when it was last read. */
	keyGeneration: number;
	kind: 'file' | 'folder';
	currentVersion: string | null;
	thumbBlobId: string | null;
	trashedAt: number | null;
	purgedAt: number | null;
	removeAt: number | null;
	updatedAt: number;
	/** False when its metadata could not be opened: damaged, or tampered with. */
	readable: boolean;
	/** The opened value, with what this client does not know, for rewriting it. */
	raw: RawMetadata;
}

export interface TreeDeps {
	api: Pick<
		Api,
		| 'getRootNode'
		| 'createRootNode'
		| 'createNode'
		| 'getNode'
		| 'updateNode'
		| 'listChildren'
		| 'moveNode'
		| 'trashNode'
		| 'restoreNode'
		| 'purgeNode'
		| 'listTrash'
		| 'emptyTrash'
	>;
	sealer: Sealer;
	/** The keys, or `LockedError`. */
	keys: () => UserKeys;
	open: NodeOpener;
	/**
	 * The key of a share's top node, from a grant that has been verified, or a refusal.
	 * Its parent is not visible, so this is the only way in. Taken over by the tree.
	 */
	grantKey?: (node: Node) => Promise<Bytes>;
	now?: () => number;
}

const time = (value: string | undefined): number | null =>
	value === undefined ? null : Date.parse(value);

export class DriveTree {
	readonly nodes = new Map<string, DriveNode>();
	rootId: string | null = null;
	tags: TagDefinition[] = [];
	/** Told after every change, for whoever draws this. */
	onchange: () => void = () => {};

	readonly #deps: TreeDeps;
	readonly #keys = new Map<string, Bytes>();
	/** Which generation each key in `#keys` is, which is what a write seals under. */
	readonly #generations = new Map<string, number>();
	/** Keys replaced by a rotation or gone with a node, which someone may still be holding. */
	readonly #retired: Bytes[] = [];
	/** Older keys reached through a version's chain, by node and generation. */
	readonly #older = new Map<string, Bytes>();
	readonly #rereading = new Set<string>();
	readonly #children = new Map<string, Set<string>>();
	readonly #loaded = new Set<string>();
	readonly #loading = new Map<string, Promise<void>>();
	/**
	 * While a folder is being read, when each node was last written or forgotten here, on
	 * `#clock`. A listing asked for before then is older than what is known, and must not
	 * hide a file that has just committed, bring back an old name, or drop a new child.
	 */
	readonly #written = new Map<string, number>();
	#clock = 0;
	#rootRaw: RawMetadata = {};
	#stopped = false;

	constructor(deps: TreeDeps) {
		this.#deps = deps;
	}

	get #suite(): Suite {
		return this.#deps.sealer.suite;
	}

	#now(): number {
		return this.#deps.now?.() ?? Date.now();
	}

	/** Zeroes every key and forgets the tree. Work still in flight then fails. */
	stop(): void {
		this.#stopped = true;
		for (const key of this.#keys.values()) zero(key);
		for (const key of this.#older.values()) zero(key);
		zero(...this.#retired);
		this.#keys.clear();
		this.#older.clear();
		this.#generations.clear();
		this.#retired.length = 0;
		this.nodes.clear();
		this.#children.clear();
		this.#loaded.clear();
		this.#loading.clear();
		this.rootId = null;
		this.tags = [];
	}

	/**
	 * Takes over `key`, unless this node already has the same one, which callers may be
	 * holding. A different key at this generation or a later one is what a rotation
	 * looks like from here; an older answer that arrives late changes nothing.
	 */
	#remember(id: string, key: Bytes, generation = 1): Bytes {
		const known = this.#keys.get(id);
		if (known !== undefined) {
			const same = constantTimeEqual(known, key);
			if (same || generation < (this.#generations.get(id) ?? 1)) {
				if (key !== known) zero(key);
				if (same) this.#generations.set(id, generation);
				return known;
			}
			this.#retired.push(known);
		}
		if (this.#stopped) {
			zero(key);
			throw new Error('stopped');
		}
		this.#keys.set(id, key);
		this.#generations.set(id, generation);
		return key;
	}

	/** Which generation of a node's key this device holds. */
	generationOf(id: string): number | undefined {
		return this.#generations.get(id);
	}

	/** The root, made here if this is the first device to ask. */
	async start(): Promise<DriveNode> {
		const { api, sealer, keys } = this.#deps;
		let node: Node;
		try {
			node = await api.getRootNode();
		} catch (e) {
			if (!isApiError(e, 'not_found')) throw e;
			const id = newId();
			const key = sealer.newNodeKey();
			try {
				const wrapped = sealer.wrapRootNodeKey(key, keys().masterKey, id);
				const sealed = sealer.sealMetadata(key, id, { tags: [] });
				// Another device may win the race, so what counts is the node that comes back.
				node = await api.createRootNode({
					id,
					suite: this.#suite,
					wrapped_key: encodeBase64(wrapped),
					sealed_metadata: encodeBase64(sealed)
				});
			} finally {
				zero(key);
			}
		}
		this.#adoptRoot(node);
		this.onchange();
		return this.nodes.get(node.id) as DriveNode;
	}

	#adoptRoot(node: Node): void {
		const { sealer, keys } = this.#deps;
		const key = this.#remember(
			node.id,
			sealer.unwrapRootNodeKey(decodeBase64(node.wrapped_key), keys().masterKey, node.id),
			node.key_generation
		);
		this.rootId = node.id;
		let opened: unknown = null;
		// A brand new root in `none` mode may carry no metadata at all.
		if (node.sealed_metadata !== '') {
			opened = sealer.openMetadata(key, node.id, decodeBase64(node.sealed_metadata));
		}
		this.#rootRaw = rawMetadata(opened);
		this.tags = parseRootMetadata(opened).tags;
		this.#store(node, opened, true);
	}

	/** The top of a share: its key comes from a grant, as its parent is not visible. */
	async #adoptShare(node: Node): Promise<void> {
		const { grantKey, sealer } = this.#deps;
		if (grantKey === undefined) throw new Error('cannot open this node');
		const key = this.#remember(node.id, await grantKey(node), node.key_generation);
		let opened: unknown = null;
		let readable = true;
		try {
			opened = sealer.openMetadata(key, node.id, decodeBase64(node.sealed_metadata));
		} catch {
			readable = false;
		}
		this.#store(node, opened, readable);
	}

	/** Opens a node just read from the server, whichever way its key is reached. */
	async #adopt(node: Node, seen: Set<string> = new Set()): Promise<void> {
		if (node.parent_id !== undefined) {
			await this.resolve(node.parent_id, seen);
			await this.#openPage(node.parent_id, [node]);
		} else if ((node.role ?? 'owner') === 'owner') {
			this.#adoptRoot(node);
		} else {
			await this.#adoptShare(node);
		}
	}

	/** Reads a node and its key again, as when something says the key has moved on. */
	async #reread(id: string): Promise<void> {
		if (this.#rereading.has(id)) return;
		this.#rereading.add(id);
		try {
			const node = await this.#deps.api.getNode(id);
			if (node.parent_id !== undefined) await this.#openPage(node.parent_id, [node]);
			else await this.#adopt(node);
		} finally {
			this.#rereading.delete(id);
		}
	}

	/** Runs something sealed under keys that a rotation may overtake, reading them again if so. */
	async #fresh<T>(ids: readonly string[], attempt: () => Promise<T>): Promise<T> {
		for (let tried = 1; ; tried++) {
			try {
				return await attempt();
			} catch (e) {
				if (tried >= 3 || !isApiError(e, 'key_generation_conflict')) throw e;
				for (const id of ids) await this.#reread(id);
			}
		}
	}

	/** A node changed here: listings in flight are older than it. */
	#wrote(id: string): void {
		if (this.#loading.size > 0) this.#written.set(id, ++this.#clock);
	}

	/** Whether this node was written here after `at` on `#clock`. */
	#writtenAfter(id: string, at: number): boolean {
		return (this.#written.get(id) ?? -1) > at;
	}

	#store(node: Node, metadata: unknown, readable: boolean): DriveNode {
		this.#wrote(node.id);
		const opened = parseMetadata(metadata);
		const parentId = node.parent_id ?? null;
		const trashedAt = time(node.trashed_at);
		const previous = this.nodes.get(node.id);
		if (previous && previous.parentId !== null && previous.parentId !== parentId) {
			this.#children.get(previous.parentId)?.delete(node.id);
		}
		const stored: DriveNode = {
			...opened,
			name: readable ? opened.name : 'Unreadable item',
			id: node.id,
			ownerId: node.owner_id,
			parentId,
			role: node.role ?? 'owner',
			keyGeneration: node.key_generation ?? 1,
			kind: node.kind,
			currentVersion: node.current_version ?? null,
			thumbBlobId: node.thumb_blob_id ?? null,
			trashedAt,
			purgedAt: time(node.purged_at),
			removeAt: time(node.remove_at),
			updatedAt: Date.parse(node.updated_at),
			readable,
			raw: rawMetadata(metadata)
		};
		this.nodes.set(node.id, stored);
		if (parentId !== null) {
			let siblings = this.#children.get(parentId);
			if (siblings === undefined) {
				siblings = new Set();
				this.#children.set(parentId, siblings);
			}
			if (trashedAt === null) siblings.add(node.id);
			else siblings.delete(node.id);
		}
		return stored;
	}

	/** `asked`, for a listing, is when it was asked for: what changed here since stays as it is. */
	async #openPage(parentId: string, records: Node[], asked?: number): Promise<void> {
		if (records.length === 0) return;
		const parentKey = await this.nodeKey(parentId);
		let opened: OpenedNode[] = await this.#deps.open(parentKey, parentId, records);
		if (opened.some((one) => one.key === null)) {
			// A folder rotated since its key was read here wraps its children under the new one.
			await this.#reread(parentId).catch(() => {});
			const current = this.#keys.get(parentId);
			if (current !== undefined && current !== parentKey) {
				for (const one of opened) if (one.key) zero(one.key);
				opened = await this.#deps.open(current, parentId, records);
			}
		}
		const byId = new Map(opened.map((o) => [o.id, o]));
		for (const record of records) {
			const one = byId.get(record.id);
			if (asked !== undefined && this.#writtenAfter(record.id, asked)) {
				if (one?.key) zero(one.key);
				continue;
			}
			if (one?.key) this.#remember(record.id, one.key, record.key_generation);
			this.#store(record, one?.metadata ?? null, one?.metadata != null);
		}
	}

	/** The key of a node, fetching whatever chain up to the root it takes to open it. */
	async nodeKey(id: string): Promise<Bytes> {
		const known = this.#keys.get(id);
		if (known !== undefined) return known;
		const node = await this.resolve(id);
		const key = this.#keys.get(node.id);
		if (key === undefined) throw new Error('cannot open this node');
		return key;
	}

	/** A node, and its ancestors, known here from now on. */
	async resolve(id: string, seen: Set<string> = new Set()): Promise<DriveNode> {
		if (seen.has(id)) throw new Error('the tree has a cycle');
		seen.add(id);
		const known = this.nodes.get(id);
		if (known !== undefined && this.#keys.has(id)) return known;
		const node = await this.#deps.api.getNode(id);
		await this.#adopt(node, seen);
		this.onchange();
		return this.nodes.get(id) as DriveNode;
	}

	/** Whether this folder's list came from the server since it last changed. */
	isLoaded(id: string): boolean {
		return this.#loaded.has(id);
	}

	/** Reads a folder's children, page by page by id. `force` reads it again. */
	loadFolder(id: string, force = false): Promise<void> {
		const running = this.#loading.get(id);
		if (running !== undefined) return running;
		if (!force && this.#loaded.has(id)) return Promise.resolve();
		const load = this.#readFolder(id).finally(() => {
			this.#loading.delete(id);
			if (this.#loading.size === 0) this.#written.clear();
		});
		this.#loading.set(id, load);
		return load;
	}

	async #readFolder(id: string): Promise<void> {
		const present = new Set<string>();
		const started = this.#clock;
		let cursor: string | undefined;
		do {
			const asked = this.#clock;
			const page = await this.#deps.api.listChildren(id, { cursor, limit: PAGE });
			for (const node of page.nodes) present.add(node.id);
			await this.#openPage(id, page.nodes, asked);
			cursor = page.next_cursor;
			this.onchange();
		} while (cursor !== undefined);
		// What the server no longer lists here has moved, or gone, unless it was made or
		// moved here while the pages were on their way.
		for (const child of [...(this.#children.get(id) ?? [])]) {
			if (!present.has(child) && !this.#writtenAfter(child, started)) this.#forget(child);
		}
		this.#loaded.add(id);
		this.onchange();
	}

	/**
	 * Reads every folder, breadth first, so that favorites, recent, tags and the
	 * storage bar fill in. It never gets in the way: a folder someone opens is read
	 * at once through `loadFolder`, and shared with this. `from` walks a share's folder.
	 */
	async walk(signal?: AbortSignal, from: string | null = this.rootId): Promise<void> {
		if (from === null) return;
		const queue = [from];
		while (queue.length > 0 && !signal?.aborted && !this.#stopped) {
			const id = queue.shift() as string;
			await this.loadFolder(id);
			for (const child of this.#children.get(id) ?? []) {
				if (this.nodes.get(child)?.kind === 'folder') queue.push(child);
			}
		}
	}

	/** Every folder's list counts as out of date, so that the next walk reads them all. */
	invalidate(): void {
		this.#loaded.clear();
	}

	/** Takes a node and what is under it out of what is known here. */
	#forget(id: string): void {
		this.#wrote(id);
		for (const child of [...(this.#children.get(id) ?? [])]) this.#forget(child);
		this.#children.delete(id);
		this.#loaded.delete(id);
		const parent = this.nodes.get(id)?.parentId;
		if (parent) this.#children.get(parent)?.delete(id);
		this.nodes.delete(id);
		const key = this.#keys.get(id);
		if (key !== undefined) this.#retired.push(key);
		this.#keys.delete(id);
		this.#generations.delete(id);
	}

	/** Takes a node and all under it out of what is known here. */
	drop(id: string): void {
		this.#forget(id);
		this.onchange();
	}

	/** Whether anything shows for this node: a file with no version has not arrived yet. */
	#visible(node: DriveNode | undefined): node is DriveNode {
		return node !== undefined && (node.kind === 'folder' || node.currentVersion !== null);
	}

	/** A folder's children, in no particular order. */
	childrenOf(id: string): DriveNode[] {
		return [...(this.#children.get(id) ?? [])]
			.map((child) => this.nodes.get(child))
			.filter((node) => this.#visible(node));
	}

	/**
	 * This user's own, known and not in the trash, the root aside. What others share
	 * stays out: favorites, tags and the storage bar are about one's own files.
	 */
	live(): DriveNode[] {
		const owner = this.rootId === null ? undefined : this.nodes.get(this.rootId)?.ownerId;
		return [...this.nodes.values()].filter(
			(node) =>
				node.parentId !== null &&
				node.ownerId === owner &&
				node.trashedAt === null &&
				this.#visible(node)
		);
	}

	/** From the root down to this node. */
	breadcrumbs(id: string): DriveNode[] {
		const trail: DriveNode[] = [];
		const seen = new Set<string>();
		let at = this.nodes.get(id);
		while (at !== undefined && !seen.has(at.id)) {
			seen.add(at.id);
			trail.unshift(at);
			at = at.parentId === null ? undefined : this.nodes.get(at.parentId);
		}
		return trail;
	}

	/** Whether `id` is `ancestor` or under it, as far as is known here. */
	isWithin(id: string, ancestor: string): boolean {
		return this.breadcrumbs(id).some((node) => node.id === ancestor);
	}

	/** The child of this folder with this name, by the same rule as a name tag. */
	async findByName(parentId: string, name: string): Promise<DriveNode | undefined> {
		await this.loadFolder(parentId, true);
		const wanted = normalizeName(name);
		for (const child of this.#children.get(parentId) ?? []) {
			const node = this.nodes.get(child);
			if (node !== undefined && normalizeName(node.name) === wanted) return node;
		}
		return undefined;
	}

	/** Creates a child of a folder, under a fresh key. */
	async #create(
		parentId: string,
		kind: 'file' | 'folder',
		metadata: NodeMetadata & RawMetadata
	): Promise<DriveNode> {
		const { api, sealer } = this.#deps;
		const id = newId();
		const key = sealer.newNodeKey();
		const node = await this.#fresh([parentId], async () => {
			const parentKey = await this.nodeKey(parentId);
			return api.createNode({
				id,
				parent_id: parentId,
				kind,
				suite: this.#suite,
				sealed_metadata: encodeBase64(sealer.sealMetadata(key, id, metadata)),
				wrapped_key: encodeBase64(sealer.wrapNodeKey(key, parentKey, parentId, id)),
				name_tag: encodeBase64(sealer.nameTag(parentKey, metadata.name)),
				parent_key_generation: this.generationOf(parentId)
			});
		}).catch((e) => {
			zero(key);
			throw e;
		});
		this.#remember(id, key, node.key_generation);
		const stored = this.#store(node, metadata, true);
		this.onchange();
		return stored;
	}

	/** `extra` adds fields of an app's own to the metadata, such as what marks a notebook. */
	async createFolder(parentId: string, typed: string, extra: RawMetadata = {}): Promise<DriveNode> {
		const now = this.#now();
		return this.#create(parentId, 'folder', {
			...extra,
			name: cleanName(typed),
			type: 'folder',
			created: now,
			modified: now,
			size: 0,
			tags: [],
			favorite: false
		});
	}

	/** The node of a file about to be uploaded. It does not show until a version commits. */
	async createFile(
		parentId: string,
		file: { name: string; type: string; size: number; modified: number },
		extra: RawMetadata = {}
	): Promise<DriveNode> {
		return this.#create(parentId, 'file', {
			...extra,
			name: cleanName(file.name),
			type: file.type,
			created: this.#now(),
			modified: file.modified,
			size: file.size,
			tags: [],
			favorite: false
		});
	}

	/** Reads a node again, after a commit or because the journal said so. */
	async refresh(id: string): Promise<DriveNode | undefined> {
		let record: Node;
		try {
			record = await this.#deps.api.getNode(id);
		} catch (e) {
			if (isApiError(e, 'not_found')) {
				this.#forget(id);
				this.onchange();
				return undefined;
			}
			throw e;
		}
		if (record.parent_id === undefined) {
			await this.#adopt(record);
		} else {
			if (!this.nodes.has(record.parent_id)) await this.resolve(record.parent_id);
			await this.#openPage(record.parent_id, [record]);
			if (record.trashed_at !== undefined) this.#forgetChildren(id);
		}
		this.onchange();
		return this.nodes.get(id);
	}

	#forgetChildren(id: string): void {
		for (const child of [...(this.#children.get(id) ?? [])]) this.#forget(child);
		this.#loaded.delete(id);
	}

	async #writeMetadata(
		id: string,
		patch: Partial<NodeMetadata> & RawMetadata,
		tagFor?: (parentKey: Bytes, parentId: string) => { tag: Bytes; generation?: number }
	) {
		const { api, sealer } = this.#deps;
		const parentId = this.#need(id).parentId;
		const involved = tagFor && parentId !== null ? [id, parentId] : [id];
		let metadata: RawMetadata = {};
		const record = await this.#fresh(involved, async () => {
			const key = await this.nodeKey(id);
			metadata = { ...this.#need(id).raw, ...patch };
			const tagged =
				tagFor && parentId !== null ? tagFor(await this.nodeKey(parentId), parentId) : undefined;
			return api.updateNode(id, {
				suite: this.#suite,
				sealed_metadata: encodeBase64(sealer.sealMetadata(key, id, metadata)),
				key_generation: this.generationOf(id),
				name_tag: tagged && encodeBase64(tagged.tag),
				parent_key_generation: tagged?.generation
			});
		});
		const stored = this.#store(record, metadata, true);
		this.onchange();
		return stored;
	}

	#need(id: string): DriveNode {
		const node = this.nodes.get(id);
		if (node === undefined) throw new Error('that is not loaded');
		return node;
	}

	/** Changes fields of a node's metadata, leaving what this client does not know. */
	patch(id: string, patch: Partial<NodeMetadata> & RawMetadata): Promise<DriveNode> {
		this.#need(id);
		return this.#writeMetadata(id, patch);
	}

	async rename(id: string, typed: string): Promise<DriveNode> {
		const node = this.#need(id);
		const name = cleanName(typed);
		if (node.parentId === null) throw new Error('a root has no name');
		return this.#writeMetadata(id, { name }, (parentKey, parentId) => ({
			tag: this.#deps.sealer.nameTag(parentKey, name),
			generation: this.generationOf(parentId)
		}));
	}

	/** Moves a node, wrapping its key and tagging its name under the new parent. */
	async move(id: string, parentId: string): Promise<DriveNode> {
		const { api, sealer } = this.#deps;
		const node = this.#need(id);
		const record = await this.#fresh([id, parentId], async () => {
			const key = await this.nodeKey(id);
			const parentKey = await this.nodeKey(parentId);
			return api.moveNode(id, {
				parent_id: parentId,
				wrapped_key: encodeBase64(sealer.wrapNodeKey(key, parentKey, parentId, id)),
				name_tag: encodeBase64(sealer.nameTag(parentKey, node.name)),
				parent_key_generation: this.generationOf(parentId)
			});
		});
		const stored = this.#store(record, node.raw, node.readable);
		this.onchange();
		return stored;
	}

	async trash(id: string): Promise<void> {
		const record = await this.#deps.api.trashNode(id);
		this.#forgetChildren(id);
		const node = this.nodes.get(id);
		if (node !== undefined) this.#store(record, node.raw, node.readable);
		this.onchange();
	}

	/** Takes it out of the trash, which also cancels a purge. */
	async restore(id: string): Promise<DriveNode> {
		const record = await this.#deps.api.restoreNode(id);
		const parentId = record.parent_id as string;
		await this.nodeKey(parentId);
		await this.#openPage(parentId, [record]);
		this.#loaded.delete(id);
		this.onchange();
		return this.nodes.get(id) as DriveNode;
	}

	async purge(id: string): Promise<DriveNode> {
		const record = await this.#deps.api.purgeNode(id);
		const parentId = record.parent_id as string;
		await this.#openPage(parentId, [record]);
		this.onchange();
		return this.nodes.get(id) as DriveNode;
	}

	/**
	 * Clears the name of a file whose upload never finished: it had no content and
	 * nobody saw it, so it stays out of the trash list until the server removes it.
	 */
	async discard(id: string): Promise<void> {
		const { api } = this.#deps;
		await api.trashNode(id);
		// Only an owner purges. An editor's stays in the owner's trash, where nothing shows it.
		await api.purgeNode(id).catch((e) => {
			if (!isApiError(e, 'forbidden')) throw e;
		});
		this.#forget(id);
		this.onchange();
	}

	/** What a rotation of this node has done: its new key, which is copied, and the node. */
	rotated(record: Node, key: Uint8Array): void {
		const known = this.nodes.get(record.id);
		if (known === undefined) return;
		this.#remember(record.id, key.slice() as Bytes, record.key_generation);
		this.#store(record, known.raw, known.readable);
		this.onchange();
	}

	/**
	 * The key a version was sealed under: the current one, or from it down the chain
	 * the version came with, each link bound to its node and generation. It lives as
	 * long as the tree, as a stream may ask for it again.
	 */
	async keyAt(id: string, generation: number | null, chain: readonly KeyLink[]): Promise<Bytes> {
		const { sealer } = this.#deps;
		let key = await this.nodeKey(id);
		// With no keys there is no chain, and nothing to reach.
		if (generation === null || key.length === 0) return key;
		let have = this.#generations.get(id);
		const top = chain.length === 0 ? generation : chain[0].generation + 1;
		if (have !== top) {
			await this.#reread(id);
			key = await this.nodeKey(id);
			have = this.#generations.get(id);
			if (have !== top) throw new SealError('format');
		}
		let at = have;
		for (const link of chain) {
			if (link.generation !== at - 1) throw new SealError('format');
			const name = `${id}/${link.generation}`;
			let older = this.#older.get(name);
			if (older === undefined) {
				older = sealer.openPreviousKey(decodeBase64(link.sealed_key), key, id, link.generation);
				this.#older.set(name, older);
			}
			key = older;
			at = link.generation;
		}
		if (at !== generation) throw new SealError('format');
		return key;
	}

	/** Everything trashed in its own right, with its name opened. */
	async listTrash(): Promise<DriveNode[]> {
		const out: DriveNode[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.#deps.api.listTrash({ cursor, limit: PAGE });
			const byParent = new Map<string, Node[]>();
			for (const node of page.nodes) {
				const parentId = node.parent_id as string;
				byParent.set(parentId, [...(byParent.get(parentId) ?? []), node]);
			}
			for (const [parentId, records] of byParent) {
				await this.nodeKey(parentId);
				await this.#openPage(parentId, records);
				for (const record of records) {
					const node = this.nodes.get(record.id);
					if (node !== undefined && this.#visible(node)) out.push(node);
				}
			}
			cursor = page.next_cursor;
		} while (cursor !== undefined);
		return out;
	}

	async emptyTrash(): Promise<number> {
		return (await this.#deps.api.emptyTrash()).marked;
	}

	/** Adds a tag to the list on the root, or finds the one with this name. */
	async createTag(typed: string): Promise<TagDefinition> {
		const name = cleanName(typed);
		const wanted = normalizeName(name);
		const existing = this.tags.find((tag) => normalizeName(tag.name) === wanted);
		if (existing !== undefined) return existing;
		const tag: TagDefinition = { id: newId(), name, tone: nextTone(this.tags) };
		await this.#writeTags([...this.tags, tag]);
		return tag;
	}

	/** Takes a tag off the list. Files that carry it simply stop showing it. */
	async deleteTag(id: string): Promise<void> {
		await this.#writeTags(this.tags.filter((tag) => tag.id !== id));
	}

	async #writeTags(tags: TagDefinition[]): Promise<void> {
		const { api, sealer } = this.#deps;
		const id = this.rootId as string;
		const key = await this.nodeKey(id);
		const metadata = { ...this.#rootRaw, tags };
		const record = await api.updateNode(id, {
			suite: this.#suite,
			sealed_metadata: encodeBase64(sealer.sealMetadata(key, id, metadata)),
			key_generation: this.generationOf(id)
		});
		this.#rootRaw = metadata;
		this.tags = tags;
		this.#store(record, metadata, true);
		this.onchange();
	}
}
