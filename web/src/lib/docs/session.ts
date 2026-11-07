/**
 * One open document: what it was opened from, and getting edits saved. Saves are
 * new versions, debounced so that typing makes one now and then rather than one
 * per key, and never two at once. Each save writes into the bytes that were
 * opened, so what was not edited stays as it was, and commits on the version
 * this editor last saw. If someone else saved in between, the edits become a
 * separate copy and this session goes on in the copy.
 */
import { isApiError } from '$lib/api/types';
import { saveFormatOf, type DocFormat, type SaveFormat } from '$lib/formats/document';
import type { Block, DocModel } from '$lib/formats/model';
import type { Formats } from './formats-client';
import type { ImageStore } from './images';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed';

export interface SessionFile {
	id: string;
	name: string;
	/** The version the next save is based on. */
	version: string;
}

export interface SessionDeps {
	formats: Pick<Formats, 'write'>;
	/** Commits bytes over `file.version`, returning the new current version. */
	save(file: SessionFile, bytes: Uint8Array): Promise<string>;
	/** Makes a separate file with these bytes, named for a conflict, and returns it. */
	copy(file: SessionFile, bytes: Uint8Array): Promise<SessionFile>;
	/** Renames the file, for a change of format; false if this user may not. */
	rename(file: SessionFile, name: string): Promise<boolean>;
	/** Makes a new file next to this one, when it cannot be renamed. */
	create(file: SessionFile, name: string, bytes: Uint8Array): Promise<SessionFile>;
	/** The document's blocks as the editor has them now. */
	blocks(): Block[];
	images: ImageStore;
	onstatus(status: SaveStatus, error?: unknown): void;
	/** The edits went into a copy, because the file had moved on. */
	onconflict(copy: SessionFile): void;
	/** The file is now another one, or has another name. */
	onfile(file: SessionFile): void;
	debounceMs?: number;
	maxWaitMs?: number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
}

/** Every image key a set of blocks refers to. */
export function imageKeys(blocks: readonly Block[]): Set<string> {
	const keys = new Set<string>();
	const walk = (bs: readonly Block[]) => {
		for (const b of bs) {
			if (b.type === 'paragraph') {
				for (const i of b.content) if (i.type === 'image') keys.add(i.image);
			} else if (b.type === 'table')
				for (const r of b.rows) for (const c of r.cells) walk(c.content);
		}
	};
	walk(blocks);
	return keys;
}

export class DocSession {
	readonly #deps: SessionDeps;
	readonly #original: { bytes: Uint8Array; format: DocFormat };
	#file: SessionFile;
	#saveAs: SaveFormat;
	#status: SaveStatus = 'saved';
	#timer: unknown = null;
	#firstChange: number | null = null;
	#running: Promise<void> | null = null;
	#again = false;
	#closed = false;

	constructor(
		deps: SessionDeps,
		file: SessionFile,
		original: { bytes: Uint8Array; format: DocFormat }
	) {
		this.#deps = deps;
		this.#file = file;
		this.#original = original;
		this.#saveAs = saveFormatOf(original.format);
	}

	get file(): SessionFile {
		return this.#file;
	}

	get status(): SaveStatus {
		return this.#status;
	}

	get saveFormat(): SaveFormat {
		return this.#saveAs;
	}

	/** Whether the next save turns the file into another format. */
	get converting(): boolean {
		return this.#saveAs !== this.#original.format;
	}

	#set(status: SaveStatus, error?: unknown): void {
		this.#status = status;
		this.#deps.onstatus(status, error);
	}

	/** The document as it is now, in the format it is saved in. */
	async bytes(format: SaveFormat = this.#saveAs): Promise<Uint8Array> {
		const blocks = this.#deps.blocks();
		const model: DocModel = { blocks, images: this.#deps.images.pick(imageKeys(blocks)) };
		return this.#deps.formats.write(format, model, this.#original);
	}

	/** An edit was made: a save follows when typing pauses, or after a while regardless. */
	changed(): void {
		if (this.#closed) return;
		const now = Date.now();
		this.#firstChange ??= now;
		if (this.#status !== 'saving') this.#set('unsaved');
		const set = this.#deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
		const clear = this.#deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as number));
		if (this.#timer !== null) clear(this.#timer);
		const wait = Math.max(
			0,
			Math.min(
				this.#deps.debounceMs ?? 2500,
				this.#firstChange + (this.#deps.maxWaitMs ?? 20_000) - now
			)
		);
		this.#timer = set(() => {
			this.#timer = null;
			void this.flush();
		}, wait);
	}

	get dirty(): boolean {
		return (
			this.#status === 'unsaved' || this.#status === 'failed' || this.#again || this.#timer !== null
		);
	}

	/** Saves now if anything is waiting, and resolves when what was asked for is saved. */
	async flush(): Promise<void> {
		if (this.#timer !== null) {
			(this.#deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as number)))(this.#timer);
			this.#timer = null;
		}
		if (this.#running) {
			this.#again = true;
			return this.#running;
		}
		if (this.#status === 'saved') return;
		this.#running = this.#save();
		try {
			await this.#running;
		} finally {
			this.#running = null;
		}
		if (this.#again) {
			this.#again = false;
			await this.flush();
		}
	}

	async #save(): Promise<void> {
		this.#firstChange = null;
		this.#set('saving');
		let bytes: Uint8Array;
		try {
			bytes = await this.bytes();
			if (this.converting && !this.#file.name.toLowerCase().endsWith(`.${this.#saveAs}`)) {
				await this.#convertFile(bytes);
				this.#set(this.#again ? 'unsaved' : 'saved');
				return;
			}
			const version = await this.#deps.save(this.#file, bytes);
			this.#file = { ...this.#file, version };
			this.#set(this.#again ? 'unsaved' : 'saved');
		} catch (e) {
			if (isApiError(e, 'version_conflict')) {
				try {
					const copy = await this.#deps.copy(this.#file, bytes!);
					this.#file = copy;
					this.#deps.onfile(copy);
					this.#deps.onconflict(copy);
					this.#set('saved');
					return;
				} catch (copyError) {
					this.#set('failed', copyError);
					return;
				}
			}
			this.#set('failed', e);
		}
	}

	/** The first save in a new format: a new version under the new name, or a new file. */
	async #convertFile(bytes: Uint8Array): Promise<void> {
		const before = this.#file;
		const name = renamed(before.name, this.#saveAs);
		if (!(await this.#deps.rename(before, name))) {
			// Not this user's to rename: the converted file goes beside it.
			this.#file = await this.#deps.create(before, name, bytes);
			this.#deps.onfile(this.#file);
			return;
		}
		this.#file = { ...before, name };
		try {
			const version = await this.#deps.save(this.#file, bytes);
			this.#file = { ...this.#file, version };
		} catch (e) {
			await this.#deps.rename(this.#file, before.name).catch(() => false);
			this.#file = before;
			throw e;
		}
		this.#deps.onfile(this.#file);
	}

	/** Saves in another format from now on. The original stays in Versions. */
	async convertTo(format: SaveFormat): Promise<void> {
		this.#saveAs = format;
		this.#set('unsaved');
		await this.flush();
	}

	/** Lets go: pending saves are still made. */
	async close(): Promise<void> {
		this.#closed = true;
		if (this.dirty) await this.flush();
	}
}

function renamed(name: string, f: SaveFormat): string {
	const at = name.lastIndexOf('.');
	return `${at > 0 ? name.slice(0, at) : name}.${f}`;
}
