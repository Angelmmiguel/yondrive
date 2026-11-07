/** From a `Range` header to frames, for the service worker. */

/** What an open-ended range gets at a time, or `bytes=0-` would decrypt a whole file (Spike B). */
export const OPEN_RANGE_CAP = 16 * 1024 * 1024;

export type ParsedRange =
	{ kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'invalid' };

/**
 * One byte range out of a header, ends included. An open-ended range is capped,
 * and anything but a single range is answered whole, as RFC 9110 allows.
 */
export function parseRange(
	header: string | null,
	size: number,
	cap: number = OPEN_RANGE_CAP
): ParsedRange {
	if (header === null) return { kind: 'full' };
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null) return { kind: 'full' };
	const [, first, last] = match;
	if (first === '' && last === '') return { kind: 'full' };
	if (first === '') {
		const length = Number(last);
		if (length === 0 || size === 0) return { kind: 'invalid' };
		return { kind: 'partial', start: Math.max(0, size - length), end: size - 1 };
	}
	const start = Number(first);
	if (start >= size) return { kind: 'invalid' };
	if (last === '') {
		return { kind: 'partial', start, end: Math.min(start + cap, size) - 1 };
	}
	const end = Number(last);
	if (end < start) return { kind: 'invalid' };
	return { kind: 'partial', start, end: Math.min(end, size - 1) };
}

/** The frames holding a span of plaintext, and where it starts and ends in them. */
export function framesOf(
	start: number,
	end: number,
	frameSize: number
): { first: number; last: number; skip: number; keep: number } {
	const first = Math.floor(start / frameSize);
	const last = Math.floor(end / frameSize);
	return { first, last, skip: start - first * frameSize, keep: end - last * frameSize + 1 };
}
