/**
 * What a thread points at, and finding it again. A text anchor keeps the words it
 * quotes and a little of what surrounds them, so that it can be found again after
 * the text around it changes; a cell anchor names a sheet and a cell, which editors
 * move when rows or columns are inserted or deleted. Anchors come from other people,
 * through the server, so everything read is checked before it is used.
 */

/** How much text either side of a quote an anchor keeps. */
export const CONTEXT = 32;
/** The longest quote kept. A longer selection is cut. */
export const MAX_QUOTE = 500;
/** The longest comment, in characters. Its sealed form stays well inside the server's limit. */
export const MAX_TEXT = 2000;

export interface TextAnchor {
	kind: 'text';
	quote: string;
	before: string;
	after: string;
	/** Which block of the document it was in, counting from 0. */
	block: number;
}

export interface CellAnchor {
	kind: 'cell';
	sheet: string;
	row: number;
	col: number;
	/** Its row or column was deleted. */
	lost?: boolean;
	/** The delete that lost it, so that inserting the same back, as undo does, finds it again. */
	gone?: { axis: 'rows' | 'cols'; at: number; count: number };
}

export type Anchor = TextAnchor | CellAnchor;

const isInt = (v: unknown, max: number): v is number =>
	typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** An anchor as opened, or null for anything that is not one. */
export function parseAnchor(value: unknown): Anchor | null {
	if (value === null || typeof value !== 'object') return null;
	const a = value as Record<string, unknown>;
	if (a.kind === 'text') {
		if (
			isText(a.quote, MAX_QUOTE) &&
			a.quote !== '' &&
			isText(a.before, CONTEXT) &&
			isText(a.after, CONTEXT) &&
			isInt(a.block, 1_000_000)
		) {
			return { kind: 'text', quote: a.quote, before: a.before, after: a.after, block: a.block };
		}
		return null;
	}
	if (a.kind === 'cell') {
		if (isText(a.sheet, 200) && isInt(a.row, 1_048_575) && isInt(a.col, 16_383)) {
			const out: CellAnchor = { kind: 'cell', sheet: a.sheet, row: a.row, col: a.col };
			if (a.lost === true) {
				out.lost = true;
				const g = a.gone as Record<string, unknown> | undefined;
				if (
					g !== null &&
					typeof g === 'object' &&
					(g.axis === 'rows' || g.axis === 'cols') &&
					isInt(g.at, 1_048_575) &&
					isInt(g.count, 1_048_576) &&
					g.count > 0
				) {
					out.gone = { axis: g.axis, at: g.at, count: g.count };
				}
			}
			return out;
		}
	}
	return null;
}

/** A comment's text as opened, or null for anything that is not a body. */
export function parseBody(value: unknown): string | null {
	if (value === null || typeof value !== 'object') return null;
	const text = (value as Record<string, unknown>).text;
	return isText(text, MAX_TEXT) && text.trim() !== '' ? text : null;
}

/** The body of a comment, as it is sealed. */
export function bodyOf(text: string): { text: string } {
	const clean = text.trim();
	if (clean === '') throw new Error('A comment needs some text.');
	if (clean.length > MAX_TEXT) throw new Error(`A comment holds up to ${MAX_TEXT} characters.`);
	return { text: clean };
}

/** A document's blocks joined into one text, with where each starts. Made once for many anchors. */
export interface JoinedText {
	text: string;
	starts: number[];
}

/** The most places a quote is weighed at: a short quote can appear thousands of times. */
export const MAX_MATCHES = 64;

/** The blocks of a document joined into one text, with where each starts. */
export function joinBlocks(blocks: readonly string[]): JoinedText {
	const starts: number[] = [];
	let text = '';
	for (const [i, b] of blocks.entries()) {
		if (i > 0) text += '\n';
		starts.push(text.length);
		text += b;
	}
	return { text, starts };
}

/** The anchor of a span of one block of text, `from` and `to` counted in that block. */
export function textAnchor(
	blocks: readonly string[],
	block: number,
	from: number,
	to: number
): TextAnchor | null {
	const content = blocks[block];
	if (content === undefined) return null;
	const start = Math.max(0, Math.min(from, content.length));
	const end = Math.max(start, Math.min(to, content.length, start + MAX_QUOTE));
	const quote = content.slice(start, end);
	if (quote.trim() === '') return null;
	const { text, starts } = joinBlocks(blocks);
	const at = starts[block] + start;
	return {
		kind: 'text',
		quote,
		before: text.slice(Math.max(0, at - CONTEXT), at),
		after: text.slice(at + quote.length, at + quote.length + CONTEXT),
		block
	};
}

/** How many characters `a` and `b` share at their ends (`back`) or their starts. */
function shared(a: string, b: string, back: boolean): number {
	let n = 0;
	while (n < a.length && n < b.length) {
		const x = back ? a[a.length - 1 - n] : a[n];
		const y = back ? b[b.length - 1 - n] : b[n];
		if (x !== y) break;
		n++;
	}
	return n;
}

/**
 * Where an anchor's quote is now: of the places the quote appears, the one whose
 * surroundings agree best with what was kept, and then the nearest to its block.
 * Only the first `MAX_MATCHES` from its block on, and as many before it, are weighed,
 * so that the work stays bounded however often a quote appears. Null when the quote
 * appears nowhere: the text is no longer found. Pass `joined` when finding many anchors
 * in one document.
 */
export function findText(
	blocks: readonly string[],
	anchor: TextAnchor,
	joined: JoinedText = joinBlocks(blocks)
): { block: number; from: number; to: number } | null {
	const { text, starts } = joined;
	const origin = starts[Math.min(anchor.block, starts.length - 1)] ?? 0;
	const places: number[] = [];
	for (
		let at = text.indexOf(anchor.quote, origin);
		at >= 0 && places.length < MAX_MATCHES;
		at = text.indexOf(anchor.quote, at + 1)
	) {
		places.push(at);
	}
	const earlier: number[] = [];
	for (
		let at = text.lastIndexOf(anchor.quote, origin - 1);
		origin > 0 && at >= 0 && earlier.length < MAX_MATCHES;
		at = at === 0 ? -1 : text.lastIndexOf(anchor.quote, at - 1)
	) {
		earlier.push(at);
	}
	let best: { at: number; score: number } | null = null;
	for (const at of [...earlier, ...places]) {
		const before = text.slice(Math.max(0, at - CONTEXT), at);
		const after = text.slice(at + anchor.quote.length, at + anchor.quote.length + CONTEXT);
		const block = blockAt(starts, at);
		const score =
			(shared(before, anchor.before, true) + shared(after, anchor.after, false)) * 1000 -
			Math.min(999, Math.abs(block - anchor.block));
		if (best === null || score > best.score) best = { at, score };
	}
	if (best === null) return null;
	const block = blockAt(starts, best.at);
	const from = best.at - starts[block];
	// A quote that runs over the end of its block is cut there; anchors are made in one.
	const to = Math.min(from + anchor.quote.length, blocks[block].length);
	return { block, from, to };
}

function blockAt(starts: readonly number[], at: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= at) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * Where a cell anchor goes when `count` rows or columns are inserted at `at`, or
 * removed from it when `count` is negative. Null when it does not move. A cell in
 * what is removed stays where it was, marked as lost with the delete that lost it;
 * inserting the same rows or columns back at the same place, as undo does, restores it.
 */
export function shiftCell(
	anchor: CellAnchor,
	sheet: string,
	axis: 'rows' | 'cols',
	at: number,
	count: number
): CellAnchor | null {
	if (anchor.sheet !== sheet || count === 0) return null;
	if (anchor.lost) {
		const g = anchor.gone;
		if (g === undefined || g.axis !== axis || g.at !== at || g.count !== count) return null;
		return { kind: 'cell', sheet: anchor.sheet, row: anchor.row, col: anchor.col };
	}
	const key = axis === 'rows' ? 'row' : 'col';
	const index = anchor[key];
	if (count > 0) return index >= at ? { ...anchor, [key]: index + count } : null;
	const removed = -count;
	if (index < at) return null;
	if (index < at + removed) return { ...anchor, lost: true, gone: { axis, at, count: removed } };
	return { ...anchor, [key]: index - removed };
}

/** The name of a cell as a sheet shows it: B5. */
export function cellName(row: number, col: number): string {
	let name = '';
	for (let c = col + 1; c > 0; c = Math.floor((c - 1) / 26)) {
		name = String.fromCharCode(65 + ((c - 1) % 26)) + name;
	}
	return `${name}${row + 1}`;
}
