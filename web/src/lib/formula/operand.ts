/** What an expression evaluates to before it lands in a cell: a value, or a reference. */
import type { Area } from './address';
import type { Node } from './ast';
import { err, type Scalar } from './values';

export interface RefValue {
	kind: 'ref';
	sheet: number;
	area: Area;
}

export type Operand = Scalar | RefValue;

/** What evaluation may ask of the workbook, from the cell being calculated. */
export interface Ctx {
	sheet: number;
	row: number;
	col: number;
	date1904: boolean;
	sheetId(name: string): number | undefined;
	value(sheet: number, row: number, col: number): Scalar;
	/** Every cell with content in an area, by rows. */
	each(sheet: number, area: Area, fn: (v: Scalar, row: number, col: number) => void): void;
	/** One past the last row and column with content. */
	extent(sheet: number): { rows: number; cols: number };
	now(): Date;
	ev(node: Node): Operand;
}

export const isRef = (o: Operand): o is RefValue =>
	typeof o === 'object' && o !== null && 'kind' in o;

/**
 * A single value from an operand. A reference to more than one cell gives the
 * cell in the formula's own row or column (implicit intersection), or #VALUE!.
 */
export function deref(o: Operand, c: Ctx): Scalar {
	if (!isRef(o)) return o;
	const a = o.area;
	if (a.top === a.bottom && a.left === a.right) return c.value(o.sheet, a.top, a.left);
	if (a.left === a.right && c.row >= a.top && c.row <= a.bottom)
		return c.value(o.sheet, c.row, a.left);
	if (a.top === a.bottom && c.col >= a.left && c.col <= a.right)
		return c.value(o.sheet, a.top, c.col);
	return err('#VALUE!');
}

/** An area cut to where a sheet has content, for scanning lookups. */
export function clip(o: RefValue, c: Ctx) {
	const ext = c.extent(o.sheet);
	return {
		...o.area,
		bottom: Math.min(o.area.bottom, Math.max(o.area.top, ext.rows - 1)),
		right: Math.min(o.area.right, Math.max(o.area.left, ext.cols - 1))
	};
}
