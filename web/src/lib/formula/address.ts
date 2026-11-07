/** Cell addresses: zero-based rows and columns, and their A1 names. */

export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;

/** A rectangle of cells, inclusive on every side. */
export interface Area {
	top: number;
	left: number;
	bottom: number;
	right: number;
}

export function colName(col: number): string {
	let s = '';
	let n = col + 1;
	while (n > 0) {
		const r = (n - 1) % 26;
		s = String.fromCharCode(65 + r) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}

/** The column of letters, or -1 past XFD or for anything else. */
export function colIndex(letters: string): number {
	if (letters.length === 0 || letters.length > 3) return -1;
	let n = 0;
	for (const ch of letters.toUpperCase()) {
		const c = ch.charCodeAt(0);
		if (c < 65 || c > 90) return -1;
		n = n * 26 + (c - 64);
	}
	return n - 1 < MAX_COLS ? n - 1 : -1;
}

export const a1 = (row: number, col: number) => `${colName(col)}${row + 1}`;

/** `B3` as row 2, column 1; null if it is not an address on the grid. */
export function parseA1(ref: string): { row: number; col: number } | null {
	const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
	if (!m) return null;
	const col = colIndex(m[1]);
	const row = Number(m[2]) - 1;
	if (col < 0 || row < 0 || row >= MAX_ROWS) return null;
	return { row, col };
}

/** `A1:C4`, `A1`, `A:C` or `2:5` as an area; null otherwise. */
export function parseArea(ref: string): Area | null {
	const parts = ref.trim().split(':');
	if (parts.length === 1) {
		const c = parseA1(parts[0]);
		return c && { top: c.row, left: c.col, bottom: c.row, right: c.col };
	}
	if (parts.length !== 2) return null;
	const a = parseA1(parts[0]);
	const b = parseA1(parts[1]);
	if (a && b) {
		return {
			top: Math.min(a.row, b.row),
			left: Math.min(a.col, b.col),
			bottom: Math.max(a.row, b.row),
			right: Math.max(a.col, b.col)
		};
	}
	const ca = colIndex(parts[0].replace(/\$/g, ''));
	const cb = colIndex(parts[1].replace(/\$/g, ''));
	if (ca >= 0 && cb >= 0 && /^\$?[A-Za-z]+$/.test(parts[0]) && /^\$?[A-Za-z]+$/.test(parts[1])) {
		return { top: 0, left: Math.min(ca, cb), bottom: MAX_ROWS - 1, right: Math.max(ca, cb) };
	}
	const ra = /^\$?(\d+)$/.exec(parts[0]);
	const rb = /^\$?(\d+)$/.exec(parts[1]);
	if (ra && rb) {
		const x = Number(ra[1]) - 1;
		const y = Number(rb[1]) - 1;
		if (x < 0 || y < 0 || x >= MAX_ROWS || y >= MAX_ROWS) return null;
		return { top: Math.min(x, y), left: 0, bottom: Math.max(x, y), right: MAX_COLS - 1 };
	}
	return null;
}

export function areaA1(a: Area): string {
	if (a.top === 0 && a.bottom === MAX_ROWS - 1) return `${colName(a.left)}:${colName(a.right)}`;
	if (a.left === 0 && a.right === MAX_COLS - 1) return `${a.top + 1}:${a.bottom + 1}`;
	const s = a1(a.top, a.left);
	return a.top === a.bottom && a.left === a.right ? s : `${s}:${a1(a.bottom, a.right)}`;
}

export const contains = (a: Area, row: number, col: number) =>
	row >= a.top && row <= a.bottom && col >= a.left && col <= a.right;

/** A cell's key in a sheet's map: rows are contiguous, so a run of rows is a run of keys. */
export const cellKey = (row: number, col: number) => row * MAX_COLS + col;
export const keyRow = (key: number) => Math.floor(key / MAX_COLS);
export const keyCol = (key: number) => key % MAX_COLS;
