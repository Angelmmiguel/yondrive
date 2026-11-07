/**
 * The spreadsheet as the editor drives it, inside the worker: one open workbook,
 * what is typed into a cell, formatting, rows, columns and sheets, sorting,
 * windows of formatted values for the grid, and saving. Everything it returns is
 * plain data, so it crosses to the page; the page never holds the workbook.
 */
import { MAX_COLS, MAX_ROWS, type Area } from '$lib/formula/address';
import { print } from '$lib/formula/ast';
import { dateFromText } from '$lib/formula/dates';
import type { Cell, CellInput, CellRef } from '$lib/formula/engine';
import { FormulaInputError } from '$lib/formula/engine';
import { translateFormula } from '$lib/formula/shift';
import {
	compare,
	isError,
	isErrorCode,
	err,
	type ErrorCode,
	type Scalar
} from '$lib/formula/values';
import type { Census } from '$lib/formats/model';
import {
	lostOnSave,
	readSpreadsheet,
	sheetNoticeOf,
	sheetSaveFormatOf,
	writeSpreadsheet,
	type SheetFormat,
	type SheetNotice,
	type SheetSaveFormat
} from '$lib/formats/spreadsheet';
import type { Book, CellStyle, ColInfo, Edge, Font, RowInfo } from '$lib/formats/workbook';
import { transfer } from './rpc';

/** A cell as the grid draws it. */
export interface CellView {
	row: number;
	col: number;
	/** As its number format shows it. */
	text: string;
	value: Scalar;
	/** With `=`, as a person reads it. */
	formula?: string;
	style: number;
	/** Cannot be changed here: a formula this app does not calculate, or part of an array formula. */
	readOnly?: true;
	/** Part of a dependency cycle; its value is #REF!. */
	cycle?: true;
	/** A formula not calculated here whose inputs changed: the value shown is the file's. */
	stale?: true;
	/** What is not calculated here, for the cell's tooltip. */
	unsupported?: string[];
}

export interface SheetMeta {
	id: number;
	name: string;
	hidden: boolean;
	/** One past the last row and column with content. */
	rows: number;
	cols: number;
	frozen?: { rows: number; cols: number };
	defaultColWidth: number;
	defaultRowHeight: number;
	merges: Area[];
	colInfo: ColInfo[];
	rowInfo: [number, RowInfo][];
}

export interface Loaded {
	format: SheetFormat;
	sheets: SheetMeta[];
	styles: CellStyle[];
	census: Census;
	notice: SheetNotice;
	/** What keeps its old ranges when rows or columns move: warn before inserting or deleting. */
	fixedRanges: string[];
	date1904: boolean;
}

export interface EditResult {
	/** Cells whose value or formula changed: redraw them. */
	changed: CellRef[];
	/** Styles added to the table, from index `from`. */
	newStyles?: { from: number; styles: CellStyle[] };
}

/** Changes to a style; `null` takes a setting off. */
export interface StylePatch {
	numFmt?: string;
	font?: { [K in keyof Font]?: Font[K] | null };
	fill?: string | null;
	border?: { top?: Edge | null; right?: Edge | null; bottom?: Edge | null; left?: Edge | null };
	align?: { [K in keyof CellStyle['align']]?: CellStyle['align'][K] | null };
}

export interface SortKey {
	col: number;
	desc?: boolean;
}

/** What a typed text is: a formula, a value, or nothing; and the number format it suggests. */
export function parseInput(text: string): { input: CellInput | null; numFmt?: string } {
	if (text === '') return { input: null };
	if (text.startsWith("'")) return { input: { value: text.slice(1) } };
	if (text.startsWith('=') && text.length > 1) return { input: { formula: text.slice(1) } };
	const t = text.trim();
	const upper = t.toUpperCase();
	if (upper === 'TRUE' || upper === 'FALSE') return { input: { value: upper === 'TRUE' } };
	if (isErrorCode(upper)) return { input: { value: err(upper as ErrorCode) } };
	let m: RegExpExecArray | null;
	if ((m = /^([+-]?)(\d+(?:\.(\d+))?|\.(\d+))%$/.exec(t))) {
		const n = Number(m[1] + m[2]) / 100;
		const dec = (m[3] ?? m[4] ?? '').length;
		return { input: { value: n }, numFmt: dec > 0 ? `0.${'0'.repeat(Math.min(dec, 10))}%` : '0%' };
	}
	if ((m = /^(-?)\$(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/.exec(t))) {
		const n = Number(m[1] + m[2].replace(/,/g, '') + (m[3] ?? ''));
		return { input: { value: n }, numFmt: m[3] ? '"$"#,##0.00' : '"$"#,##0' };
	}
	if ((m = /^(-?)(\d{1,3}(?:,\d{3})+)(\.\d+)?$/.exec(t))) {
		return {
			input: { value: Number(m[1] + m[2].replace(/,/g, '') + (m[3] ?? '')) },
			numFmt: m[3] ? '#,##0.00' : '#,##0'
		};
	}
	if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) {
		const n = Number(t);
		if (Number.isFinite(n)) return { input: { value: n } };
	}
	const d = /\d/.test(t) && !/^\d+$/.test(t) ? dateFromText(t) : null;
	if (d !== null) {
		const hasTime = /:/.test(t);
		const ampm = /\s*(am|pm|a|p)$/i.test(t);
		const secs = /:\d+:\d+/.test(t);
		const time = `h:mm${secs ? ':ss' : ''}${ampm ? ' AM/PM' : ''}`;
		const onlyTime = hasTime && d < 1;
		return {
			input: { value: d },
			numFmt: onlyTime ? time : hasTime ? `m/d/yyyy ${time}` : 'm/d/yyyy'
		};
	}
	return { input: { value: text } };
}

function patched(base: CellStyle, p: StylePatch): CellStyle {
	const s: CellStyle = structuredClone(base);
	if (p.numFmt !== undefined) s.numFmt = p.numFmt;
	const set = <T extends object>(target: T, changes: object | undefined) => {
		for (const [k, v] of Object.entries(changes ?? {})) {
			if (v === null || v === undefined || v === false)
				delete (target as Record<string, unknown>)[k];
			else (target as Record<string, unknown>)[k] = v;
		}
	};
	set(s.font, p.font);
	set(s.border, p.border);
	set(s.align, p.align);
	if (p.fill === null) delete s.fill;
	else if (p.fill !== undefined) s.fill = p.fill;
	return s;
}

/** Excel's sort order: numbers, text, booleans, errors, and blanks always last. */
function sortRank(v: Scalar): number {
	if (v === null || v === '') return 4;
	if (typeof v === 'number') return 0;
	if (typeof v === 'string') return 1;
	if (typeof v === 'boolean') return 2;
	return 3;
}

const TEXT_LIMIT = 1024 * 1024;

export class SheetService {
	#book: Book | null = null;
	#bytes: Uint8Array | null = null;
	#format: SheetFormat = 'xlsx';
	#census: Census = { items: [] };
	#fixed: string[] = [];

	get #b(): Book {
		if (!this.#book) throw new Error('no workbook is open');
		return this.#book;
	}

	/** Opens a file; what was open before is dropped. */
	async load(bytes: Uint8Array, format: SheetFormat): Promise<Loaded> {
		const opened = await readSpreadsheet(bytes, format);
		this.#book = opened.book;
		this.#bytes = bytes;
		this.#format = format;
		this.#census = opened.census;
		this.#fixed = opened.fixedRanges;
		return {
			format,
			sheets: this.sheets(),
			styles: this.#b.styles,
			census: opened.census,
			notice: sheetNoticeOf(format, opened.census),
			fixedRanges: opened.fixedRanges,
			date1904: this.#b.date1904
		};
	}

	sheets(): SheetMeta[] {
		const b = this.#b;
		return b.ordered().map((info) => {
			const ext = b.engine.extent(info.id);
			return {
				id: info.id,
				name: b.engine.sheetName(info.id),
				hidden: !!info.hidden,
				rows: ext.rows,
				cols: ext.cols,
				frozen: info.frozen,
				defaultColWidth: info.defaultColWidth,
				defaultRowHeight: info.defaultRowHeight,
				merges: info.merges,
				colInfo: info.cols,
				rowInfo: [...info.rows]
			};
		});
	}

	styles(): CellStyle[] {
		return this.#b.styles;
	}

	#view(c: Cell): CellView {
		const b = this.#b;
		const v: CellView = {
			row: c.row,
			col: c.col,
			text: b.display(c),
			value: c.value,
			style: c.style
		};
		const f = b.engine.formulaText(c);
		if (f !== null) v.formula = f;
		if (b.engine.readOnly(c.sheet, c.row, c.col)) v.readOnly = true;
		if (c.cycle) v.cycle = true;
		if (c.stale) v.stale = true;
		if (c.formula && c.formula.missing.length > 0) v.unsupported = c.formula.missing;
		return v;
	}

	/** The cells with content or a style in an area, for the grid to draw. */
	window(sheet: number, top: number, left: number, bottom: number, right: number): CellView[] {
		const e = this.#b.engine;
		const out: CellView[] = [];
		const size = (bottom - top + 1) * (right - left + 1);
		if (size <= 20000) {
			for (let r = top; r <= bottom; r++) {
				for (let c = left; c <= right; c++) {
					const cell = e.cell(sheet, r, c);
					if (cell) out.push(this.#view(cell));
				}
			}
		} else {
			for (const cell of e.cells(sheet)) {
				if (cell.row >= top && cell.row <= bottom && cell.col >= left && cell.col <= right)
					out.push(this.#view(cell));
			}
			out.sort((a, b) => a.row - b.row || a.col - b.col);
		}
		return out;
	}

	/** One cell, for the formula bar; null when it is empty. */
	cell(sheet: number, row: number, col: number): CellView | null {
		const c = this.#b.engine.cell(sheet, row, col);
		return c ? this.#view(c) : null;
	}

	#newStyles<T>(from: number, f: () => T): T & { newStyles?: EditResult['newStyles'] } {
		const r = f() as T & { newStyles?: EditResult['newStyles'] };
		const styles = this.#b.styles;
		if (styles.length > from) r.newStyles = { from, styles: styles.slice(from) };
		return r;
	}

	/**
	 * Puts what was typed into cells: `=` starts a formula, a leading `'` keeps text
	 * as text, and numbers, percentages, currency and dates are read as such, giving
	 * a General cell a matching format. Throws FormulaInputError (problem: syntax,
	 * unsupported, arity, sheet, readonly) and changes nothing when any fails.
	 */
	setCells(edits: { sheet: number; row: number; col: number; text: string }[]): EditResult {
		const b = this.#b;
		return this.#newStyles(b.styles.length, () => {
			const parsed = edits.map((e) => ({ ...e, ...parseInput(e.text) }));
			const changes = b.engine.setMany(
				parsed.map((p) => ({ sheet: p.sheet, row: p.row, col: p.col, input: p.input }))
			);
			for (const p of parsed) {
				if (!p.numFmt) continue;
				const c = b.engine.cell(p.sheet, p.row, p.col);
				const base = b.styles[c?.style ?? 0] ?? b.styles[0];
				if (base.numFmt !== 'General') continue;
				b.engine.setStyle(p.sheet, p.row, p.col, b.styleId({ ...base, numFmt: p.numFmt }));
			}
			return { changed: changes.cells };
		});
	}

	/** Clears an area's contents, keeping its formatting. */
	clear(sheet: number, area: Area): EditResult {
		const e = this.#b.engine;
		const edits: (CellRef & { input: null })[] = [];
		for (const c of e.cells(sheet)) {
			if (
				c.row >= area.top &&
				c.row <= area.bottom &&
				c.col >= area.left &&
				c.col <= area.right &&
				(c.value !== null || c.formula)
			) {
				edits.push({ sheet, row: c.row, col: c.col, input: null });
			}
		}
		return { changed: e.setMany(edits).cells };
	}

	/** Changes the formatting of an area. Whole columns change the columns' own style too. */
	setStyle(sheet: number, area: Area, patch: StylePatch): EditResult {
		const b = this.#b;
		return this.#newStyles(b.styles.length, () => {
			const e = b.engine;
			const restyle = (row: number, col: number, current: number) => {
				const next = b.styleId(patched(b.styles[current] ?? b.styles[0], patch));
				if (next !== current) e.setStyle(sheet, row, col, next);
			};
			const size = (area.bottom - area.top + 1) * (area.right - area.left + 1);
			if (size <= 200_000) {
				for (let r = area.top; r <= area.bottom; r++) {
					for (let c = area.left; c <= area.right; c++)
						restyle(r, c, e.cell(sheet, r, c)?.style ?? this.#defaultStyle(sheet, r, c));
				}
			} else {
				const inside = [...e.cells(sheet)].filter(
					(c) =>
						c.row >= area.top && c.row <= area.bottom && c.col >= area.left && c.col <= area.right
				);
				for (const c of inside) restyle(c.row, c.col, c.style);
				const info = b.sheet(sheet);
				if (area.top === 0 && area.bottom === MAX_ROWS - 1) {
					for (let c = area.left; c <= Math.min(area.right, MAX_COLS - 1); c++) {
						const cur = info.cols.find((x) => c >= x.min && c <= x.max);
						const style = b.styleId(patched(b.styles[cur?.style ?? 0], patch));
						b.setColWidth(sheet, c, c, cur?.width);
						const ci = info.cols.find((x) => c >= x.min && c <= x.max);
						if (ci) ci.style = style;
						else {
							info.cols.push({ min: c, max: c, style });
							info.cols.sort((x, y) => x.min - y.min);
						}
					}
				} else if (area.left === 0 && area.right === MAX_COLS - 1) {
					for (let r = area.top; r <= area.bottom && r - area.top < 100_000; r++) {
						const ri = info.rows.get(r) ?? {};
						info.rows.set(r, { ...ri, style: b.styleId(patched(b.styles[ri.style ?? 0], patch)) });
					}
				}
			}
			return { changed: [] };
		});
	}

	/** The style an empty cell shows: its row's, else its column's, else the default. */
	#defaultStyle(sheet: number, row: number, col: number): number {
		const info = this.#b.sheet(sheet);
		return (
			info.rows.get(row)?.style ?? info.cols.find((c) => col >= c.min && col <= c.max)?.style ?? 0
		);
	}

	insertRows(sheet: number, at: number, count: number): EditResult {
		return { changed: this.#b.insertRows(sheet, at, count).cells };
	}

	deleteRows(sheet: number, at: number, count: number): EditResult {
		return { changed: this.#b.deleteRows(sheet, at, count).cells };
	}

	insertCols(sheet: number, at: number, count: number): EditResult {
		return { changed: this.#b.insertCols(sheet, at, count).cells };
	}

	deleteCols(sheet: number, at: number, count: number): EditResult {
		return { changed: this.#b.deleteCols(sheet, at, count).cells };
	}

	addSheet(name?: string, at?: number): SheetMeta {
		const b = this.#b;
		let n = name ?? '';
		if (!n) {
			let k = b.sheets.length + 1;
			while (b.engine.sheetByName(`Sheet${k}`)) k++;
			n = `Sheet${k}`;
		}
		const info = b.addSheet(n, at);
		return this.sheets().find((s) => s.id === info.id) as SheetMeta;
	}

	renameSheet(sheet: number, name: string): EditResult {
		const n = name.trim();
		if (!n || n.length > 31 || /[[\]:*?/\\]/.test(n) || /^'|'$/.test(n)) {
			throw new FormulaInputError('sheet', 'not a valid sheet name');
		}
		return { changed: this.#b.engine.renameSheet(sheet, n).cells };
	}

	removeSheet(sheet: number): EditResult {
		if (this.#b.sheets.length <= 1)
			throw new FormulaInputError('sheet', 'a workbook keeps one sheet');
		return { changed: this.#b.removeSheet(sheet).cells };
	}

	moveSheet(sheet: number, to: number): void {
		this.#b.engine.moveSheet(sheet, to);
	}

	setSheetHidden(sheet: number, hidden: boolean): void {
		const info = this.#b.sheet(sheet);
		if (hidden) info.hidden = true;
		else delete info.hidden;
	}

	/** Column widths in characters; undefined for the default. */
	setColWidth(sheet: number, from: number, to: number, width: number | undefined): void {
		this.#b.setColWidth(sheet, from, to, width);
	}

	/** Row heights in points; undefined for the default. */
	setRowHeight(sheet: number, from: number, to: number, height: number | undefined): void {
		const info = this.#b.sheet(sheet);
		for (let r = from; r <= to && r - from < 100_000; r++) {
			const next: RowInfo = { ...info.rows.get(r) };
			if (height === undefined) delete next.height;
			else next.height = height;
			if (Object.keys(next).length > 0) info.rows.set(r, next);
			else info.rows.delete(r);
		}
	}

	setFrozen(sheet: number, rows: number, cols: number): void {
		const info = this.#b.sheet(sheet);
		if (rows > 0 || cols > 0) info.frozen = { rows, cols };
		else delete info.frozen;
	}

	/** Merges an area, keeping the top-left cell's content as Excel does; merges it overlaps go. */
	merge(sheet: number, area: Area): EditResult {
		const b = this.#b;
		const info = b.sheet(sheet);
		const edits: (CellRef & { input: null })[] = [];
		for (const c of b.engine.cells(sheet)) {
			const inside =
				c.row >= area.top && c.row <= area.bottom && c.col >= area.left && c.col <= area.right;
			if (
				inside &&
				(c.row !== area.top || c.col !== area.left) &&
				(c.value !== null || c.formula)
			) {
				edits.push({ sheet, row: c.row, col: c.col, input: null });
			}
		}
		const changed = b.engine.setMany(edits).cells;
		info.merges = info.merges.filter(
			(m) =>
				m.bottom < area.top || m.top > area.bottom || m.right < area.left || m.left > area.right
		);
		if (area.bottom > area.top || area.right > area.left) info.merges.push({ ...area });
		return { changed };
	}

	unmerge(sheet: number, area: Area): void {
		const info = this.#b.sheet(sheet);
		info.merges = info.merges.filter(
			(m) =>
				m.bottom < area.top || m.top > area.bottom || m.right < area.left || m.left > area.right
		);
	}

	/**
	 * Sorts the rows of an area by its columns. Formulas move with their rows and
	 * their relative references follow, as when cut and pasted. Refused where the
	 * area holds merged or read-only cells.
	 */
	sort(sheet: number, area: Area, keys: SortKey[], header = false): EditResult {
		const b = this.#b;
		const e = b.engine;
		const info = b.sheet(sheet);
		const top = area.top + (header ? 1 : 0);
		if (top > area.bottom || keys.length === 0) return { changed: [] };
		if (
			info.merges.some(
				(m) =>
					!(m.bottom < top || m.top > area.bottom || m.right < area.left || m.left > area.right)
			)
		) {
			throw new FormulaInputError('readonly', 'merged cells');
		}
		const rows: { from: number; cells: (Cell | undefined)[] }[] = [];
		for (let r = top; r <= area.bottom; r++) {
			const cells: (Cell | undefined)[] = [];
			for (let c = area.left; c <= area.right; c++) {
				if (e.readOnly(sheet, r, c))
					throw new FormulaInputError('readonly', 'a cell that cannot be changed');
				cells.push(e.cell(sheet, r, c));
			}
			rows.push({ from: r, cells });
		}
		const order = rows
			.map((row, i) => ({ row, i }))
			.sort((x, y) => {
				for (const k of keys) {
					const a = x.row.cells[k.col - area.left]?.value ?? null;
					const c = y.row.cells[k.col - area.left]?.value ?? null;
					const ra = sortRank(a);
					const rc = sortRank(c);
					if (ra === 4 || rc === 4) {
						if (ra !== rc) return ra === 4 ? 1 : -1;
						continue;
					}
					let d = ra - rc;
					if (d === 0 && ra < 3) d = compare(a as never, c as never);
					if (d !== 0) return k.desc ? -d : d;
				}
				return x.i - y.i;
			});
		const edits: (CellRef & { input: CellInput | null })[] = [];
		const styles: [number, number, number][] = [];
		order.forEach(({ row }, i) => {
			const r = top + i;
			row.cells.forEach((cell, k) => {
				const col = area.left + k;
				let input: CellInput | null = null;
				if (cell?.formula?.ast)
					input = { formula: print(translateFormula(cell.formula.ast, r - row.from, 0)) };
				else if (cell && cell.value !== null) input = { value: cell.value };
				edits.push({ sheet, row: r, col, input });
				styles.push([r, col, cell?.style ?? 0]);
			});
		});
		const changes = e.setMany(edits);
		for (const [r, c, s] of styles) e.setStyle(sheet, r, c, s);
		return { changed: changes.cells };
	}

	/** A full recalculation, as Excel's. */
	recalc(): EditResult {
		return { changed: this.#b.engine.recalc().cells };
	}

	/** What the file holds, the notice for it, and what moving rows and columns leaves behind. */
	census(): { census: Census; notice: SheetNotice; fixedRanges: string[] } {
		return {
			census: this.#census,
			notice: sheetNoticeOf(this.#format, this.#census),
			fixedRanges: this.#fixed
		};
	}

	/** What saving in another format would drop, for the warning before it. */
	lostOnSave(format: SheetSaveFormat): string[] {
		return lostOnSave(this.#b, format);
	}

	/**
	 * The file to upload: into the opened bytes when the format is the same, so what
	 * was not edited stays as it was. CSV and TSV save `sheet` (by id), the first by
	 * default. An `.xls` saves as `.xlsx`.
	 */
	async save(
		format?: SheetSaveFormat,
		sheet?: number
	): Promise<{ bytes: Uint8Array; format: SheetSaveFormat }> {
		const to = format ?? sheetSaveFormatOf(this.#format);
		const bytes = await writeSpreadsheet(to, this.#b, {
			original: this.#bytes ? { bytes: this.#bytes, format: this.#format } : undefined,
			sheet
		});
		return transfer({ bytes, format: to }, [bytes.buffer as ArrayBuffer]);
	}

	/** The text of a file for search: each sheet's name and its cells as shown. Leaves the open workbook alone. */
	async text(bytes: Uint8Array, format: SheetFormat): Promise<string> {
		const { book } = await readSpreadsheet(bytes, format);
		let out = '';
		for (const info of book.ordered()) {
			out += `${book.engine.sheetName(info.id)}\n`;
			const cells = [...book.engine.cells(info.id)].sort((a, b) => a.row - b.row || a.col - b.col);
			let row = -1;
			for (const c of cells) {
				if (c.value === null || isError(c.value)) continue;
				out += (c.row !== row ? '\n' : '\t') + book.display(c);
				row = c.row;
				if (out.length > TEXT_LIMIT) return out.slice(0, TEXT_LIMIT);
			}
			out += '\n';
		}
		return out;
	}
}
