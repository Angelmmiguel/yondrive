/**
 * One open file in an editor, and getting its edits saved. Saves are new
 * versions, debounced so that typing makes one now and then rather than one per
 * key, and never two at once. Each save commits on the version this editor last
 * saw. If someone else saved in between, the edits become a separate copy and
 * the session goes on in the copy. What the bytes are is the editor's business:
 * `write` gives them in a format.
 */
import { isApiError } from '$lib/api/types';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed';

export interface SessionFile {
	id: string;
	name: string;
	/** The version the next save is based on. */
	version: string;
}

export interface EditSessionDeps {
	/** Commits bytes over `file.version`, returning the new current version. */
	save(file: SessionFile, bytes: Uint8Array): Promise<string>;
	/** Makes a separate file with these bytes, named for a conflict, and returns it. */
	copy(file: SessionFile, bytes: Uint8Array): Promise<SessionFile>;
	/** Renames the file, for a change of format; false if this user may not. */
	rename(file: SessionFile, name: string): Promise<boolean>;
	/** Makes a new file next to this one, when it cannot be renamed. */
	create(file: SessionFile, name: string, bytes: Uint8Array): Promise<SessionFile>;
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

export class EditSession<F extends string> {
	readonly #deps: EditSessionDeps;
	readonly #write: (format: F) => Promise<Uint8Array>;
	readonly #originalFormat: string;
	#file: SessionFile;
	#saveAs: F;
	#status: SaveStatus = 'saved';
	#timer: unknown = null;
	#firstChange: number | null = null;
	#running: Promise<void> | null = null;
	#again = false;
	/** An edit was made that no save has taken the bytes of yet. */
	#dirty = false;
	#closed = false;
	#discarded = false;

	constructor(
		deps: EditSessionDeps,
		file: SessionFile,
		formats: { original: string; saveAs: F },
		write: (format: F) => Promise<Uint8Array>
	) {
		this.#deps = deps;
		this.#file = file;
		this.#originalFormat = formats.original;
		this.#saveAs = formats.saveAs;
		this.#write = write;
	}

	get file(): SessionFile {
		return this.#file;
	}

	get status(): SaveStatus {
		return this.#status;
	}

	get saveFormat(): F {
		return this.#saveAs;
	}

	/** Whether the next save turns the file into another format. */
	get converting(): boolean {
		return this.#saveAs !== this.#originalFormat;
	}

	#set(status: SaveStatus, error?: unknown): void {
		this.#status = status;
		this.#deps.onstatus(status, error);
	}

	/** The file as it is now, in the format it is saved in. */
	bytes(format: F = this.#saveAs): Promise<Uint8Array> {
		return this.#write(format);
	}

	/** An edit was made: a save follows when typing pauses, or after a while regardless. */
	changed(): void {
		if (this.#closed) return;
		this.#dirty = true;
		if (this.#status !== 'saving') this.#set('unsaved');
		this.#schedule();
	}

	#schedule(): void {
		const now = Date.now();
		this.#firstChange ??= now;
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
			this.#dirty ||
			this.#status === 'unsaved' ||
			this.#status === 'failed' ||
			this.#again ||
			this.#timer !== null
		);
	}

	/**
	 * Saves now if anything is waiting, and resolves when what was asked for is
	 * saved. Asked during a save, it resolves only after the save that follows it,
	 * which carries the edits made meanwhile.
	 */
	flush(): Promise<void> {
		if (this.#timer !== null) {
			(this.#deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as number)))(this.#timer);
			this.#timer = null;
		}
		if (this.#running) {
			this.#again = true;
			return this.#running;
		}
		if (this.#status === 'saved' || this.#discarded) return Promise.resolve();
		this.#running = this.#saves();
		return this.#running;
	}

	/** Saves until no flush is waiting on edits made during the last one. */
	async #saves(): Promise<void> {
		try {
			do {
				this.#again = false;
				await this.#save();
			} while (this.#again && !this.#discarded);
		} finally {
			this.#running = null;
		}
	}

	async #save(): Promise<void> {
		this.#firstChange = null;
		this.#dirty = false;
		this.#set('saving');
		let bytes: Uint8Array;
		try {
			bytes = await this.bytes();
			if (this.converting && !this.#file.name.toLowerCase().endsWith(`.${this.#saveAs}`)) {
				await this.#convertFile(bytes);
				this.#done();
				return;
			}
			const version = await this.#deps.save(this.#file, bytes);
			this.#file = { ...this.#file, version };
			this.#done();
		} catch (e) {
			if (isApiError(e, 'version_conflict')) {
				try {
					const copy = await this.#deps.copy(this.#file, bytes!);
					this.#file = copy;
					this.#deps.onfile(copy);
					this.#deps.onconflict(copy);
					this.#done();
					return;
				} catch (copyError) {
					this.#set('failed', copyError);
					return;
				}
			}
			this.#set('failed', e);
		}
	}

	/** A save went through: saved, unless edits came while it ran, which wait for the next. */
	#done(): void {
		if (!this.#dirty && !this.#again) {
			this.#set('saved');
			return;
		}
		this.#set('unsaved');
		if (this.#timer === null && !this.#again && !this.#discarded) this.#schedule();
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
	async convertTo(format: F): Promise<void> {
		this.#saveAs = format;
		this.#set('unsaved');
		await this.flush();
	}

	/** Lets go: pending saves are still made, and it resolves once they are. */
	async close(): Promise<void> {
		this.#closed = true;
		if (this.dirty) await this.flush();
	}

	/**
	 * Lets go without saving: what the editor holds can no longer be trusted, so
	 * nothing more is written. A save already under way finishes with the bytes it took.
	 */
	discard(): void {
		this.#closed = true;
		this.#discarded = true;
		this.#dirty = false;
		this.#again = false;
		if (this.#timer !== null) {
			(this.#deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as number)))(this.#timer);
			this.#timer = null;
		}
	}
}

function renamed(name: string, f: string): string {
	const at = name.lastIndexOf('.');
	return `${at > 0 ? name.slice(0, at) : name}.${f}`;
}
