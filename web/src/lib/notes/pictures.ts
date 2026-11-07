/**
 * Pictures added to a note, on their way up: each goes up as a file beside the
 * note, and the note is written only once every picture in it has that file's
 * address. One that fails to go up stays in the note, waiting, and is tried
 * again at the next save, so a note is never saved with a picture that points
 * nowhere.
 */
import type { Block } from '$lib/formats/model';
import { paragraphs } from './parse';

/** A save that waits for a picture still without its file. */
export class PictureNotKeptError extends Error {
	constructor() {
		super('A picture in this note has not been uploaded yet, so the note is not saved.');
		this.name = 'PictureNotKeptError';
	}
}

export interface PictureUploadsDeps {
	/** Sends a picture up, by its key in the store, and gives the address of its file. */
	upload(key: string, alt: string): Promise<string>;
	/** A picture has its file: the editor points at it. */
	onkept(key: string, href: string): void;
	onfailed(e: unknown): void;
}

export class PictureUploads {
	readonly #deps: PictureUploadsDeps;
	readonly #running = new Map<string, Promise<void>>();
	readonly #kept = new Map<string, string>();
	readonly #failed = new Set<string>();

	constructor(deps: PictureUploadsDeps) {
		this.#deps = deps;
	}

	/**
	 * Sends up the pictures not yet on their way. One that failed is tried again
	 * only on a `retry`, as when the note is saved, not on every keystroke.
	 */
	start(pending: readonly { key: string; alt: string }[], retry = false): void {
		for (const { key, alt } of pending) {
			if (this.#running.has(key) || this.#kept.has(key)) continue;
			if (this.#failed.has(key) && !retry) continue;
			this.#failed.delete(key);
			const job = this.#deps
				.upload(key, alt)
				.then(
					(href) => {
						this.#kept.set(key, href);
						this.#deps.onkept(key, href);
					},
					(e) => {
						this.#failed.add(key);
						this.#deps.onfailed(e);
					}
				)
				.finally(() => this.#running.delete(key));
			this.#running.set(key, job);
		}
	}

	/** Waits for every picture on its way up. */
	async settle(): Promise<void> {
		while (this.#running.size > 0) await Promise.all(this.#running.values());
	}

	/**
	 * The blocks with every picture added here pointing at its file. Throws
	 * `PictureNotKeptError` if one has none, rather than write it pointing nowhere.
	 */
	resolve(blocks: Block[]): Block[] {
		for (const p of paragraphs(blocks)) {
			for (const i of p.content) {
				if (i.type !== 'image' || !i.image.startsWith('new:')) continue;
				const href = this.#kept.get(i.image);
				if (href === undefined) throw new PictureNotKeptError();
				i.image = href;
			}
		}
		return blocks;
	}
}
