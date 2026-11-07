/**
 * `.ods`: OpenDocument spreadsheets, read into the workbook model and written
 * back keeping what was not edited as far as the format allows.
 *
 * OpenDocument stores runs: a row or cell repeated a thousand times is one
 * element. Writing splits a run only where something in it changed; the rest of
 * the run, and every row and cell element that did not change, is copied from
 * the source text. Cells carry no address, so a row moved by an insert is copied
 * as it is. Formulas are OpenFormula (`of:=SUM([.A1:.A3])`), converted to and
 * from the engine's syntax. Styles are named in the file; new ones are added as
 * automatic styles with a `yd` prefix. Charts, pictures, comments and macros
 * stay in the package untouched; named ranges, validations, conditional formats
 * and data pilots keep their old ranges when rows or columns move.
 */
import { MAX_COLS, MAX_ROWS, type Area } from '$lib/formula/address';
import { print, quoteSheet } from '$lib/formula/ast';
import { dateSerial, serialToYmd } from '$lib/formula/dates';
import { Engine, type Cell } from '$lib/formula/engine';
import { isDateFormat } from '$lib/formula/numfmt';
import {
	err,
	isError,
	isErrorCode,
	sameValue,
	type ErrorCode,
	type Scalar
} from '$lib/formula/values';
import { Tally } from './model';
import { partText } from './ooxml';
import {
	Book,
	currentOf,
	runPieces,
	type AxisStep,
	type CellStyle,
	type ColInfo,
	type Edge,
	type OpenedSheets,
	type SheetInfo
} from './workbook';
import { escapeAttr, escapeXml, findSpans, kids, parseXml, tokenize, type XElement } from './xml';
import { readZip, writeZip, ZIP_LIMITS, type ZipLimits } from './zip';

export class OdsError extends Error {}

export const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';
export const ODS_LIMITS = { cells: 2_000_000, styles: 20_000, text: 32767 };

// Formulas.

/**
 * OpenFormula as the engine's syntax: `[.A1:.B2]` as `A1:B2`, `[$Other.C3]` as
 * `Other!C3`, `;` as `,`. Formulas in other namespaces stay as they are.
 */
export function odfToExcel(formula: string): string {
	const m = /^(?:of:|msoxl:)?=?/.exec(formula)!;
	const ns = /^(\w+):/.exec(formula)?.[1];
	let s = formula.slice(m[0].length);
	if (ns === 'msoxl') return s;
	if (ns && ns !== 'of') return formula;
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '"') {
			const j = s.indexOf('"', i + 1);
			let end = j < 0 ? s.length : j;
			while (s[end + 1] === '"')
				end = s.indexOf('"', end + 2) < 0 ? s.length : s.indexOf('"', end + 2);
			out += s.slice(i, end + 1);
			i = end;
		} else if (c === '[') {
			const j = s.indexOf(']', i);
			if (j < 0) return formula;
			out += refToExcel(s.slice(i + 1, j));
			i = j;
		} else if (c === ';') out += ',';
		else out += c;
	}
	s = out.replace(/\bCOM\.MICROSOFT\./gi, '');
	return s;
}

function refToExcel(ref: string): string {
	const parts = ref.split(':');
	let sheet: string | undefined;
	const conv = parts.map((p) => {
		const m = /^(\$?(?:'(?:[^']|'')*'|[^.]*))?\.(.*)$/.exec(p);
		if (!m) return p;
		const sh = m[1] ? m[1].replace(/^\$/, '') : '';
		if (sh) sheet = sh.startsWith("'") ? sh.slice(1, -1).replace(/''/g, "'") : sh;
		return m[2];
	});
	if (conv.some((p) => p.includes('#REF!'))) return '#REF!';
	return `${sheet !== undefined ? `${quoteSheet(sheet)}!` : ''}${conv.join(':')}`;
}

// Styles.

interface Props {
	text?: Record<string, string>;
	cell?: Record<string, string>;
	para?: Record<string, string>;
	data?: string;
	parent?: string;
}

interface OdsStyles {
	list: CellStyle[];
	/** The file's style name of each style id; id 0 is the default and has none. */
	names: (string | undefined)[];
	byName: Map<string, number>;
	colWidths: Map<string, number>;
	rowHeights: Map<string, number>;
	dataStyles: Map<string, string>;
}

/** A length as points: `2.258cm`, `0.889in`, `64pt`, `12mm`. */
function points(v: string | undefined): number | undefined {
	const m = /^(-?[\d.]+)(cm|mm|in|pt|pc|px)?$/.exec(v ?? '');
	if (!m) return undefined;
	const n = Number(m[1]);
	const k = { cm: 72 / 2.54, mm: 72 / 25.4, in: 72, pt: 1, pc: 12, px: 0.75 }[m[2] ?? 'pt'] ?? 1;
	return n * k;
}

/** Column widths are characters in the model: seven pixels each, at 96 per inch. */
const charsOfPoints = (pt: number) => Math.round(((pt * 96) / 72 / 7) * 100) / 100;
const pointsOfChars = (ch: number) => (ch * 7 * 72) / 96;

function edgeOf(v: string | undefined): Edge | undefined {
	if (!v || v === 'none') return undefined;
	const parts = v.split(/\s+/);
	const width = points(parts.find((p) => /^[\d.]+(cm|mm|in|pt|px)$/.test(p))) ?? 0.75;
	const kind =
		parts.find((p) => /^(solid|dashed|dotted|double|dash-dot|dash-dot-dot|fine-dashed)$/.test(p)) ??
		'solid';
	const color = parts.find((p) => /^#[0-9a-f]{6}$/i.test(p));
	const style =
		kind === 'double'
			? 'double'
			: kind === 'dotted'
				? 'dotted'
				: kind.includes('dash')
					? 'dashed'
					: width > 1.8
						? 'thick'
						: width > 0.9
							? 'medium'
							: 'thin';
	return color ? { style, color: color.toLowerCase() } : { style };
}

function styleOf(p: Props, dataStyles: Map<string, string>): CellStyle {
	const s: CellStyle = {
		numFmt: (p.data && dataStyles.get(p.data)) || 'General',
		font: {},
		border: {},
		align: {}
	};
	const t = p.text ?? {};
	if (t['fo:font-weight'] === 'bold' || Number(t['fo:font-weight']) >= 600) s.font.bold = true;
	if (t['fo:font-style'] === 'italic' || t['fo:font-style'] === 'oblique') s.font.italic = true;
	if (t['style:text-underline-style'] && t['style:text-underline-style'] !== 'none')
		s.font.underline = true;
	if (t['style:text-line-through-style'] && t['style:text-line-through-style'] !== 'none')
		s.font.strike = true;
	if (/^#[0-9a-f]{6}$/i.test(t['fo:color'] ?? '')) s.font.color = t['fo:color'].toLowerCase();
	const size = points(t['fo:font-size']);
	if (size && size > 0 && size < 1000) s.font.size = size;
	if (t['style:font-name']) s.font.name = t['style:font-name'];
	const c = p.cell ?? {};
	if (/^#[0-9a-f]{6}$/i.test(c['fo:background-color'] ?? ''))
		s.fill = c['fo:background-color'].toLowerCase();
	for (const side of ['top', 'right', 'bottom', 'left'] as const) {
		const e = edgeOf(c[`fo:border-${side}`] ?? c['fo:border']);
		if (e) s.border[side] = e;
	}
	if (c['fo:wrap-option'] === 'wrap') s.align.wrap = true;
	const va = c['style:vertical-align'];
	if (va === 'top') s.align.v = 'top';
	else if (va === 'middle') s.align.v = 'center';
	const ta = p.para?.['fo:text-align'];
	if (ta === 'center') s.align.h = 'center';
	else if (ta === 'end' || ta === 'right') s.align.h = 'right';
	else if (ta === 'start' || ta === 'left') s.align.h = 'left';
	else if (ta === 'justify') s.align.h = 'justify';
	return s;
}

const quoteLit = (t: string) =>
	t === '' ? '' : /^[-/:., ()]+$/.test(t) ? t : `"${t.replace(/"/g, '')}"`;

/** A digit count from a data style, within what a format code shows (Excel's 30 decimals). */
const digits = (v: string | undefined, fallback: number) => {
	const n = Math.trunc(Number(v ?? fallback));
	return Number.isFinite(n) ? Math.min(Math.max(n, 0), 30) : fallback;
};

/** A data style as an Excel format code, as well as the two can be matched. */
function codeOfDataStyle(el: XElement, all: Map<string, XElement>, depth = 0): string {
	const kind = el.name.slice(el.name.indexOf(':') + 1);
	const body = (e: XElement): string => {
		let out = '';
		for (const k of kids(e)) {
			const n = k.name.slice(k.name.indexOf(':') + 1);
			const a = k.attrs;
			const long = a['number:style'] === 'long';
			switch (n) {
				case 'number': {
					const dec = digits(a['number:decimal-places'], 0);
					const minDec = digits(a['number:min-decimal-places'], dec);
					const minInt = digits(a['number:min-integer-digits'], 1);
					let int = '0'.repeat(Math.max(minInt, 0)) || '#';
					if (a['number:grouping'] === 'true')
						int = int.length >= 4 ? int : `#,${'#'.repeat(Math.max(0, 3 - int.length))}${int}`;
					out +=
						int + (dec > 0 ? `.${'0'.repeat(minDec)}${'#'.repeat(Math.max(0, dec - minDec))}` : '');
					break;
				}
				case 'scientific-number': {
					const dec = digits(a['number:decimal-places'], 2);
					out += `0${dec > 0 ? `.${'0'.repeat(dec)}` : ''}E+${'0'.repeat(digits(a['number:min-exponent-digits'], 2))}`;
					break;
				}
				case 'fraction': {
					const den = a['number:denominator-value'];
					out += `# ${'?'.repeat(digits(a['number:min-numerator-digits'], 1))}/${den ?? '?'.repeat(digits(a['number:min-denominator-digits'], 1))}`;
					break;
				}
				case 'text': {
					const t =
						kids(k).length === 0 ? k.children.map((c) => ('text' in c ? c.text : '')).join('') : '';
					out += kind === 'percentage-style' && t.includes('%') ? t.replace('%', '%') : quoteLit(t);
					break;
				}
				case 'currency-symbol':
					out += `"${k.children.map((c) => ('text' in c ? c.text : '')).join('')}"`;
					break;
				case 'text-content':
					out += '@';
					break;
				case 'day':
					out += long ? 'dd' : 'd';
					break;
				case 'day-of-week':
					out += long ? 'dddd' : 'ddd';
					break;
				case 'month':
					out += a['number:textual'] === 'true' ? (long ? 'mmmm' : 'mmm') : long ? 'mm' : 'm';
					break;
				case 'year':
					out += long ? 'yyyy' : 'yy';
					break;
				case 'hours':
					out +=
						kind === 'time-style' && el.attrs['number:truncate-on-overflow'] === 'false'
							? '[h]'
							: long
								? 'hh'
								: 'h';
					break;
				case 'minutes':
					out += long ? 'mm' : 'm';
					break;
				case 'seconds': {
					const dec = digits(a['number:decimal-places'], 0);
					out += (long ? 'ss' : 's') + (dec > 0 ? `.${'0'.repeat(dec)}` : '');
					break;
				}
				case 'am-pm':
					out += 'AM/PM';
					break;
				case 'boolean':
					out += 'General';
					break;
			}
		}
		return out || 'General';
	};
	const main = body(el);
	const maps = kids(el).filter((k) => k.name === 'style:map');
	if (maps.length === 0 || depth > 2) return main;
	const mapped = maps.map((m) => {
		const target = all.get(m.attrs['style:apply-style-name'] ?? '');
		return {
			cond: m.attrs['style:condition'] ?? '',
			code: target ? codeOfDataStyle(target, all, depth + 1) : 'General'
		};
	});
	if (mapped.length === 1 && /value\(\)\s*>=\s*0$/.test(mapped[0].cond))
		return `${mapped[0].code};${main.replace(/^"-"|^-/, '')}`;
	if (
		mapped.length === 2 &&
		/value\(\)\s*>\s*0$/.test(mapped[0].cond) &&
		/value\(\)\s*<\s*0$/.test(mapped[1].cond)
	) {
		return `${mapped[0].code};${mapped[1].code.replace(/^"-"|^-/, '')};${main}`;
	}
	return main;
}

function readOdsStyles(content: string, stylesXml: string | null): OdsStyles {
	const props = new Map<string, Props>();
	const colWidths = new Map<string, number>();
	const rowHeights = new Map<string, number>();
	const dataEls = new Map<string, XElement>();
	let base: Props = {};
	const collect = (xml: string, container: string) => {
		for (const span of findSpans(xml, (n) => n === container)) {
			const root = parseXml(xml.slice(span.start, span.end));
			if (kids(root).length > ODS_LIMITS.styles) throw new OdsError('too many styles');
			for (const s of kids(root)) {
				const name = s.attrs['style:name'];
				if (s.name.startsWith('number:') && name) {
					dataEls.set(name, s);
					continue;
				}
				const family = s.attrs['style:family'];
				const p: Props = {
					text: kids(s, 'style:text-properties')[0]?.attrs,
					cell: kids(s, 'style:table-cell-properties')[0]?.attrs,
					para: kids(s, 'style:paragraph-properties')[0]?.attrs,
					data: s.attrs['style:data-style-name'],
					parent: s.attrs['style:parent-style-name']
				};
				if (s.name === 'style:default-style' && family === 'table-cell') base = p;
				else if (s.name === 'style:style' && name) {
					if (family === 'table-cell') props.set(name, p);
					else if (family === 'table-column') {
						const w = points(
							kids(s, 'style:table-column-properties')[0]?.attrs['style:column-width']
						);
						if (w !== undefined) colWidths.set(name, charsOfPoints(w));
					} else if (family === 'table-row') {
						const rp = kids(s, 'style:table-row-properties')[0]?.attrs;
						const h = points(rp?.['style:row-height']);
						if (h !== undefined && rp?.['style:use-optimal-row-height'] !== 'true')
							rowHeights.set(name, Math.round(h * 100) / 100);
					}
				}
			}
		}
	};
	if (stylesXml) {
		collect(stylesXml, 'office:styles');
		collect(stylesXml, 'office:automatic-styles');
	}
	collect(content, 'office:automatic-styles');
	const dataStyles = new Map<string, string>();
	for (const [name, el] of dataEls) dataStyles.set(name, codeOfDataStyle(el, dataEls));
	const resolve = (name: string, depth = 0): Props => {
		const p = props.get(name);
		if (!p || depth > 16) return base;
		const parent = p.parent ? resolve(p.parent, depth + 1) : base;
		return {
			text: { ...parent.text, ...p.text },
			cell: { ...parent.cell, ...p.cell },
			para: { ...parent.para, ...p.para },
			data: p.data ?? parent.data
		};
	};
	// The style named Default is what a cell without one shows: style id 0.
	const list: CellStyle[] = [styleOf(props.has('Default') ? resolve('Default') : base, dataStyles)];
	const names: (string | undefined)[] = [undefined];
	const byName = new Map<string, number>([['Default', 0]]);
	for (const name of props.keys()) {
		if (name === 'Default') continue;
		byName.set(name, list.length);
		list.push(styleOf(resolve(name), dataStyles));
		names.push(name);
	}
	return { list, names, byName, colWidths, rowHeights, dataStyles };
}

// Content.

interface OCell {
	col: number;
	repeat: number;
	start: number;
	end: number;
	covered: boolean;
	style?: string;
	value: Scalar;
	/** In the engine's syntax. */
	formula?: string;
	colSpan: number;
	rowSpan: number;
	/** A value, a formula or text. */
	content: boolean;
}

interface ORow {
	row: number;
	repeat: number;
	start: number;
	end: number;
	tagEnd: number;
	selfClosing: boolean;
	style?: string;
	defaultCellStyle?: string;
	cells: OCell[];
}

interface OCol {
	col: number;
	repeat: number;
	start: number;
	end: number;
	style?: string;
	defaultCellStyle?: string;
	hidden: boolean;
}

interface OTable {
	name: string;
	start: number;
	end: number;
	tagEnd: number;
	rows: ORow[];
	cols: OCol[];
	/** Where table columns end, for writing them anew. */
	colsStart: number;
	colsEnd: number;
}

interface Scan {
	tables: OTable[];
	date1904: boolean;
	counts: Map<string, number>;
}

function isoSerial(v: string, date1904: boolean): number | null {
	const m = /^(-?\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?))?/.exec(v);
	if (!m) return null;
	const day = dateSerial(+m[1], +m[2], +m[3], date1904);
	if (day === null) return null;
	return day + (m[4] ? (+m[4] * 3600 + +m[5] * 60 + +m[6]) / 86400 : 0);
}

function durationDays(v: string): number | null {
	const m = /^(-)?P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(v);
	if (!m) return null;
	const d = (+(m[2] ?? 0) * 86400 + +(m[3] ?? 0) * 3600 + +(m[4] ?? 0) * 60 + +(m[5] ?? 0)) / 86400;
	return m[1] ? -d : d;
}

const COUNTED: Record<string, string> = {
	'draw:object': 'Chart or embedded object',
	'draw:image': 'Picture',
	'office:annotation': 'Comment',
	'table:named-range': 'Named range',
	'table:named-expression': 'Named range',
	'table:content-validation': 'Data validation',
	'calcext:conditional-format': 'Conditional formatting',
	'table:data-pilot-table': 'Data pilot table',
	'table:database-range': 'Filter or database range',
	'table:scenario': 'Scenario',
	'office:forms': 'Form'
};

function scanContent(xml: string, budget: { cells: number }): Scan {
	const scan: Scan = { tables: [], date1904: false, counts: new Map() };
	let table: OTable | null = null;
	let row: ORow | null = null;
	let cell: (OCell & { attrs: Record<string, string> }) | null = null;
	let nextRow = 0;
	let nextCol = 0;
	let colCursor = 0;
	let paras: string[] = [];
	let inP = 0;
	let annotation = 0;
	for (const t of tokenize(xml)) {
		if (t.type === 'start') {
			const n = t.name;
			if (COUNTED[n] && !(n === 'office:forms' && t.selfClosing))
				scan.counts.set(COUNTED[n], (scan.counts.get(COUNTED[n]) ?? 0) + 1);
			if (n === 'table:null-date' && /^1904-01-01/.test(t.attrs['table:date-value'] ?? ''))
				scan.date1904 = true;
			if (n === 'office:annotation' && !t.selfClosing) annotation++;
			if (annotation > 0) continue;
			if (n === 'table:table') {
				table = {
					name: t.attrs['table:name'] ?? `Sheet${scan.tables.length + 1}`,
					start: t.start,
					end: t.end,
					tagEnd: t.end,
					rows: [],
					cols: [],
					colsStart: -1,
					colsEnd: -1
				};
				scan.tables.push(table);
				nextRow = 0;
				colCursor = 0;
			} else if (
				table &&
				/^table:(table-columns|table-header-columns|table-column-group)$/.test(n)
			) {
				if (table.colsStart < 0) table.colsStart = t.start;
			} else if (n === 'table:table-column' && table) {
				const repeat = Math.min(
					Math.max(1, Number(t.attrs['table:number-columns-repeated'] ?? 1) || 1),
					MAX_COLS
				);
				if (table.colsStart < 0) table.colsStart = t.start;
				table.cols.push({
					col: colCursor,
					repeat,
					start: t.start,
					end: t.end,
					style: t.attrs['table:style-name'],
					defaultCellStyle: t.attrs['table:default-cell-style-name'],
					hidden: t.attrs['table:visibility'] === 'collapse'
				});
				colCursor = Math.min(colCursor + repeat, MAX_COLS);
			} else if (n === 'table:table-row' && table) {
				const repeat = Math.min(
					Math.max(1, Number(t.attrs['table:number-rows-repeated'] ?? 1) || 1),
					MAX_ROWS
				);
				row = {
					row: nextRow,
					repeat,
					start: t.start,
					end: t.end,
					tagEnd: t.end,
					selfClosing: t.selfClosing,
					style: t.attrs['table:style-name'],
					defaultCellStyle: t.attrs['table:default-cell-style-name'],
					cells: []
				};
				table.rows.push(row);
				nextRow = Math.min(nextRow + repeat, MAX_ROWS);
				nextCol = 0;
				if (t.selfClosing) row = null;
			} else if ((n === 'table:table-cell' || n === 'table:covered-table-cell') && row) {
				const repeat = Math.min(
					Math.max(1, Number(t.attrs['table:number-columns-repeated'] ?? 1) || 1),
					MAX_COLS
				);
				cell = {
					col: nextCol,
					repeat,
					start: t.start,
					end: t.end,
					covered: n === 'table:covered-table-cell',
					style: t.attrs['table:style-name'],
					value: null,
					colSpan: Math.max(1, Number(t.attrs['table:number-columns-spanned'] ?? 1) || 1),
					rowSpan: Math.max(1, Number(t.attrs['table:number-rows-spanned'] ?? 1) || 1),
					content: false,
					attrs: t.attrs
				};
				row.cells.push(cell);
				nextCol = Math.min(nextCol + repeat, MAX_COLS);
				paras = [];
				if (t.selfClosing) {
					finishCell(cell, paras);
					cell = null;
				}
			} else if (n === 'text:p' && cell) {
				inP++;
				paras.push('');
			} else if (cell && inP > 0) {
				const last = paras.length - 1;
				if (n === 'text:s')
					paras[last] += ' '.repeat(Math.min(Number(t.attrs['text:c'] ?? 1) || 1, 1000));
				else if (n === 'text:tab') paras[last] += '\t';
				else if (n === 'text:line-break') paras[last] += '\n';
			}
		} else if (t.type === 'end') {
			const n = t.name;
			if (n === 'office:annotation') {
				annotation--;
				continue;
			}
			if (annotation > 0) continue;
			if (n === 'text:p' && cell) inP--;
			else if ((n === 'table:table-cell' || n === 'table:covered-table-cell') && cell) {
				cell.end = t.end;
				finishCell(cell, paras);
				cell = null;
			} else if (n === 'table:table-row' && row) {
				row.end = t.end;
				row = null;
			} else if (n === 'table:table' && table) {
				table.end = t.end;
				table = null;
			} else if (
				table &&
				/^table:(table-columns|table-header-columns|table-column-group)$/.test(n)
			) {
				table.colsEnd = t.end;
			}
		} else if (t.type === 'text' && cell && inP > 0 && annotation === 0) {
			paras[paras.length - 1] += t.text;
			if (paras[paras.length - 1].length > ODS_LIMITS.text) throw new OdsError('text too long');
		}
		if (t.type === 'start' && t.name === 'table:table-column' && t.selfClosing && table)
			table.colsEnd = t.end;
		if (t.type === 'end' && t.name === 'table:table-column' && table) table.colsEnd = t.end;
	}
	return scan;

	function finishCell(c: OCell & { attrs: Record<string, string> }, ps: string[]) {
		const a = c.attrs;
		const type = a['office:value-type'] ?? a['calcext:value-type'];
		const text = ps.join('\n');
		if (a['table:formula'] !== undefined) c.formula = odfToExcel(a['table:formula']);
		switch (type) {
			case 'float':
			case 'percentage':
			case 'currency': {
				const n = Number(a['office:value']);
				c.value = Number.isFinite(n) ? n : null;
				break;
			}
			case 'date':
				c.value = isoSerial(a['office:date-value'] ?? '', scan.date1904);
				break;
			case 'time':
				c.value = durationDays(a['office:time-value'] ?? '');
				break;
			case 'boolean':
				c.value = a['office:boolean-value'] === 'true';
				break;
			case 'error': {
				const code = text.trim().toUpperCase();
				c.value = isErrorCode(code) ? err(code as ErrorCode) : err('#VALUE!');
				break;
			}
			case 'string':
				c.value = a['office:string-value'] ?? text;
				break;
			default:
				c.value = text === '' ? null : text;
		}
		if (a['calcext:value-type'] === 'error' && type !== 'error') {
			const code = text.trim().toUpperCase();
			if (isErrorCode(code)) c.value = err(code as ErrorCode);
		}
		c.content = c.value !== null || c.formula !== undefined;
		if (c.content) {
			// A cell stands for itself on every row its row repeats over.
			budget.cells -= c.repeat * (row?.repeat ?? 1);
			if (budget.cells < 0) throw new OdsError('too many cells');
		}
	}
}

/** The style a cell shows: its own, else its row's, else its column's default. */
function effectiveStyle(c: OCell, r: ORow, t: OTable, col: number): string | undefined {
	if (c.style) return c.style;
	if (r.defaultCellStyle) return r.defaultCellStyle;
	const k = t.cols.find((x) => col >= x.col && col < x.col + x.repeat);
	return k?.defaultCellStyle;
}

export async function readOds(
	bytes: Uint8Array,
	limits: ZipLimits = ZIP_LIMITS
): Promise<OpenedSheets> {
	const zip = readZip(bytes, limits);
	const content = await partText(zip, 'content.xml');
	if (content === null) throw new OdsError('no content');
	const stylesXml = await partText(zip, 'styles.xml');
	const styles = readOdsStyles(content, stylesXml);
	const scan = scanContent(content, { cells: ODS_LIMITS.cells });
	const engine = new Engine({ date1904: scan.date1904 });
	const book = new Book(engine, styles.list, {
		format: 'ods',
		styles: styles.list.length,
		sheets: scan.tables.length
	});
	const idOf = (name: string | undefined) =>
		name === undefined ? 0 : (styles.byName.get(name) ?? 0);
	const uncached: Cell[] = [];
	let unsupported = 0;
	// Every cell loaded, styled empty ones too, against the cap of the whole file.
	let loadBudget = ODS_LIMITS.cells;
	for (const [origin, t] of scan.tables.entries()) {
		let name = t.name;
		for (let k = 2; engine.sheetByName(name); k++) name = `${t.name} (${k})`;
		const info = book.addSheet(name, undefined, origin);
		info.cols = colInfos(t, styles, idOf);
		for (const r of t.rows) {
			const h = r.style ? styles.rowHeights.get(r.style) : undefined;
			if (h !== undefined && r.repeat <= 1000)
				for (let k = 0; k < r.repeat; k++) info.rows.set(r.row + k, { height: h });
			for (const c of r.cells) {
				if (c.colSpan > 1 || c.rowSpan > 1) {
					for (let k = 0; k < Math.min(c.repeat, 100); k++) {
						info.merges.push({
							top: r.row,
							left: c.col + k,
							bottom: Math.min(r.row + c.rowSpan - 1, MAX_ROWS - 1),
							right: Math.min(c.col + k + c.colSpan - 1, MAX_COLS - 1)
						});
					}
				}
				const style = idOf(effectiveStyle(c, r, t, c.col));
				const small = r.repeat * c.repeat <= 1000;
				if (!c.content && (style === 0 || !small || c.covered)) continue;
				loadBudget -= r.repeat * c.repeat;
				if (loadBudget < 0) throw new OdsError('too many cells');
				for (let dr = 0; dr < r.repeat; dr++) {
					for (let dc = 0; dc < c.repeat; dc++) {
						const cell = engine.load(info.id, r.row + dr, c.col + dc, {
							value: c.value,
							formula: c.formula,
							style
						});
						if (c.formula !== undefined && c.value === null) uncached.push(cell);
					}
				}
			}
		}
	}
	engine.loaded(uncached);
	for (const s of book.sheets)
		for (const c of engine.cells(s.id)) if (c.formula && c.formula.status !== 'ok') unsupported++;
	const tally = new Tally();
	for (const [label, n] of scan.counts) tally.add(label, 'kept', n);
	const entries = zip.entries.map((e) => e.name);
	const macros = entries.filter((n) => /^(Basic|Scripts)\//.test(n)).length;
	if (macros > 0) tally.add('Macros', 'kept', macros);
	if (unsupported > 0) tally.add('Formula not calculated here', 'locked', unsupported);
	const fixedRanges = [
		'Chart or embedded object',
		'Named range',
		'Data validation',
		'Conditional formatting',
		'Data pilot table',
		'Filter or database range'
	].filter((l) => scan.counts.has(l));
	return { book, census: tally.census(), fixedRanges };
}

function colInfos(
	t: OTable,
	styles: OdsStyles,
	idOf: (n: string | undefined) => number
): ColInfo[] {
	const out: ColInfo[] = [];
	for (const c of t.cols) {
		const width = c.style ? styles.colWidths.get(c.style) : undefined;
		const style =
			c.defaultCellStyle && c.defaultCellStyle !== 'Default' ? idOf(c.defaultCellStyle) : 0;
		if (width === undefined && !c.hidden && style === 0) continue;
		const info: ColInfo = { min: c.col, max: Math.min(c.col + c.repeat - 1, MAX_COLS - 1) };
		if (width !== undefined) info.width = width;
		if (c.hidden) info.hidden = true;
		if (style) info.style = style;
		out.push(info);
	}
	return out;
}

// Writing.

/** A data style for a format code; null for General or what has no counterpart here. */
function dataStyleXml(name: string, code: string): string | null {
	if (code === 'General') return null;
	const first = code.split(';')[0];
	if (first === '@')
		return `<number:text-style style:name="${name}"><number:text-content/></number:text-style>`;
	if (isDateFormat(first)) {
		const parts: string[] = [];
		const re =
			/("[^"]*"|\\.|\[h+\]|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss(?:\.0+)?|s(?:\.0+)?|AM\/PM|am\/pm|A\/P|.)/gi;
		const toks = first.match(re) ?? [];
		const isDate = toks.some((x) => /^[yd]/i.test(x) || /^m{3,}$/i.test(x));
		let afterHour = false;
		let truncate = true;
		toks.forEach((tk, i) => {
			const low = tk.toLowerCase();
			const nextS = toks
				.slice(i + 1)
				.find((x) => /^[a-z[]/i.test(x))
				?.toLowerCase()
				.startsWith('s');
			const long = (s: string) => (s.length > 1 ? ' number:style="long"' : '');
			if (low.startsWith('"'))
				parts.push(`<number:text>${escapeXml(tk.slice(1, -1))}</number:text>`);
			else if (low.startsWith('\\'))
				parts.push(`<number:text>${escapeXml(tk.slice(1))}</number:text>`);
			else if (low.startsWith('[h')) {
				truncate = false;
				parts.push('<number:hours/>');
				afterHour = true;
				return;
			} else if (low.startsWith('y'))
				parts.push(`<number:year${long(low === 'yyyy' ? 'yy' : 'y')}/>`);
			else if (low.startsWith('d'))
				parts.push(
					low.length >= 3
						? `<number:day-of-week${low.length > 3 ? ' number:style="long"' : ''}/>`
						: `<number:day${long(low)}/>`
				);
			else if (low.startsWith('h')) {
				parts.push(`<number:hours${long(low)}/>`);
				afterHour = true;
				return;
			} else if (low.startsWith('m')) {
				if (low.length <= 2 && (afterHour || nextS)) parts.push(`<number:minutes${long(low)}/>`);
				else if (low.length >= 3)
					parts.push(
						`<number:month number:textual="true"${low.length > 3 ? ' number:style="long"' : ''}/>`
					);
				else parts.push(`<number:month${long(low)}/>`);
			} else if (low.startsWith('s')) {
				const dec = /\.(0+)/.exec(low)?.[1].length ?? 0;
				parts.push(
					`<number:seconds${long(low.replace(/\..*/, ''))}${dec ? ` number:decimal-places="${dec}"` : ''}/>`
				);
			} else if (low === 'am/pm' || low === 'a/p') parts.push('<number:am-pm/>');
			else parts.push(`<number:text>${escapeXml(tk)}</number:text>`);
			afterHour = false;
		});
		const tag = isDate ? 'number:date-style' : 'number:time-style';
		return `<${tag} style:name="${name}"${!isDate && !truncate ? ' number:truncate-on-overflow="false"' : ''}>${parts.join('')}</${tag}>`;
	}
	const m = /^(.*?)([#0,]*0[#0,]*|#+)(?:\.(0*)(#*))?(.*)$/.exec(first.replace(/_.|\*./g, ''));
	if (!m) return null;
	const lit = (s: string) =>
		s
			.replace(/"([^"]*)"/g, '$1')
			.replace(/\\(.)/g, '$1')
			.replace(/[[\]]/g, '');
	const pre = lit(m[1]);
	const post = lit(m[5]);
	const percent = post.includes('%');
	const grouping = m[2].includes(',');
	const minInt = (m[2].match(/0/g) ?? []).length;
	const dec = (m[3] ?? '').length + (m[4] ?? '').length;
	const num = `<number:number number:decimal-places="${dec}" number:min-decimal-places="${(m[3] ?? '').length}" number:min-integer-digits="${minInt}"${grouping ? ' number:grouping="true"' : ''}/>`;
	const currency = /[$€£¥]/.exec(pre + post)?.[0];
	const text = (s: string) => (s ? `<number:text>${escapeXml(s)}</number:text>` : '');
	if (percent)
		return `<number:percentage-style style:name="${name}">${text(pre)}${num}<number:text>%</number:text></number:percentage-style>`;
	if (currency) {
		const before = pre.includes(currency);
		const sym = `<number:currency-symbol>${escapeXml(currency)}</number:currency-symbol>`;
		return `<number:currency-style style:name="${name}">${before ? sym : ''}${num}${before ? '' : sym}</number:currency-style>`;
	}
	return `<number:number-style style:name="${name}">${text(pre)}${num}${text(post)}</number:number-style>`;
}

function edgeXml(e: Edge | undefined): string {
	if (!e) return 'none';
	const w =
		{ thin: '0.75pt', medium: '1.5pt', thick: '2.5pt', double: '2.25pt' }[e.style] ?? '0.75pt';
	const kind =
		e.style === 'double'
			? 'double'
			: e.style === 'dotted'
				? 'dotted'
				: e.style.includes('dash')
					? 'dashed'
					: 'solid';
	return `${w} ${kind} ${e.color ?? '#000000'}`;
}

/** New automatic styles for a save, named `yd…` so they cannot clash with the file's. */
class OdsStyleWriter {
	readonly xml: string[] = [];
	readonly #cell = new Map<number, string>();
	readonly #col = new Map<string, string>();
	readonly #row = new Map<number, string>();
	readonly #data = new Map<string, string | null>();
	#n = 1;

	constructor(
		readonly book: Book,
		readonly styles: OdsStyles,
		readonly same: boolean,
		readonly taken: (name: string) => boolean
	) {}

	#name(prefix: string): string {
		let n: string;
		do n = `${prefix}${this.#n++}`;
		while (this.taken(n));
		return n;
	}

	/** The style name to write for a style id; undefined for the default. */
	cell(id: number): string | undefined {
		if (id === 0) return undefined;
		if (this.same && id < this.book.source.styles) return this.styles.names[id];
		const found = this.#cell.get(id);
		if (found) return found;
		const s = this.book.styles[id] ?? this.book.styles[0];
		const name = this.#name('ydce');
		let data = '';
		if (s.numFmt !== 'General') {
			let dn = this.#data.get(s.numFmt);
			if (dn === undefined) {
				const n = this.#name('ydN');
				const x = dataStyleXml(n, s.numFmt);
				if (x) this.xml.push(x);
				dn = x ? n : null;
				this.#data.set(s.numFmt, dn);
			}
			if (dn) data = ` style:data-style-name="${dn}"`;
		}
		const f = s.font;
		const text = [
			f.bold
				? 'fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"'
				: '',
			f.italic ? 'fo:font-style="italic"' : '',
			f.underline
				? 'style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"'
				: '',
			f.strike ? 'style:text-line-through-style="solid"' : '',
			f.color ? `fo:color="${f.color}"` : '',
			f.size ? `fo:font-size="${f.size}pt"` : '',
			f.name ? `style:font-name="${escapeAttr(f.name)}"` : ''
		].filter(Boolean);
		const b = s.border;
		const cellProps = [
			s.fill ? `fo:background-color="${s.fill}"` : '',
			b.top || b.right || b.bottom || b.left
				? `fo:border-top="${edgeXml(b.top)}" fo:border-right="${edgeXml(b.right)}" fo:border-bottom="${edgeXml(b.bottom)}" fo:border-left="${edgeXml(b.left)}"`
				: '',
			s.align.wrap ? 'fo:wrap-option="wrap"' : '',
			s.align.v
				? `style:vertical-align="${s.align.v === 'center' ? 'middle' : s.align.v === 'top' ? 'top' : 'bottom'}"`
				: ''
		].filter(Boolean);
		const h = s.align.h;
		const para =
			h && h !== 'general'
				? `<style:paragraph-properties fo:text-align="${h === 'left' ? 'start' : h === 'right' ? 'end' : h === 'center' ? 'center' : 'justify'}"/>`
				: '';
		this.xml.push(
			`<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="Default"${data}>` +
				(cellProps.length || h
					? `<style:table-cell-properties${h && h !== 'general' ? ' style:text-align-source="fix"' : ''} ${cellProps.join(' ')}/>`
					: '') +
				para +
				(text.length ? `<style:text-properties ${text.join(' ')}/>` : '') +
				'</style:style>'
		);
		this.#cell.set(id, name);
		return name;
	}

	column(width: number): string {
		const key = width.toFixed(2);
		for (const [name, w] of this.styles.colWidths) if (w.toFixed(2) === key) return name;
		const found = this.#col.get(key);
		if (found) return found;
		const name = this.#name('ydco');
		this.xml.push(
			`<style:style style:name="${name}" style:family="table-column"><style:table-column-properties fo:break-before="auto" style:column-width="${(pointsOfChars(width) / 72).toFixed(4)}in"/></style:style>`
		);
		this.#col.set(key, name);
		return name;
	}

	row(height: number): string {
		for (const [name, h] of this.styles.rowHeights) if (h === height) return name;
		const found = this.#row.get(height);
		if (found) return found;
		const name = this.#name('ydro');
		this.xml.push(
			`<style:style style:name="${name}" style:family="table-row"><style:table-row-properties style:row-height="${(height / 72).toFixed(4)}in" fo:break-before="auto" style:use-optimal-row-height="false"/></style:style>`
		);
		this.#row.set(height, name);
		return name;
	}
}

function textXml(s: string): string {
	return s
		.split('\n')
		.map((line) => {
			const body = escapeXml(line)
				.replace(/\t/g, '<text:tab/>')
				.replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`)
				.replace(/^ /, '<text:s/>');
			return `<text:p>${body}</text:p>`;
		})
		.join('');
}

function isoOf(serial: number, date1904: boolean): string {
	const ymd = serialToYmd(serial, date1904);
	if (!ymd || ymd.day === 0 || (!date1904 && Math.floor(serial) === 60)) return '';
	const secs = Math.round((serial - Math.floor(serial)) * 86400);
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	const date = `${p(ymd.year, 4)}-${p(ymd.month)}-${p(ymd.day)}`;
	return secs === 0
		? date
		: `${date}T${p(Math.floor(secs / 3600))}:${p(Math.floor((secs % 3600) / 60))}:${p(secs % 60)}`;
}

interface WriteCtx {
	book: Book;
	info: SheetInfo;
	styles: OdsStyleWriter;
	merges: Area[];
}

function cellXml(ctx: WriteCtx, row: number, col: number, repeat = 1): string {
	const { book, info } = ctx;
	const rep = repeat > 1 ? ` table:number-columns-repeated="${repeat}"` : '';
	const m = ctx.merges.find(
		(a) => row >= a.top && row <= a.bottom && col >= a.left && col <= a.right
	);
	if (m && (m.top !== row || m.left !== col)) return `<table:covered-table-cell${rep}/>`;
	const span = m
		? ` table:number-columns-spanned="${m.right - m.left + 1}" table:number-rows-spanned="${m.bottom - m.top + 1}"`
		: '';
	const c = book.engine.cell(info.id, row, col);
	if (!c) return `<table:table-cell${rep}${span}/>`;
	const styleName = ctx.styles.cell(c.style);
	let attrs = styleName ? ` table:style-name="${escapeAttr(styleName)}"` : '';
	if (c.formula) {
		const text = c.formula.ast ? `of:=${print(c.formula.ast, { mode: 'odf' })}` : c.formula.text;
		attrs += ` table:formula="${escapeAttr(text)}"`;
	}
	const v = c.value;
	let body = '';
	if (typeof v === 'number') {
		const fmt = book.styles[c.style]?.numFmt ?? 'General';
		const iso = isDateFormat(fmt) && v >= 1 ? isoOf(v, book.date1904) : '';
		attrs += iso
			? ` office:value-type="date" office:date-value="${iso}"`
			: ` office:value-type="${/%/.test(fmt.replace(/"[^"]*"/g, '')) ? 'percentage' : 'float'}" office:value="${v}"`;
		body = textXml(book.display(c));
	} else if (typeof v === 'boolean') {
		attrs += ` office:value-type="boolean" office:boolean-value="${v}"`;
		body = textXml(v ? 'TRUE' : 'FALSE');
	} else if (isError(v)) {
		attrs += ' office:value-type="string" office:string-value="" calcext:value-type="error"';
		body = textXml(v.error);
	} else if (typeof v === 'string') {
		attrs += ' office:value-type="string"';
		body = textXml(v);
	}
	return body
		? `<table:table-cell${rep}${attrs}${span}>${body}</table:table-cell>`
		: `<table:table-cell${rep}${attrs}${span}/>`;
}

const setRepeat = (tag: string, attr: string, n: number) => {
	const re = new RegExp(`\\s${attr}="[^"]*"`);
	const without = tag.replace(re, '');
	if (n <= 1) return without;
	const at = without.endsWith('/>') ? without.length - 2 : without.length - 1;
	return `${without.slice(0, at)} ${attr}="${n}"${without.slice(at)}`;
};

/** Where a current position came from, undoing a sheet's steps; null for one inserted since. */
function originOf(steps: readonly AxisStep[], axis: 'row' | 'col', pos: number): number | null {
	let p: number | null = pos;
	for (let i = steps.length - 1; i >= 0 && p !== null; i--) {
		const s = steps[i];
		if (s.axis !== axis) continue;
		if (s.count > 0) p = p < s.at ? p : p < s.at + s.count ? null : p - s.count;
		else p = p < s.at ? p : p - s.count;
	}
	return p;
}

function find<T extends { repeat: number }>(
	list: T[],
	pos: number,
	key: (x: T) => number
): T | undefined {
	let lo = 0;
	let hi = list.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const x = list[mid];
		if (pos < key(x)) hi = mid - 1;
		else if (pos >= key(x) + x.repeat) lo = mid + 1;
		else return x;
	}
	return undefined;
}

/** A table written into its source: rows and cells that did not change copied, runs split where they did. */
function patchTable(
	xml: string,
	t: OTable,
	info: SheetInfo,
	ctx: WriteCtx,
	styles: OdsStyles,
	sameStyles: boolean
): string | null {
	const { book } = ctx;
	const engine = book.engine;
	const steps = info.steps;
	const colSteps = steps.some((s) => s.axis === 'col');
	const origStyleId = (name: string | undefined) =>
		name === undefined ? 0 : sameStyles ? (styles.byName.get(name) ?? 0) : -1;
	const origMerges: Area[] = [];
	for (const r of t.rows)
		for (const c of r.cells)
			if (c.colSpan > 1 || c.rowSpan > 1)
				origMerges.push({
					top: r.row,
					left: c.col,
					bottom: r.row + c.rowSpan - 1,
					right: c.col + c.colSpan - 1
				});

	// Which current cells differ from the file, by row.
	const dirty = new Map<number, Set<number>>();
	const mark = (row: number, col: number) => {
		let s = dirty.get(row);
		if (!s) dirty.set(row, (s = new Set()));
		s.add(col);
	};
	const origAt = (row: number, col: number) => {
		const r = find(t.rows, row, (x) => x.row);
		const c = r && find(r.cells, col, (x) => x.col);
		return r && c ? { r, c } : undefined;
	};
	const same = (cell: Cell | undefined, o: { r: ORow; c: OCell } | undefined, col: number) => {
		if (!o || !o.c.content) {
			if (!cell) return true;
			return (
				cell.value === null &&
				!cell.formula &&
				cell.style === origStyleId(o ? effectiveStyle(o.c, o.r, t, col) : undefined)
			);
		}
		if (!cell) return false;
		return (
			cell.style === origStyleId(effectiveStyle(o.c, o.r, t, col)) &&
			(cell.formula?.text ?? undefined) === o.c.formula &&
			sameValue(cell.value, o.c.value)
		);
	};
	for (const c of engine.cells(info.id)) {
		const or = originOf(steps, 'row', c.row);
		const oc = originOf(steps, 'col', c.col);
		if (or === null || oc === null || !same(c, origAt(or, oc), oc)) mark(c.row, c.col);
	}
	for (const r of t.rows) {
		for (const c of r.cells) {
			if (!c.content) continue;
			for (let dr = 0; dr < r.repeat; dr++) {
				for (let dc = 0; dc < c.repeat; dc++) {
					const cur = currentOf(steps, r.row + dr, c.col + dc);
					if (cur && !same(engine.cell(info.id, cur.row, cur.col), { r, c }, c.col + dc))
						mark(cur.row, cur.col);
				}
			}
		}
	}
	const mergeKey = (a: Area) => `${a.top},${a.left},${a.bottom},${a.right}`;
	const nowMerges = new Set(info.merges.map(mergeKey));
	const moved = origMerges.map((m) => {
		const tl = currentOf(steps, m.top, m.left);
		const br = currentOf(steps, m.bottom, m.right);
		return tl && br ? { top: tl.row, left: tl.col, bottom: br.row, right: br.col } : null;
	});
	const wasMerges = new Set(moved.filter((m): m is Area => m !== null).map(mergeKey));
	for (const m of [
		...info.merges.filter((x) => !wasMerges.has(mergeKey(x))),
		...moved.filter((x): x is Area => x !== null && !nowMerges.has(mergeKey(x)))
	]) {
		for (let r = m.top; r <= Math.min(m.bottom, m.top + 1000); r++)
			for (let c = m.left; c <= Math.min(m.right, m.left + 1000); c++) mark(r, c);
	}
	const rowHeight = (r: ORow) => (r.style ? styles.rowHeights.get(r.style) : undefined);

	const colsChanged =
		colSteps ||
		t.cols.length === 0 ||
		JSON.stringify(info.cols.map((c) => [c.min, c.max, c.width ?? null, !!c.hidden])) !==
			JSON.stringify(
				colInfos(t, styles, (n) => (n ? (styles.byName.get(n) ?? 0) : 0)).map((c) => [
					c.min,
					c.max,
					c.width ?? null,
					!!c.hidden
				])
			);
	const extent = engine.extent(info.id);

	// Cells of a row, from its element in the file where there is one.
	const cellsOf = (src: ORow | null, row: number, dirtyCols: Set<number> | undefined): string => {
		let out = '';
		let next = 0;
		const blank = (from: number, to: number) => {
			let k = from;
			while (k < to) {
				let run = 1;
				const solo =
					engine.cell(info.id, row, k) ||
					dirtyCols?.has(k) ||
					ctx.merges.some((m) => row >= m.top && row <= m.bottom && k >= m.left && k <= m.right);
				if (!solo)
					while (
						k + run < to &&
						!engine.cell(info.id, row, k + run) &&
						!dirtyCols?.has(k + run) &&
						!ctx.merges.some(
							(m) => row >= m.top && row <= m.bottom && k + run >= m.left && k + run <= m.right
						)
					)
						run++;
				out += cellXml(ctx, row, k, solo ? 1 : run);
				k += solo ? 1 : run;
			}
		};
		for (const c of src?.cells ?? []) {
			for (const p of runPieces(steps, 'col', c.col, c.repeat)) {
				if (p.cur > next) blank(next, p.cur);
				let k = p.cur;
				const end = p.cur + p.length;
				while (k < end) {
					if (dirtyCols?.has(k)) {
						out += cellXml(ctx, row, k);
						k++;
						continue;
					}
					let j = k;
					while (j < end && !dirtyCols?.has(j)) j++;
					const whole = j - k === c.repeat && !colSteps;
					const el = xml.slice(c.start, c.end);
					if (whole) out += el;
					else {
						const tag = /^<[^>]*>/.exec(el)![0];
						out += setRepeat(tag, 'table:number-columns-repeated', j - k) + el.slice(tag.length);
					}
					k = j;
				}
				next = end;
			}
		}
		const last = Math.max(extent.cols, ...[...(dirtyCols ?? [])].map((c) => c + 1));
		if (last > next) blank(next, last);
		return out || '<table:table-cell/>';
	};

	const rowTag = (src: ORow | null, row: number, repeat: number) => {
		let tag = src ? xml.slice(src.start, src.tagEnd) : '<table:table-row>';
		if (src?.selfClosing) tag = `${tag.slice(0, -2)}>`;
		tag = setRepeat(tag, 'table:number-rows-repeated', repeat);
		const h = info.rows.get(row)?.height;
		if (h !== undefined && (!src || rowHeight(src) !== h))
			tag = tag
				.replace(/\stable:style-name="[^"]*"/, '')
				.replace(/>$/, ` table:style-name="${ctx.styles.row(h)}">`);
		return tag;
	};
	const rowChanged = (src: ORow | null, row: number) => {
		if (dirty.has(row)) return true;
		const now = info.rows.get(row)?.height;
		if (!src) return now !== undefined;
		// Heights of long runs are not read into the model, so they cannot have changed.
		if (now === undefined && src.repeat > 1000) return false;
		return now !== rowHeight(src);
	};

	const emitRow = (src: ORow | null, row: number, repeat: number) =>
		`${rowTag(src, row, repeat)}${cellsOf(src, row, dirty.get(row))}</table:table-row>`;
	/** New rows in `[from, to)`: empty runs as one element. */
	const fill = (from: number, to: number) => {
		let out = '';
		let r = from;
		while (r < to) {
			if (rowChanged(null, r) || hasCells(r)) {
				out += emitRow(null, r, 1);
				r++;
				continue;
			}
			let k = r + 1;
			while (k < to && !rowChanged(null, k) && !hasCells(k)) k++;
			out += emitRow(null, r, k - r);
			r = k;
		}
		return out;
	};
	const cellRows = new Set<number>();
	for (const c of engine.cells(info.id)) cellRows.add(c.row);
	const hasCells = (r: number) => cellRows.has(r);

	const splices: { start: number; end: number; text: string }[] = [];
	let next = 0;
	for (const [i, src] of t.rows.entries()) {
		const pieces = runPieces(steps, 'row', src.row, src.repeat);
		let out = '';
		let changed =
			colSteps ||
			pieces.length !== 1 ||
			pieces[0].cur !== src.row ||
			pieces[0].length !== src.repeat;
		for (const p of pieces) {
			if (p.cur > next) {
				out += fill(next, p.cur);
				changed = true;
			}
			let r = p.cur;
			const end = p.cur + p.length;
			while (r < end) {
				if (rowChanged(src, r)) {
					out += emitRow(src, r, 1);
					changed = true;
					r++;
					continue;
				}
				let k = r;
				while (k < end && !rowChanged(src, k)) k++;
				if (!colSteps && k - r === src.repeat) out += xml.slice(src.start, src.end);
				else if (!colSteps) {
					const el = xml.slice(src.start, src.end);
					const tag = xml.slice(src.start, src.tagEnd);
					out += setRepeat(tag, 'table:number-rows-repeated', k - r) + el.slice(tag.length);
				} else out += emitRow(src, r, k - r);
				r = k;
			}
			next = end;
		}
		if (i === t.rows.length - 1) {
			const last = Math.max(
				extent.rows,
				...[...dirty.keys()].map((r) => r + 1),
				...[...info.rows.keys()].map((r) => r + 1)
			);
			if (last > next) {
				out += fill(next, last);
				changed = true;
			}
		}
		if (changed) splices.push({ start: src.start, end: src.end, text: out });
	}
	if (t.rows.length === 0) {
		const at = t.end - '</table:table>'.length;
		const last = Math.max(extent.rows, ...[...info.rows.keys()].map((r) => r + 1), 1);
		splices.push({ start: at, end: at, text: fill(0, last) });
	}

	// Columns, written anew when their widths or positions changed.
	if (colsChanged) {
		let cols = '';
		const total = Math.max(
			t.cols.reduce((n, c) => n + c.repeat, 0) +
				steps.filter((s) => s.axis === 'col').reduce((n, s) => n + s.count, 0),
			extent.cols,
			1
		);
		let c = 0;
		while (c < Math.min(total, MAX_COLS)) {
			const ci = info.cols.find((x) => c >= x.min && c <= x.max);
			let run = 1;
			while (c + run < total && info.cols.find((x) => c + run >= x.min && c + run <= x.max) === ci)
				run++;
			const styleAttr =
				ci?.width !== undefined ? ` table:style-name="${ctx.styles.column(ci.width)}"` : '';
			const def = ci?.style ? ctx.styles.cell(ci.style) : undefined;
			cols += `<table:table-column${styleAttr}${run > 1 ? ` table:number-columns-repeated="${Math.min(run, MAX_COLS - c)}"` : ''}${ci?.hidden ? ' table:visibility="collapse"' : ''} table:default-cell-style-name="${escapeAttr(def ?? 'Default')}"/>`;
			c += run;
		}
		if (t.colsStart >= 0) splices.push({ start: t.colsStart, end: t.colsEnd, text: cols });
		else splices.push({ start: t.tagEnd, end: t.tagEnd, text: cols });
	}

	if (splices.length === 0) return null;
	splices.sort((a, b) => a.start - b.start);
	let out = '';
	let at = t.start;
	for (const s of splices) {
		out += xml.slice(at, s.start) + s.text;
		at = s.end;
	}
	return out + xml.slice(at, t.end);
}

const enc = new TextEncoder();

const EMPTY_CONTENT =
	'<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" office:version="1.3"><office:automatic-styles/><office:body><office:spreadsheet></office:spreadsheet></office:body></office:document-content>';

async function template(): Promise<Uint8Array> {
	const files: [string, string, boolean?][] = [
		['mimetype', ODS_MIME, true],
		[
			'META-INF/manifest.xml',
			`<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${ODS_MIME}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`
		],
		['content.xml', EMPTY_CONTENT],
		[
			'styles.xml',
			'<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" office:version="1.3"><office:styles><style:style style:name="Default" style:family="table-cell"/></office:styles></office:document-styles>'
		]
	];
	return writeZip(
		null,
		files.map(([name, text, store]) => ({ name, data: enc.encode(text), store }))
	);
}

/**
 * Writes the workbook. Given the `.ods` it was opened from, it writes into it and
 * keeps what did not change; otherwise it writes a new package.
 */
export async function writeOds(book: Book, original?: Uint8Array): Promise<Uint8Array> {
	const same = original !== undefined && book.source.format === 'ods';
	const zip = readZip(same ? original : await template());
	const content = (await partText(zip, 'content.xml')) ?? EMPTY_CONTENT;
	const stylesXml = await partText(zip, 'styles.xml');
	const styles = readOdsStyles(content, stylesXml);
	const scan = scanContent(content, { cells: ODS_LIMITS.cells });
	const taken = (n: string) => content.includes(`"${n}"`) || (stylesXml ?? '').includes(`"${n}"`);
	const writer = new OdsStyleWriter(book, styles, same, taken);
	const ordered = book.ordered();
	const out: string[] = [];
	for (const info of ordered) {
		const name = book.engine.sheetName(info.id);
		const ctx: WriteCtx = { book, info, styles: writer, merges: info.merges };
		const t = same && info.origin !== null ? scan.tables[info.origin] : undefined;
		if (t) {
			let text = patchTable(content, t, info, ctx, styles, same) ?? content.slice(t.start, t.end);
			if (name !== t.name) {
				const tag = /^<[^>]*>/.exec(text)![0];
				text =
					tag.replace(/table:name="[^"]*"/, `table:name="${escapeAttr(name)}"`) +
					text.slice(tag.length);
			}
			out.push(text);
		} else {
			const blank: OTable = {
				name,
				start: 0,
				end: 0,
				tagEnd: 0,
				rows: [],
				cols: [],
				colsStart: -1,
				colsEnd: -1
			};
			const shell = `<table:table table:name="${escapeAttr(name)}"></table:table>`;
			blank.end = shell.length;
			blank.tagEnd = shell.indexOf('>') + 1;
			out.push(patchTable(shell, blank, { ...info, steps: [] }, ctx, styles, false) ?? shell);
		}
	}
	const tables = findSpans(content, (n) => n === 'table:table');
	const spreadsheet = findSpans(content, (n) => n === 'office:spreadsheet')[0];
	let next: string;
	if (tables.length > 0) {
		next =
			content.slice(0, tables[0].start) +
			out.join('') +
			content.slice(tables[tables.length - 1].end);
	} else if (spreadsheet) {
		const inner = content.slice(spreadsheet.start, spreadsheet.end);
		const close = inner.lastIndexOf('</office:spreadsheet>');
		next =
			content.slice(0, spreadsheet.start) +
			inner.slice(0, close) +
			out.join('') +
			inner.slice(close) +
			content.slice(spreadsheet.end);
	} else throw new OdsError('no spreadsheet');
	if (writer.xml.length > 0) {
		const auto = findSpans(next, (n) => n === 'office:automatic-styles')[0];
		if (auto) {
			const el = next.slice(auto.start, auto.end);
			const replaced = el.endsWith('/>')
				? `${el.slice(0, -2)}>${writer.xml.join('')}</office:automatic-styles>`
				: el.slice(0, el.lastIndexOf('</')) + writer.xml.join('') + el.slice(el.lastIndexOf('</'));
			next = next.slice(0, auto.start) + replaced + next.slice(auto.end);
		} else {
			const body = next.indexOf('<office:body');
			next =
				next.slice(0, body) +
				`<office:automatic-styles>${writer.xml.join('')}</office:automatic-styles>` +
				next.slice(body);
		}
	}
	if (next === content) return same ? (original as Uint8Array) : writeZip(zip, []);
	return writeZip(zip, [{ name: 'content.xml', data: enc.encode(next) }]);
}
