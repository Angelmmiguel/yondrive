/**
 * The upload queue: which files are waiting, moving or stuck, a few at a time. It
 * turns a dropped pile of files and folders into nodes and hands each to the
 * engine. Reactive state wraps it from outside, through `onchange`.
 */
import { isApiError } from '$lib/api/types';
import { newId } from '../ids';
import { inferType } from '../kinds';
import type { DriveNode, DriveTree } from '../tree';
import {
	abandonUpload,
	beginUpload,
	sendUpload,
	UploadRestartError,
	type EngineDeps,
	type UploadSource
} from './engine';
import type { ResumeRecord } from './resume';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled' | 'paused';

export interface UploadItem {
	id: number;
	name: string;
	size: number;
	done: number;
	status: UploadStatus;
	/** Set on a failure: what to tell the person. */
	error?: unknown;
	/** The node, once it exists: where the file ended up, or is going. */
	nodeId?: string;
}

export interface QueuedFile extends UploadSource {
	name: string;
	type: string;
}

interface Job {
	item: UploadItem;
	file: QueuedFile | null;
	parentId?: string;
	/** Folders under `parentId`, from where it was dropped. */
	folders: string[];
	/** An existing file this becomes a new version of. */
	versionOf?: string;
	/** The node exists because of this job, and goes if the job is cancelled. */
	created: boolean;
	record?: ResumeRecord;
	controller: AbortController;
}

export interface QueueDeps {
	tree: Pick<
		DriveTree,
		| 'createFile'
		| 'createFolder'
		| 'findByName'
		| 'nodeKey'
		| 'discard'
		| 'refresh'
		| 'patch'
		| 'resolve'
		| 'generationOf'
	>;
	engine: EngineDeps;
	/** Runs after a version lands, such as making its thumbnail. Failure is its own business. */
	afterCommit?: (node: DriveNode, file: QueuedFile) => void;
	now?: () => number;
}

const FILES_AT_ONCE = 3;
/** How many times a rotation may overtake one upload before it counts as a failure. */
const OVERTAKEN = 3;

export class UploadQueue {
	items: UploadItem[] = [];
	onchange: () => void = () => {};

	readonly #deps: QueueDeps;
	readonly #jobs = new Map<number, Job>();
	readonly #waiting: Job[] = [];
	/** A folder made once, however many files come through it at once. */
	readonly #folders = new Map<string, Promise<string>>();
	#running = 0;
	#seq = 0;
	#stopped = false;

	constructor(deps: QueueDeps) {
		this.#deps = deps;
	}

	get active(): boolean {
		return this.items.some((i) => i.status === 'queued' || i.status === 'uploading');
	}

	#add(job: Omit<Job, 'item' | 'controller' | 'created'>, name: string, size: number): UploadItem {
		const item: UploadItem = { id: ++this.#seq, name, size, done: 0, status: 'queued' };
		const full: Job = { ...job, item, controller: new AbortController(), created: false };
		this.items = [...this.items, item];
		this.#jobs.set(item.id, full);
		this.#waiting.push(full);
		return item;
	}

	/** Queues files for a folder; `path` is the folders between it and the file. */
	addFiles(parentId: string, files: readonly { file: QueuedFile; path?: readonly string[] }[]) {
		for (const { file, path } of files) {
			this.#add({ file, parentId, folders: [...(path ?? [])] }, file.name, file.size);
		}
		this.#pump();
		this.onchange();
	}

	/** Queues a file as a new version of an existing one. */
	addVersion(nodeId: string, file: QueuedFile): void {
		this.#add({ file, folders: [], versionOf: nodeId }, file.name, file.size);
		this.#pump();
		this.onchange();
	}

	/** Makes the folders of a dropped tree, including those with nothing in them. */
	async addFolders(parentId: string, paths: readonly (readonly string[])[]): Promise<void> {
		await Promise.all(paths.map((path) => this.#ensureFolders(parentId, path)));
	}

	/** Shows uploads a reload interrupted, waiting for their file to be picked again. */
	addPaused(record: ResumeRecord, name: string): void {
		const item: UploadItem = {
			id: ++this.#seq,
			name,
			size: record.size,
			done: 0,
			status: 'paused',
			nodeId: record.nodeId
		};
		this.items = [...this.items, item];
		this.#jobs.set(item.id, {
			item,
			file: null,
			folders: [],
			// A first version: the node is there only for this. A later one has a real file behind it.
			created: record.expected === '',
			record,
			controller: new AbortController()
		});
		this.onchange();
	}

	/** Goes on with a paused upload, if this is the same file. */
	resumeWith(id: number, file: QueuedFile): boolean {
		const job = this.#jobs.get(id);
		if (job === undefined || job.item.status !== 'paused' || job.record === undefined) return false;
		if (
			file.size !== job.record.size ||
			file.lastModified !== job.record.lastModified ||
			file.name !== job.item.name
		) {
			return false;
		}
		job.file = file;
		this.#update(job, { status: 'queued', error: undefined });
		this.#waiting.push(job);
		this.#pump();
		return true;
	}

	/** Tries a failed one again. */
	retry(id: number): void {
		const job = this.#jobs.get(id);
		if (job === undefined || job.item.status !== 'failed' || job.file === null) return;
		job.controller = new AbortController();
		this.#update(job, { status: 'queued', error: undefined, done: 0 });
		this.#waiting.push(job);
		this.#pump();
	}

	/** Stops one and releases what it holds on the server. */
	async cancel(id: number): Promise<void> {
		const job = this.#jobs.get(id);
		if (job === undefined) return;
		const { status } = job.item;
		if (status === 'done' || status === 'cancelled') return;
		job.controller.abort(new DOMException('cancelled', 'AbortError'));
		const index = this.#waiting.indexOf(job);
		if (index >= 0) this.#waiting.splice(index, 1);
		this.#update(job, { status: 'cancelled', error: undefined });
		await this.#release(job);
	}

	async #release(job: Job): Promise<void> {
		if (job.record !== undefined) {
			await abandonUpload(job.record.uploadId, this.#deps.engine);
			job.record = undefined;
		}
		if (job.created && job.item.nodeId !== undefined) {
			await this.#deps.tree.discard(job.item.nodeId).catch(() => {});
		}
	}

	/** Takes finished ones off the list. */
	clearFinished(): void {
		for (const item of this.items) {
			if (item.status === 'done' || item.status === 'cancelled') this.#jobs.delete(item.id);
		}
		this.items = this.items.filter((i) => i.status !== 'done' && i.status !== 'cancelled');
		this.onchange();
	}

	/** On lock: stops everything here. What is on the server stays, to resume from. */
	stop(): void {
		this.#stopped = true;
		this.#waiting.length = 0;
		for (const job of this.#jobs.values()) {
			job.controller.abort(new DOMException('stopped', 'AbortError'));
		}
		this.#jobs.clear();
		this.items = [];
		this.onchange();
	}

	#update(job: Job, patch: Partial<UploadItem>): void {
		job.item = { ...job.item, ...patch };
		this.items = this.items.map((i) => (i.id === job.item.id ? job.item : i));
		this.onchange();
	}

	#pump(): void {
		while (!this.#stopped && this.#running < FILES_AT_ONCE && this.#waiting.length > 0) {
			const job = this.#waiting.shift() as Job;
			this.#running += 1;
			void this.#run(job).finally(() => {
				this.#running -= 1;
				this.#pump();
			});
		}
	}

	async #run(job: Job): Promise<void> {
		const signal = job.controller.signal;
		this.#update(job, { status: 'uploading' });
		try {
			await this.#upload(job, signal);
		} catch (e) {
			if (signal.aborted) {
				// What was under way when the cancel came may have got as far as the server.
				if (job.item.status === 'cancelled') await this.#release(job);
				return;
			}
			this.#update(job, { status: 'failed', error: e });
			if (job.record === undefined && job.created && job.item.nodeId !== undefined) {
				// Refused before any frame, such as over quota: nothing to come back to.
				await this.#deps.tree.discard(job.item.nodeId).catch(() => {});
				job.created = false;
				job.item = { ...job.item, nodeId: undefined };
			}
		}
	}

	async #upload(job: Job, signal: AbortSignal): Promise<void> {
		const { tree, engine } = this.#deps;
		const file = job.file as QueuedFile;
		const { nodeId, expected } = await this.#target(job, file);
		signal.throwIfAborted();
		let nodeKey = await tree.nodeKey(nodeId);

		job.record ??= await this.#findResumable(nodeId, file);
		for (let overtaken = 0; ;) {
			const generation = tree.generationOf(nodeId);
			try {
				// Frames sealed under a key that has gone on cannot be mixed with new ones.
				if (
					job.record !== undefined &&
					job.record.keyGeneration !== undefined &&
					generation !== undefined &&
					job.record.keyGeneration !== generation
				) {
					throw new UploadRestartError();
				}
				job.record ??= await beginUpload(
					file,
					{ nodeId, nodeKey, expected, versionId: newId(), keyGeneration: generation },
					engine
				);
				signal.throwIfAborted();
				await sendUpload(
					file,
					job.record,
					nodeKey,
					engine,
					({ done }) => this.#update(job, { done }),
					signal
				);
				break;
			} catch (e) {
				if (isApiError(e, 'key_generation_conflict')) {
					// Rotated meanwhile: read the node's key again, and start over under it.
					if (++overtaken >= OVERTAKEN) throw e;
					await tree.refresh(nodeId);
					nodeKey = await tree.nodeKey(nodeId);
				} else if (!(e instanceof UploadRestartError)) {
					throw e;
				}
				if (job.record !== undefined) await abandonUpload(job.record.uploadId, engine);
				job.record = undefined;
			}
		}
		job.record = undefined;

		let node = await tree.refresh(nodeId);
		if (job.versionOf !== undefined && node !== undefined) {
			node = await tree.patch(nodeId, {
				size: file.size,
				modified: file.lastModified,
				type: inferType(node.name, file.type)
			});
		}
		job.created = false;
		this.#update(job, { status: 'done', done: file.size });
		if (node !== undefined) this.#deps.afterCommit?.(node, file);
	}

	/** An upload of this very file that a reload interrupted, if there is one. */
	async #findResumable(nodeId: string, file: QueuedFile): Promise<ResumeRecord | undefined> {
		const { engine } = this.#deps;
		const records = await engine.resume.list(engine.userId());
		let found: ResumeRecord | undefined;
		for (const record of records) {
			if (record.nodeId !== nodeId) continue;
			if (!found && record.size === file.size && record.lastModified === file.lastModified) {
				found = record;
			} else {
				await abandonUpload(record.uploadId, engine);
			}
		}
		return found;
	}

	/** The node this file goes into, made here if need be. */
	async #target(job: Job, file: QueuedFile): Promise<{ nodeId: string; expected: string }> {
		const { tree } = this.#deps;
		if (job.record !== undefined) {
			return { nodeId: job.record.nodeId, expected: job.record.expected };
		}
		if (job.versionOf !== undefined) {
			const node = await tree.resolve(job.versionOf);
			this.#update(job, { nodeId: node.id });
			return { nodeId: node.id, expected: node.currentVersion ?? '' };
		}
		if (job.item.nodeId !== undefined) return { nodeId: job.item.nodeId, expected: '' };
		const parentId = await this.#ensureFolders(job.parentId as string, job.folders);
		const details = {
			name: file.name,
			type: inferType(file.name, file.type),
			size: file.size,
			modified: file.lastModified
		};
		try {
			const node = await tree.createFile(parentId, details);
			job.created = true;
			this.#update(job, { nodeId: node.id });
			return { nodeId: node.id, expected: '' };
		} catch (e) {
			if (!isApiError(e, 'name_conflict')) throw e;
			// The name may be held by an upload that never finished, which this one takes over.
			const held = await tree.findByName(parentId, file.name);
			if (held === undefined || held.kind !== 'file' || held.currentVersion !== null) throw e;
			job.created = true;
			this.#update(job, { nodeId: held.id });
			return { nodeId: held.id, expected: '' };
		}
	}

	/** The folder at this path under `parentId`, made as needed. */
	#ensureFolders(parentId: string, path: readonly string[]): Promise<string> {
		let at = Promise.resolve(parentId);
		let key = parentId;
		for (const name of path) {
			key = `${key}/${name}`;
			const known = this.#folders.get(key);
			if (known !== undefined) {
				at = known;
				continue;
			}
			const previous = at;
			at = previous.then((parent) => this.#ensureFolder(parent, name));
			const made = at;
			this.#folders.set(key, made);
			// A failure should not stick: the next file through may do better.
			made.catch(() => this.#folders.delete(key));
		}
		return at;
	}

	async #ensureFolder(parentId: string, name: string): Promise<string> {
		const { tree } = this.#deps;
		try {
			return (await tree.createFolder(parentId, name)).id;
		} catch (e) {
			if (!isApiError(e, 'name_conflict')) throw e;
			const existing = await tree.findByName(parentId, name);
			if (existing === undefined || existing.kind !== 'folder') throw e;
			return existing.id;
		}
	}
}
