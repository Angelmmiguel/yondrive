/**
 * The spreadsheet model every reader produces and every writer takes: the formula
 * engine's cells (values, formulas, a style id each), a table of styles, and per
 * sheet what the grid needs besides cells: column widths, row heights, merges and
 * frozen panes. It lives in the worker; the page sees windows of it.
 *
 * Writers that keep what was not edited (PLAN 6.2) need to know where each cell
 * came from. Each sheet remembers which sheet of the file it was and the rows and
 * columns inserted and deleted since, so a writer can replay them onto the
 * original's positions.
 */
import { MAX_COLS, MAX_ROWS, type Area } from '$lib/formula/address';
import { Engine, type Cell, type Changes } from '$lib/formula/engine';
import { formatValue } from '$lib/formula/numfmt';
import { shiftArea, shiftSpan } from '$lib/formula/shift';
import type { Census } from './model';

export interface Font {
	name?: string;
	/** In points. */
	size?: number;
	bold?: true;
	italic?: true;
	underline?: true;
	strike?: true;
	/** `#rrggbb`. */
	color?: string;
}

export interface Edge {
	/** `thin`, `medium`, `thick`, `dashed`, `dotted`, `double`, `hair`, … */
	style: string;
	color?: string;
}

export type HAlign =
	'general' | 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed';
export type VAlign = 'top' | 'center' | 'bottom' | 'justify' | 'distributed';

export interface CellStyle {
	/** An Excel format code; `General` by default. */
	numFmt: string;
	font: Font;
	/** A solid fill, `#rrggbb`. */
	fill?: string;
	border: { top?: Edge; right?: Edge; bottom?: Edge; left?: Edge };
	align: { h?: HAlign; v?: VAlign; wrap?: true; indent?: number; rotate?: number };
}

export const DEFAULT_STYLE: CellStyle = { numFmt: 'General', font: {}, border: {}, align: {} };

/** A run of columns sharing a width, zero-based and inclusive. */
export interface ColInfo {
	min: number;
	max: number;
	/** In characters of the default font, as Excel measures. */
	width?: number;
	hidden?: true;
	/** The style of empty cells in these columns. */
	style?: number;
}

export interface RowInfo {
	/** In points. */
	height?: number;
	hidden?: true;
	/** The style of empty cells in the row. */
	style?: number;
}

/** Rows or columns inserted (`count` > 0) or deleted, in the order they happened. */
export interface AxisStep {
	axis: 'row' | 'col';
	at: number;
	count: number;
}

export interface SheetInfo {
	/** The engine's id for the sheet. */
	id: number;
	/** Which sheet of the opened file this was, by position; null for one added since. */
	origin: number | null;
	cols: ColInfo[];
	/** By row index. */
	rows: Map<number, RowInfo>;
	merges: Area[];
	hidden?: true;
	frozen?: { rows: number; cols: number };
	/** Column width and row height where nothing else says, in characters and points. */
	defaultColWidth: number;
	defaultRowHeight: number;
	/** Rows and columns inserted and deleted since the file was opened. */
	steps: AxisStep[];
}

export type SheetFormat = 'xlsx' | 'ods' | 'csv' | 'tsv' | 'xls';

/** What a reader gives: the model, and what the file holds for the notice. */
export interface OpenedSheets {
	book: Book;
	census: Census;
	/** What in the file keeps its old ranges when rows or columns are inserted or deleted. */
	fixedRanges: string[];
}

/** What a writer needs to tell what came from the file it writes into. */
export interface Source {
	format: SheetFormat;
	/** How many styles of the table came from the file (style id below this). */
	styles: number;
	/** How many sheets the file had. */
	sheets: number;
}

const styleKey = (s: CellStyle) => JSON.stringify(s, Object.keys(flatKeys(s)).sort());

function flatKeys(o: object, out: Record<string, true> = {}): Record<string, true> {
	for (const [k, v] of Object.entries(o)) {
		out[k] = true;
		if (v && typeof v === 'object') flatKeys(v, out);
	}
	return out;
}

export class Book {
	readonly engine: Engine;
	readonly styles: CellStyle[];
	readonly sheets: SheetInfo[] = [];
	source: Source;
	#styleIds = new Map<string, number>();

	constructor(engine: Engine, styles: CellStyle[], source: Source) {
		this.engine = engine;
		this.styles = styles.length > 0 ? styles : [structuredClone(DEFAULT_STYLE)];
		this.source = source;
		this.styles.forEach((s, i) => {
			const k = styleKey(s);
			if (!this.#styleIds.has(k)) this.#styleIds.set(k, i);
		});
	}

	get date1904(): boolean {
		return this.engine.date1904;
	}

	/** The id of a style, added to the table when it is new. */
	styleId(style: CellStyle): number {
		const k = styleKey(style);
		const found = this.#styleIds.get(k);
		if (found !== undefined) return found;
		this.styles.push(structuredClone(style));
		this.#styleIds.set(k, this.styles.length - 1);
		return this.styles.length - 1;
	}

	sheet(id: number): SheetInfo {
		const s = this.sheets.find((x) => x.id === id);
		if (!s) throw new Error('no such sheet');
		return s;
	}

	/** Sheets in the engine's order. */
	ordered(): SheetInfo[] {
		return this.engine.sheets.map((s) => this.sheet(s.id));
	}

	/** A cell's value as its number format shows it. */
	display(cell: Cell | undefined): string {
		if (!cell) return '';
		const fmt = this.styles[cell.style]?.numFmt ?? 'General';
		return formatValue(cell.value, fmt, { date1904: this.date1904 });
	}

	addSheet(name: string, at?: number, origin: number | null = null): SheetInfo {
		const id = this.engine.addSheet(name, at);
		const info: SheetInfo = {
			id,
			origin,
			cols: [],
			rows: new Map(),
			merges: [],
			defaultColWidth: 8.43,
			defaultRowHeight: 15,
			steps: []
		};
		this.sheets.push(info);
		return info;
	}

	removeSheet(id: number): Changes {
		const ch = this.engine.removeSheet(id);
		const at = this.sheets.findIndex((s) => s.id === id);
		if (at >= 0) this.sheets.splice(at, 1);
		return ch;
	}

	insertRows(id: number, at: number, count: number): Changes {
		return this.#axis(id, 'row', at, count);
	}

	deleteRows(id: number, at: number, count: number): Changes {
		return this.#axis(id, 'row', at, -count);
	}

	insertCols(id: number, at: number, count: number): Changes {
		return this.#axis(id, 'col', at, count);
	}

	deleteCols(id: number, at: number, count: number): Changes {
		return this.#axis(id, 'col', at, -count);
	}

	#axis(id: number, axis: 'row' | 'col', at: number, count: number): Changes {
		const info = this.sheet(id);
		const changes =
			axis === 'row'
				? count > 0
					? this.engine.insertRows(id, at, count)
					: this.engine.deleteRows(id, at, -count)
				: count > 0
					? this.engine.insertCols(id, at, count)
					: this.engine.deleteCols(id, at, -count);
		const max = axis === 'row' ? MAX_ROWS : MAX_COLS;
		if (count < 0) count = -Math.min(-count, max - at);
		info.steps.push({ axis, at, count });
		info.merges = info.merges
			.map((m) => shiftArea(m, axis, at, count))
			.filter((m): m is Area => m !== null && (m.top !== m.bottom || m.left !== m.right));
		if (axis === 'row') {
			const rows = new Map<number, RowInfo>();
			for (const [r, v] of info.rows) {
				const p = movePos(r, at, count);
				if (p !== null) rows.set(p, v);
			}
			info.rows = rows;
			if (info.frozen && info.frozen.rows > at) {
				info.frozen = { ...info.frozen, rows: Math.max(at, info.frozen.rows + count) };
			}
		} else {
			info.cols = info.cols.flatMap((c) => {
				const s = shiftSpan(c.min, c.max, at, count, MAX_COLS);
				return s ? [{ ...c, min: s[0], max: s[1] }] : [];
			});
			if (info.frozen && info.frozen.cols > at) {
				info.frozen = { ...info.frozen, cols: Math.max(at, info.frozen.cols + count) };
			}
		}
		return changes;
	}

	/** The width of a column in characters. */
	colWidth(id: number, col: number): number {
		const info = this.sheet(id);
		const c = info.cols.find((x) => col >= x.min && col <= x.max);
		return c?.width ?? info.defaultColWidth;
	}

	/** Sets the width of columns, splitting the runs they fall in. */
	setColWidth(id: number, from: number, to: number, width: number | undefined): void {
		const info = this.sheet(id);
		const out: ColInfo[] = [];
		for (const c of info.cols) {
			if (c.max < from || c.min > to) out.push(c);
			else {
				if (c.min < from) out.push({ ...c, max: from - 1 });
				if (c.max > to) out.push({ ...c, min: to + 1 });
			}
		}
		if (width !== undefined) out.push({ min: from, max: to, width });
		info.cols = out.sort((a, b) => a.min - b.min);
	}
}

/** Where a position on one axis ends up after a step; null if it was deleted. */
export function movePos(pos: number, at: number, count: number): number | null {
	if (count > 0) return pos >= at ? pos + count : pos;
	if (pos >= at && pos < at - count) return null;
	return pos >= at - count ? pos + count : pos;
}

/** Where a cell of the file is now, after a sheet's steps; null if it was deleted. */
export function currentOf(
	steps: readonly AxisStep[],
	row: number,
	col: number
): { row: number; col: number } | null {
	let r: number | null = row;
	let c: number | null = col;
	for (const s of steps) {
		if (s.axis === 'row') r = movePos(r as number, s.at, s.count);
		else c = movePos(c as number, s.at, s.count);
		if (r === null || c === null || r >= MAX_ROWS || c >= MAX_COLS) return null;
	}
	return { row: r as number, col: c as number };
}

/**
 * Where a run of the file's rows (or columns) is now: pieces of `length` that
 * moved together, in order. Deleted parts are gone; rows inserted inside the run
 * split it.
 */
export function runPieces(
	steps: readonly AxisStep[],
	axis: 'row' | 'col',
	start: number,
	length: number
): { cur: number; orig: number; length: number }[] {
	let pieces = [{ cur: start, orig: start, length }];
	const max = axis === 'row' ? MAX_ROWS : MAX_COLS;
	for (const s of steps) {
		if (s.axis !== axis) continue;
		const next: typeof pieces = [];
		for (const p of pieces) {
			const end = p.cur + p.length;
			if (s.count > 0) {
				if (s.at <= p.cur) next.push({ ...p, cur: p.cur + s.count });
				else if (s.at >= end) next.push(p);
				else {
					const k = s.at - p.cur;
					next.push({ cur: p.cur, orig: p.orig, length: k });
					next.push({ cur: s.at + s.count, orig: p.orig + k, length: p.length - k });
				}
			} else {
				const dStart = s.at;
				const dEnd = s.at - s.count;
				const n = -s.count;
				if (dEnd <= p.cur) next.push({ ...p, cur: p.cur - n });
				else if (dStart >= end) next.push(p);
				else {
					if (p.cur < dStart) next.push({ cur: p.cur, orig: p.orig, length: dStart - p.cur });
					if (end > dEnd) {
						next.push({ cur: dStart, orig: p.orig + (dEnd - p.cur), length: end - dEnd });
					}
				}
			}
		}
		pieces = next
			.filter((p) => p.cur < max && p.length > 0)
			.map((p) => ({ ...p, length: Math.min(p.length, max - p.cur) }));
	}
	return pieces;
}

/** An area of the file after a sheet's steps, by Excel's rules for ranges; null if deleted. */
export function currentArea(steps: readonly AxisStep[], area: Area): Area | null {
	let a: Area | null = area;
	for (const s of steps) {
		a = shiftArea(a, s.axis, s.at, s.count);
		if (!a) return null;
	}
	return a;
}
