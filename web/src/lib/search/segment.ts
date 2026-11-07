/**
 * A segment as stored: one sealed JSON document, immutable once written. A later
 * segment wins over an earlier one for any id it holds, and `gone` lists what has
 * been removed. A segment is inverted: `terms` maps each word to postings, a posting
 * being `doc index << 2 | field`. In a mode without keys the server can write these,
 * so `decodeSegment` trusts nothing about the shape.
 */
import { utf8 } from '$lib/crypto/encoding';

export const SEGMENT_VERSION = 1;

/** Below the 16 MiB a small blob may have, with room for what the estimate misses. */
export const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;

/** How many segments a user keeps before the newer ones are merged. */
export const MAX_SEGMENTS = 8;

/** Segments this big are left alone: merging them would only make them split again. */
export const BIG_SEGMENT_BYTES = 4 * 1024 * 1024;

export const FIELD_NAME = 0;
export const FIELD_TAG = 1;
export const FIELD_TEXT = 2;

/** id, parent, name, kind, type, modified, size, shared, tag ids, tag names, version, wants text, text version. */
export type StoredDoc = [
	string,
	string | null,
	string,
	0 | 1,
	string,
	number,
	number,
	0 | 1,
	string[],
	string[],
	string | null,
	0 | 1,
	string | null
];

export interface SegmentBody {
	v: typeof SEGMENT_VERSION;
	seq: number;
	docs: StoredDoc[];
	gone: string[];
	terms: Record<string, number[]>;
}

export class BadSegmentError extends Error {
	constructor() {
		super('this is not a segment');
		this.name = 'BadSegmentError';
	}
}

export function encodeSegment(body: SegmentBody): Uint8Array<ArrayBuffer> {
	return utf8(JSON.stringify(body)) as Uint8Array<ArrayBuffer>;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isStrings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every(isString);
const isOptionalString = (value: unknown) => value === null || isString(value);

function isDoc(value: unknown): value is StoredDoc {
	return (
		Array.isArray(value) &&
		value.length === 13 &&
		isString(value[0]) &&
		isOptionalString(value[1]) &&
		isString(value[2]) &&
		(value[3] === 0 || value[3] === 1) &&
		isString(value[4]) &&
		isCount(value[5]) &&
		isCount(value[6]) &&
		(value[7] === 0 || value[7] === 1) &&
		isStrings(value[8]) &&
		isStrings(value[9]) &&
		isOptionalString(value[10]) &&
		(value[11] === 0 || value[11] === 1) &&
		isOptionalString(value[12])
	);
}

/** The segment in these bytes, or `BadSegmentError`, for a client to make it again. */
export function decodeSegment(bytes: Uint8Array): SegmentBody {
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		throw new BadSegmentError();
	}
	if (body === null || typeof body !== 'object') throw new BadSegmentError();
	const { v, seq, docs, gone, terms } = body as Record<string, unknown>;
	if (v !== SEGMENT_VERSION || !isCount(seq)) throw new BadSegmentError();
	if (!Array.isArray(docs) || !docs.every(isDoc) || !isStrings(gone)) throw new BadSegmentError();
	if (terms === null || typeof terms !== 'object' || Array.isArray(terms)) {
		throw new BadSegmentError();
	}
	for (const postings of Object.values(terms)) {
		if (!Array.isArray(postings) || !postings.every(Number.isSafeInteger)) {
			throw new BadSegmentError();
		}
	}
	return body as SegmentBody;
}

export interface SegmentMeta {
	id: string;
	seq: number;
	size: number;
	gone: string[];
}

/**
 * Which segments to merge: the newest run of small ones. Only a run from the newest
 * down can be merged without reordering, as a merged doc must not overtake a newer
 * copy in a segment left out. Nothing to do at `limit` segments or fewer.
 */
export function planCompaction(
	segments: readonly SegmentMeta[],
	limit = MAX_SEGMENTS
): SegmentMeta[] {
	if (segments.length <= limit) return [];
	const ordered = [...segments].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
	let from = ordered.length;
	while (from > 0 && ordered[from - 1].size < BIG_SEGMENT_BYTES) from--;
	const run = ordered.slice(from);
	return run.length >= 2 ? run : [];
}
