/**
 * What inserting and deleting rows and columns does to references, as Excel does
 * it: references past the edit move with their cells, a range grows when rows are
 * inserted inside it and shrinks when some of its rows go, and a reference whose
 * cells are all deleted becomes #REF!. Also moving a formula (shared formulas,
 * copies), and renaming or deleting a sheet.
 */
import { MAX_COLS, MAX_ROWS, type Area } from './address';
import { mapRefs, type Node, type RefNode } from './ast';

/** Rows or columns inserted (`count` > 0) or deleted (`count` < 0) at `at`, on one sheet. */
export interface AxisEdit {
	sheet: string;
	axis: 'row' | 'col';
	at: number;
	count: number;
}

const refError = (sheet?: string): Node =>
	sheet === undefined ? { type: 'error', code: '#REF!' } : { type: 'error', code: '#REF!', sheet };

/** One span `[a, b]` of an axis after an edit; null when all of it was deleted. */
export function shiftSpan(
	a: number,
	b: number,
	at: number,
	count: number,
	max: number
): [number, number] | null {
	if (count > 0) {
		const na = a >= at ? a + count : a;
		const nb = b >= at ? b + count : b;
		if (na >= max) return null;
		return [na, Math.min(nb, max - 1)];
	}
	const n = -count;
	const end = at + n;
	if (a >= at && b < end) return null;
	const na = a < at ? a : a < end ? at : a - n;
	const nb = b < at ? b : b < end ? at - 1 : b - n;
	return [na, nb];
}

/** An area after an edit to its sheet; null when all of it was deleted. */
export function shiftArea(area: Area, axis: 'row' | 'col', at: number, count: number): Area | null {
	if (axis === 'row') {
		const s = shiftSpan(area.top, area.bottom, at, count, MAX_ROWS);
		return s && { ...area, top: s[0], bottom: s[1] };
	}
	const s = shiftSpan(area.left, area.right, at, count, MAX_COLS);
	return s && { ...area, left: s[0], right: s[1] };
}

const onSheet = (ref: { sheet?: string }, home: string, sheet: string) =>
	(ref.sheet ?? home).toLowerCase() === sheet.toLowerCase();

function shiftRef(ref: RefNode, e: AxisEdit, home: string): Node {
	if (!onSheet(ref, home, e.sheet)) return ref;
	if (ref.type === 'cell') {
		const pos = e.axis === 'row' ? ref.row : ref.col;
		const s = shiftSpan(pos, pos, e.at, e.count, e.axis === 'row' ? MAX_ROWS : MAX_COLS);
		if (!s) return refError(ref.sheet);
		if (s[0] === pos) return ref;
		return e.axis === 'row' ? { ...ref, row: s[0] } : { ...ref, col: s[0] };
	}
	if ((e.axis === 'row' && ref.kind === 'cols') || (e.axis === 'col' && ref.kind === 'rows'))
		return ref;
	const area = shiftArea(ref, e.axis, e.at, e.count);
	if (!area) return refError(ref.sheet);
	if (
		area.top === ref.top &&
		area.bottom === ref.bottom &&
		area.left === ref.left &&
		area.right === ref.right
	) {
		return ref;
	}
	return { ...ref, ...area };
}

/** A formula after rows or columns change; the same tree when nothing in it moved. */
export function shiftFormula(node: Node, edit: AxisEdit, home: string): Node {
	return mapRefs(node, (r) => shiftRef(r, edit, home));
}

/**
 * A formula moved by `rows` and `cols`, as when it is copied or shared: relative
 * parts follow, absolute ones stay, and anything pushed off the grid is #REF!.
 */
export function translateFormula(node: Node, rows: number, cols: number): Node {
	if (rows === 0 && cols === 0) return node;
	return mapRefs(node, (r) => {
		if (r.type === 'cell') {
			const row = r.rowAbs ? r.row : r.row + rows;
			const col = r.colAbs ? r.col : r.col + cols;
			if (row < 0 || row >= MAX_ROWS || col < 0 || col >= MAX_COLS) return refError(r.sheet);
			return { ...r, row, col };
		}
		const rowsMove = r.kind !== 'cols';
		const colsMove = r.kind !== 'rows';
		const top = rowsMove && !r.topAbs ? r.top + rows : r.top;
		const bottom = rowsMove && !r.bottomAbs ? r.bottom + rows : r.bottom;
		const left = colsMove && !r.leftAbs ? r.left + cols : r.left;
		const right = colsMove && !r.rightAbs ? r.right + cols : r.right;
		if (top < 0 || left < 0 || bottom >= MAX_ROWS || right >= MAX_COLS) return refError(r.sheet);
		return {
			...r,
			top: Math.min(top, bottom),
			bottom: Math.max(top, bottom),
			left: Math.min(left, right),
			right: Math.max(left, right)
		};
	});
}

/** References to a renamed sheet, with its new name. */
export function renameSheetIn(node: Node, from: string, to: string): Node {
	const f = from.toLowerCase();
	const walk = (n: Node): Node => {
		switch (n.type) {
			case 'cell':
			case 'range':
			case 'name':
			case 'error':
				return n.sheet !== undefined && n.sheet.toLowerCase() === f ? { ...n, sheet: to } : n;
			case 'call': {
				const args = n.args.map(walk);
				return args.some((a, i) => a !== n.args[i]) ? { ...n, args } : n;
			}
			case 'unary':
			case 'percent': {
				const arg = walk(n.arg);
				return arg === n.arg ? n : { ...n, arg };
			}
			case 'binary': {
				const left = walk(n.left);
				const right = walk(n.right);
				return left === n.left && right === n.right ? n : { ...n, left, right };
			}
			case 'paren': {
				const expr = walk(n.expr);
				return expr === n.expr ? n : { ...n, expr };
			}
			default:
				return n;
		}
	};
	return walk(node);
}

/** References to a deleted sheet, as #REF!. */
export function dropSheetIn(node: Node, sheet: string): Node {
	const s = sheet.toLowerCase();
	return mapRefs(node, (r) =>
		r.sheet !== undefined && r.sheet.toLowerCase() === s ? { type: 'error', code: '#REF!' } : r
	);
}
