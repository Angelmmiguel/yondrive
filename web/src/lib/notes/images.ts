/**
 * Pictures of notes, read from the drive by id and shown through object URLs.
 * Only types the browser may draw, told from their bytes, get one; nothing is
 * fetched from anywhere but the drive. Each is read once a session.
 */
import { DRAWABLE_IMAGES, sniffImage } from '$lib/formats/model';

export class ImageUrls {
	readonly #urls = new Map<string, Promise<string | null>>();
	readonly #read: (id: string) => Promise<Uint8Array | null>;

	constructor(read: (id: string) => Promise<Uint8Array | null>) {
		this.#read = read;
	}

	url(id: string): Promise<string | null> {
		let known = this.#urls.get(id);
		if (known === undefined) {
			known = this.#read(id)
				.then((bytes) => {
					if (bytes === null) return null;
					const mime = sniffImage(bytes);
					if (!DRAWABLE_IMAGES.has(mime)) return null;
					return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
				})
				.catch(() => null);
			this.#urls.set(id, known);
		}
		return known;
	}

	clear(): void {
		for (const url of this.#urls.values()) void url.then((u) => u && URL.revokeObjectURL(u));
		this.#urls.clear();
	}
}
