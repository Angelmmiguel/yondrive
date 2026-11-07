/** How a file of a given size is cut into frames, as docs/CRYPTO.md section 11 has it. */
import { DEFAULT_FRAME_SIZE, frameCountFor } from '$lib/crypto/content';

/** The most the server takes, for frames and for how many a version may have. */
export const MAX_SERVER_FRAME_SIZE = 16 * 1024 * 1024;
export const MAX_FRAME_COUNT = 1 << 20;

export interface FramePlan {
	size: number;
	frameSize: number;
	frameCount: number;
	storedSize: number;
}

/** A file too large for the server's framing, some 16 TiB. */
export class FileTooLargeError extends Error {
	constructor() {
		super('file too large to frame');
		this.name = 'FileTooLargeError';
	}
}

/** The default frame size, unless the file needs larger frames to stay within the count. */
export function chooseFrameSize(size: number): number {
	const needed = Math.ceil(size / MAX_FRAME_COUNT);
	if (needed <= DEFAULT_FRAME_SIZE) return DEFAULT_FRAME_SIZE;
	if (needed > MAX_SERVER_FRAME_SIZE) throw new FileTooLargeError();
	// Rounded up to a whole MiB, which also keeps the plan easy to read in the logs.
	return Math.ceil(needed / (1024 * 1024)) * 1024 * 1024;
}

export function planFrames(size: number, overhead: number, frameSize?: number): FramePlan {
	const chosen = frameSize ?? chooseFrameSize(size);
	const frameCount = frameCountFor(size, chosen);
	return { size, frameSize: chosen, frameCount, storedSize: size + frameCount * overhead };
}

/** Which plaintext bytes frame `index` holds. */
export function frameBounds(
	plan: FramePlan,
	index: number
): { start: number; end: number; final: boolean } {
	const start = index * plan.frameSize;
	return {
		start,
		end: Math.min(start + plan.frameSize, plan.size),
		final: index === plan.frameCount - 1
	};
}

/** Where frame `index` is in the stored file, both ends included, or null if it has no bytes. */
export function storedRange(
	frameSize: number,
	overhead: number,
	storedSize: number,
	index: number
): { start: number; end: number } | null {
	const stride = frameSize + overhead;
	const start = index * stride;
	const end = Math.min(start + stride, storedSize) - 1;
	return end < start ? null : { start, end };
}

/** The plaintext size of a stored version. */
export function plaintextSize(storedSize: number, frameCount: number, overhead: number): number {
	return storedSize - frameCount * overhead;
}
