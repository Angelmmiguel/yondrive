/**
 * Pictures of the open document. Bytes stay here, keyed as the model keys them;
 * only types the browser may draw get an object URL, and only on demand. A
 * picture from outside (a paste or a pick) is decoded and drawn again before it
 * is kept, which leaves behind anything but the pixels.
 */
import { DRAWABLE_IMAGES, sniffImage, type ImageData } from '$lib/formats/model';
import { newId } from '$lib/drive/ids';

export const MAX_IMAGE_SIDE = 4096;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export class ImageStore {
	readonly #images = new Map<string, ImageData>();
	readonly #urls = new Map<string, string>();

	constructor(images: Record<string, ImageData> = {}) {
		for (const [k, v] of Object.entries(images)) this.#images.set(k, v);
	}

	get(key: string): ImageData | undefined {
		return this.#images.get(key);
	}

	/** An address to draw it from, or null for what is missing or not drawable. */
	url(key: string): string | null {
		const known = this.#urls.get(key);
		if (known) return known;
		const img = this.#images.get(key);
		if (!img || !DRAWABLE_IMAGES.has(img.mime) || sniffImage(img.bytes) !== img.mime) return null;
		const url = URL.createObjectURL(
			new Blob([img.bytes as Uint8Array<ArrayBuffer>], { type: img.mime })
		);
		this.#urls.set(key, url);
		return url;
	}

	add(img: ImageData): string {
		const key = `new:${newId()}`;
		this.#images.set(key, img);
		return key;
	}

	/** The pictures a set of keys names, for writing. */
	pick(keys: Iterable<string>): Record<string, ImageData> {
		const out: Record<string, ImageData> = {};
		for (const k of keys) {
			const img = this.#images.get(k);
			if (img) out[k] = img;
		}
		return out;
	}

	dispose(): void {
		for (const url of this.#urls.values()) URL.revokeObjectURL(url);
		this.#urls.clear();
	}
}

export class ImageError extends Error {}

/** Decodes a picture and draws it again as PNG or JPEG, no larger than the limit. */
export async function redraw(blob: Blob): Promise<ImageData & { width: number; height: number }> {
	if (blob.size > MAX_IMAGE_BYTES) throw new ImageError('That picture is too large.');
	const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
	const mime = sniffImage(head);
	if (!DRAWABLE_IMAGES.has(mime))
		throw new ImageError('Only PNG, JPEG, GIF, WebP and BMP pictures can be added.');
	const bitmap = await createImageBitmap(blob);
	try {
		const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d');
		if (ctx === null) throw new ImageError('This browser cannot draw pictures.');
		ctx.drawImage(bitmap, 0, 0, width, height);
		const type = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
		const out = await canvas.convertToBlob({ type, quality: 0.92 });
		return { mime: type, bytes: new Uint8Array(await out.arrayBuffer()), width, height };
	} finally {
		bitmap.close();
	}
}

export async function dataUrlToBlob(url: string): Promise<Blob> {
	const m = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(url);
	if (!m) throw new ImageError('not a picture');
	const bin = atob(m[2]);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: m[1] });
}
