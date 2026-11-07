/**
 * The selection as a spreadsheet has it: an anchor where it started, a focus
 * where it ends, and the active cell, which is where typing goes. Moving keeps
 * to the shown rows and columns and steps over merged cells as one.
 */
import { MAX_COLS, MAX_ROWS, type Area } from '$lib/formula/address';

export interface Pos {
	row: number;
	col: number;
}

export interface Selection {
	anchor: Pos;
	focus: Pos;
	/** Where typing goes; inside the area. */
	active: Pos;
}

export const single = (p: Pos): Selection => ({ anchor: p, focus: p, active: p });

export function areaOf(s: Pick<Selection, 'anchor' | 'focus'>): Area {
	return {
		top: Math.min(s.anchor.row, s.focus.row),
		left: Math.min(s.anchor.col, s.focus.col),
		bottom: Math.max(s.anchor.row, s.focus.row),
		right: Math.max(s.anchor.col, s.focus.col)
	};
}

export const inArea = (a: Area, row: number, col: number) =>
	row >= a.top && row <= a.bottom && col >= a.left && col <= a.right;

export const overlaps = (a: Area, b: Area) =>
	!(a.bottom < b.top || a.top > b.bottom || a.right < b.left || a.left > b.right);

export const cellCount = (a: Area) => (a.bottom - a.top + 1) * (a.right - a.left + 1);

/** A sheet's merges sorted four ways, by each edge, toward the far side of the sheet. */
interface MergeIndex {
	byTop: Uint32Array;
	byBottom: Uint32Array;
	byLeft: Uint32Array;
	byRight: Uint32Array;
}

const mergeIndexes = new WeakMap<readonly Area[], MergeIndex>();

function mergeIndex(merges: readonly Area[]): MergeIndex {
	let ix = mergeIndexes.get(merges);
	if (ix) return ix;
	const sorted = (key: (m: Area) => number) =>
		Uint32Array.from(merges.keys()).sort((x, y) => key(merges[x]) - key(merges[y]));
	ix = {
		byTop: sorted((m) => m.top),
		byBottom: sorted((m) => -m.bottom),
		byLeft: sorted((m) => m.left),
		byRight: sorted((m) => -m.right)
	};
	mergeIndexes.set(merges, ix);
	return ix;
}

/**
 * The area grown until no merge sticks out of it. A merge meets the area once
 * each of its four edges is within reach, and the area only grows, so one walk
 * along each sorted list finds every merge, however the merges chain or overlap.
 */
export function withMerges(a: Area, merges: readonly Area[]): Area {
	const out = { ...a };
	const n = merges.length;
	if (n === 0) return out;
	const { byTop, byBottom, byLeft, byRight } = mergeIndex(merges);
	const met = new Uint8Array(n);
	const ready: number[] = [];
	const meet = (k: number) => {
		if (++met[k] === 4) ready.push(k);
	};
	let t = 0;
	let b = 0;
	let l = 0;
	let r = 0;
	for (;;) {
		while (t < n && merges[byTop[t]].top <= out.bottom) meet(byTop[t++]);
		while (b < n && merges[byBottom[b]].bottom >= out.top) meet(byBottom[b++]);
		while (l < n && merges[byLeft[l]].left <= out.right) meet(byLeft[l++]);
		while (r < n && merges[byRight[r]].right >= out.left) meet(byRight[r++]);
		if (ready.length === 0) return out;
		while (ready.length > 0) {
			const m = merges[ready.pop() as number];
			out.top = Math.min(out.top, m.top);
			out.left = Math.min(out.left, m.left);
			out.bottom = Math.max(out.bottom, m.bottom);
			out.right = Math.max(out.right, m.right);
		}
	}
}

export const mergeAt = (merges: readonly Area[], row: number, col: number) =>
	merges.find((m) => inArea(m, row, col));

/** What may be moved over: which rows and columns are shown, and the merges. */
export interface Bounds {
	rows: number;
	cols: number;
	rowShown?: (row: number) => boolean;
	colShown?: (col: number) => boolean;
	merges?: readonly Area[];
}

function step(i: number, by: number, count: number, shown?: (i: number) => boolean): number {
	if (by === 0) return i;
	const dir = by > 0 ? 1 : -1;
	let left = Math.abs(by);
	let at = i;
	while (left > 0) {
		let j = at + dir;
		while (j >= 0 && j < count && shown && !shown(j)) j += dir;
		if (j < 0 || j >= count) break;
		at = j;
		left--;
	}
	return at;
}

/** One cell over (or `by` cells), leaving a merged cell from its far side. */
export function moved(p: Pos, dRow: number, dCol: number, b: Bounds): Pos {
	const m = b.merges ? mergeAt(b.merges, p.row, p.col) : undefined;
	let row = p.row;
	let col = p.col;
	if (m) {
		if (dRow > 0) row = m.bottom;
		if (dRow < 0) row = m.top;
		if (dCol > 0) col = m.right;
		if (dCol < 0) col = m.left;
	}
	row = step(row, dRow, Math.min(b.rows, MAX_ROWS), b.rowShown);
	col = step(col, dCol, Math.min(b.cols, MAX_COLS), b.colShown);
	const landed = b.merges ? mergeAt(b.merges, row, col) : undefined;
	return landed ? { row: landed.top, col: landed.left } : { row, col };
}

/**
 * Ctrl+arrow: from a filled cell whose neighbour is filled, to the last filled
 * one of that run; otherwise to the next filled cell, or the edge of the sheet.
 * `filled` lists the filled indices along the line, ascending.
 */
export function jump(from: number, dir: 1 | -1, filled: readonly number[], last: number): number {
	const has = new Set(filled);
	const next = from + dir;
	if (next < 0 || next > last) return from;
	if (has.has(from) && has.has(next)) {
		let i = next;
		while (i + dir >= 0 && i + dir <= last && has.has(i + dir)) i += dir;
		return i;
	}
	const ahead = dir > 0 ? filled.filter((i) => i > from) : filled.filter((i) => i < from);
	if (ahead.length === 0) return dir > 0 ? last : 0;
	return dir > 0 ? ahead[0] : ahead[ahead.length - 1];
}

/** Enter and Tab inside a selection walk its cells, wrapping, rather than leaving it. */
export function cycle(s: Selection, dRow: number, dCol: number): Selection {
	const a = areaOf(s);
	if (a.top === a.bottom && a.left === a.right) return s;
	let { row, col } = s.active;
	if (dCol !== 0) {
		col += dCol;
		if (col > a.right) {
			col = a.left;
			row = row + 1 > a.bottom ? a.top : row + 1;
		} else if (col < a.left) {
			col = a.right;
			row = row - 1 < a.top ? a.bottom : row - 1;
		}
	} else {
		row += dRow;
		if (row > a.bottom) {
			row = a.top;
			col = col + 1 > a.right ? a.left : col + 1;
		} else if (row < a.top) {
			row = a.bottom;
			col = col - 1 < a.left ? a.right : col - 1;
		}
	}
	return { ...s, active: { row, col } };
}
