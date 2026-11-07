/**
 * Making a thumbnail on the device. Images decode in a worker; a video frame needs
 * a `<video>` element, so it depends on what codecs the browser has. Whatever cannot
 * be decoded, such as HEIC in most browsers, gets the generic icon and no thumbnail.
 */
import { inferType } from '../kinds';
import type { ThumbReply } from '../workers/thumb.worker';

export const THUMB_EDGE = 320;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const VIDEO_TIMEOUT_MS = 15_000;

const IMAGES = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif',
	'image/bmp'
]);

export type ThumbKind = 'image' | 'video';

/** How to make a thumbnail of this file, or nothing if none should be tried. */
export function thumbKindOf(file: { name: string; type: string; size: number }): ThumbKind | null {
	const type = inferType(file.name, file.type);
	if (IMAGES.has(type)) return file.size <= MAX_IMAGE_BYTES ? 'image' : null;
	return type.startsWith('video/') ? 'video' : null;
}

/** Scales to fit in a square of `edge`, never up. */
export function fitWithin(
	width: number,
	height: number,
	edge: number = THUMB_EDGE
): { width: number; height: number } {
	const scale = Math.min(1, edge / Math.max(width, height, 1));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale))
	};
}

function fromImage(file: Blob): Promise<Uint8Array<ArrayBuffer> | null> {
	if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
		return Promise.resolve(null);
	}
	const worker = new Worker(new URL('../workers/thumb.worker.ts', import.meta.url), {
		type: 'module'
	});
	return new Promise<Uint8Array<ArrayBuffer> | null>((resolve) => {
		worker.onmessage = (event: MessageEvent<ThumbReply>) => {
			resolve(event.data.image === null ? null : new Uint8Array(event.data.image));
		};
		worker.onerror = () => resolve(null);
		worker.postMessage({ file, edge: THUMB_EDGE });
	}).finally(() => worker.terminate());
}

async function fromVideo(file: Blob): Promise<Uint8Array<ArrayBuffer> | null> {
	if (typeof document === 'undefined') return null;
	const url = URL.createObjectURL(file);
	const video = document.createElement('video');
	video.muted = true;
	video.preload = 'auto';
	video.playsInline = true;
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timeout')), VIDEO_TIMEOUT_MS);
			video.onloadedmetadata = () => {
				video.currentTime = Math.min(1, (video.duration || 0) / 10);
			};
			video.onseeked = () => {
				clearTimeout(timer);
				resolve();
			};
			video.onerror = () => {
				clearTimeout(timer);
				reject(new Error('cannot decode'));
			};
			video.src = url;
		});
		const { width, height } = fitWithin(video.videoWidth, video.videoHeight);
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (context === null) return null;
		context.drawImage(video, 0, 0, width, height);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, 'image/webp', 0.8)
		);
		return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
	} catch {
		return null;
	} finally {
		video.removeAttribute('src');
		video.load();
		URL.revokeObjectURL(url);
	}
}

/** The bytes of a thumbnail, or null if this file will not make one. */
export function renderThumbnail(
	file: Blob,
	kind: ThumbKind
): Promise<Uint8Array<ArrayBuffer> | null> {
	return kind === 'image' ? fromImage(file) : fromVideo(file);
}
