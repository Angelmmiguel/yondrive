/**
 * `.xlsx`: SpreadsheetML read into the workbook model and written back by the
 * cell-level version of PLAN 6.2.
 *
 * On save the original package is read again. A sheet nobody touched keeps its
 * part as it was; in a sheet that changed, each row and cell that did not change
 * is copied from the source text, a cell that only moved (rows or columns were
 * inserted above it) has only its address rewritten, and the rest is generated.
 * Shared strings are only ever appended, so cells elsewhere that point at them
 * keep their text; new styles are appended too. The cached values of formulas
 * the engine recalculated are written with them. When something cannot be
 * brought up to date here (a formula this engine does not calculate whose
 * inputs changed, or a cycle) the workbook asks Excel to recalculate on open,
 * and `calcChain.xml`, which lists formula cells, is dropped whenever that list
 * changed. Charts, pivot tables, drawings, comments, macros and every other part
 * stay in the package untouched.
 */
import {
	areaA1,
	a1,
	cellKey,
	MAX_COLS,
	MAX_ROWS,
	parseA1,
	parseArea,
	type Area
} from '$lib/formula/address';
import { print } from '$lib/formula/ast';
import { dateSerial } from '$lib/formula/dates';
import { Engine, type Cell } from '$lib/formula/engine';
import { FormulaSyntaxError, parseFormula } from '$lib/formula/parse';
import { shiftFormula, translateFormula } from '$lib/formula/shift';
import {
	err,
	isError,
	isErrorCode,
	sameValue,
	type ErrorCode,
	type Scalar
} from '$lib/formula/values';
import { Tally } from './model';
import {
	ContentTypes,
	partText,
	REL_NS,
	Rels,
	relsPathOf,
	resolveTarget,
	spliceBeforeClose
} from './ooxml';
import {
	Book,
	currentArea,
	currentOf,
	movePos,
	type AxisStep,
	type ColInfo,
	type OpenedSheets,
	type RowInfo,
	type SheetInfo
} from './workbook';
import { readStyles, StyleAppender, TEMPLATE_STYLES, themeColors } from './xlsx-styles';
import { escapeAttr, escapeXml, findSpans, kids, parseXml, tokenize } from './xml';
import {
	readZip,
	writeZip,
	ZIP_LIMITS,
	type ZipArchive,
	type ZipChange,
	type ZipLimits
} from './zip';

export class XlsxError extends Error {}

/** Bounds on a workbook nobody has vouched for. */
export const SHEET_LIMITS = {
	cells: 2_000_000,
	strings: 2_000_000,
	stringLength: 32767,
	sheets: 1024,
	merges: 100_000,
	names: 10_000
};

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const TYPES = {
	worksheet: `${REL_NS}/worksheet`,
	chartsheet: `${REL_NS}/chartsheet`,
	sharedStrings: `${REL_NS}/sharedStrings`,
	styles: `${REL_NS}/styles`,
	theme: `${REL_NS}/theme`,
	calcChain: `${REL_NS}/calcChain`
};
const CT = {
	worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
	sharedStrings: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
	styles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'
};

const local = (n: string) => n.slice(n.indexOf(':') + 1);

// The package.

interface SheetEl {
	name: string;
	sheetId: number;
	rid: string;
	state?: string;
	start: number;
	end: number;
	kind: 'worksheet' | 'other';
	path?: string;
}

interface Package {
	zip: ZipArchive;
	workbookPath: string;
	workbook: string;
	rels: Rels;
	sheets: SheetEl[];
	/** Indexes into `sheets` of the worksheets, in order: a book sheet's `origin` counts these. */
	grid: number[];
	stylesPath?: string;
	sstPath?: string;
	themePath?: string;
	calcChainPath?: string;
	date1904: boolean;
}

async function readPackage(zip: ZipArchive): Promise<Package> {
	const root = await partText(zip, '_rels/.rels');
	const office = new Rels('_rels/.rels', root).byType(`${REL_NS}/officeDocument`);
	const workbookPath = office ? resolveTarget('', office.target) : 'xl/workbook.xml';
	const workbook = await partText(zip, workbookPath);
	if (workbook === null) throw new XlsxError('no workbook');
	const relsPath = relsPathOf(workbookPath);
	const rels = new Rels(relsPath, await partText(zip, relsPath));
	const wb = parseXml(workbook);
	const sheetsEl = kids(wb).find((k) => local(k.name) === 'sheets');
	const sheets: SheetEl[] = [];
	for (const s of sheetsEl ? kids(sheetsEl).filter((k) => local(k.name) === 'sheet') : []) {
		const ridAttr = Object.keys(s.attrs).find((a) => local(a) === 'id' && a.includes(':'));
		const rid = ridAttr ? s.attrs[ridAttr] : '';
		const rel = rels.get(rid);
		const kind = rel?.type === TYPES.worksheet ? 'worksheet' : 'other';
		sheets.push({
			name: s.attrs.name ?? `Sheet${sheets.length + 1}`,
			sheetId: Number(s.attrs.sheetId ?? sheets.length + 1),
			rid,
			state: s.attrs.state,
			start: s.start,
			end: s.end,
			kind,
			path: rel && !rel.external ? resolveTarget(workbookPath, rel.target) : undefined
		});
	}
	if (sheets.length > SHEET_LIMITS.sheets) throw new XlsxError('too many sheets');
	const target = (type: string) => {
		const r = rels.byType(type);
		return r && !r.external ? resolveTarget(workbookPath, r.target) : undefined;
	};
	const pr = kids(wb).find((k) => local(k.name) === 'workbookPr');
	return {
		zip,
		workbookPath,
		workbook,
		rels,
		sheets,
		grid: sheets.flatMap((s, i) => (s.kind === 'worksheet' && s.path ? [i] : [])),
		stylesPath: target(TYPES.styles),
		sstPath: target(TYPES.sharedStrings),
		themePath: target(TYPES.theme),
		calcChainPath: target(TYPES.calcChain),
		date1904: pr?.attrs.date1904 === '1' || pr?.attrs.date1904 === 'true'
	};
}

// Shared strings.

interface Strings {
	texts: string[];
	rich: Set<number>;
}

function readStrings(xml: string | null): Strings {
	const texts: string[] = [];
	const rich = new Set<number>();
	if (!xml) return { texts, rich };
	let inSi = false;
	let inT = false;
	let phonetic = 0;
	let cur = '';
	for (const t of tokenize(xml)) {
		if (t.type === 'start') {
			const n = local(t.name);
			if (n === 'si') {
				inSi = !t.selfClosing;
				cur = '';
				if (t.selfClosing) texts.push('');
			} else if (n === 'rPh') phonetic += t.selfClosing ? 0 : 1;
			else if (n === 't' && inSi && !t.selfClosing && phonetic === 0) inT = true;
			else if (n === 'r' && inSi) rich.add(texts.length);
		} else if (t.type === 'end') {
			const n = local(t.name);
			if (n === 'si') {
				if (cur.length > SHEET_LIMITS.stringLength) throw new XlsxError('string too long');
				texts.push(cur);
				if (texts.length > SHEET_LIMITS.strings) throw new XlsxError('too many strings');
				inSi = false;
			} else if (n === 'rPh') phonetic--;
			else if (n === 't') inT = false;
		} else if (t.type === 'text' && inT) cur += t.text;
		else if (t.type === 'cdata' && inT) cur += xml.slice(t.start + 9, t.end - 3);
	}
	return { texts, rich };
}

// Sheets.

interface CellSrc {
	row: number;
	col: number;
	start: number;
	end: number;
	/** End of the start tag. */
	tagEnd: number;
	hasR: boolean;
	s: number;
	t?: string;
	f?: { t?: string; ref?: string; si?: string; text: string };
	v?: string;
	inline?: string;
	/** The `<v>` element, when there is one. */
	vStart?: number;
	vEnd?: number;
	/** As the engine reads it. */
	value: Scalar;
	formula?: string;
	array?: Area;
}

interface RowSrc {
	row: number;
	start: number;
	end: number;
	tagEnd: number;
	selfClosing: boolean;
	hasR: boolean;
	attrs: Record<string, string>;
	cells: CellSrc[];
}

interface Span {
	start: number;
	end: number;
	/** End of the start tag. */
	tagEnd: number;
	name: string;
	attrs: Record<string, string>;
	/** Text content, for formulas of conditional formats and validations. */
	text?: string;
	textStart?: number;
	textEnd?: number;
}

interface SheetScan {
	prefix: string;
	rows: RowSrc[];
	sheetData?: Span & { selfClosing: boolean };
	dimension?: Span;
	cols?: Span;
	colEls: Record<string, string>[];
	mergeCells?: Span;
	merges: Area[];
	formatPr: Record<string, string>;
	pane?: Record<string, string>;
	/** Elements with references to keep in step with rows and columns. */
	refs: Span[];
	/** Elements in the sheet, by local name, for the census and for placing new ones. */
	present: Map<string, Span>;
	counts: Map<string, number>;
	unknownErrors: number;
}

const REF_ATTRS: Record<string, string[]> = {
	conditionalFormatting: ['sqref'],
	dataValidation: ['sqref'],
	hyperlink: ['ref'],
	autoFilter: ['ref'],
	protectedRange: ['sqref'],
	ignoredError: ['sqref'],
	selection: ['sqref', 'activeCell'],
	pane: ['topLeftCell'],
	sheetView: ['topLeftCell']
};
const REF_FORMULAS = new Set(['formula', 'formula1', 'formula2']);
const COUNTED = new Set([
	'conditionalFormatting',
	'dataValidation',
	'hyperlink',
	'drawing',
	'legacyDrawing',
	'tablePart',
	'sheetProtection',
	'autoFilter',
	'extLst',
	'oleObjects',
	'controls',
	'picture'
]);

function decodeValue(
	t: string | undefined,
	v: string | undefined,
	inline: string | undefined,
	sst: Strings,
	scan: { unknownErrors: number },
	date1904: boolean
): Scalar {
	switch (t) {
		case 's': {
			const i = Number(v);
			return Number.isInteger(i) && i >= 0 && i < sst.texts.length ? sst.texts[i] : err('#REF!');
		}
		case 'str':
			return v ?? '';
		case 'inlineStr':
			return inline ?? v ?? '';
		case 'b':
			return v === undefined ? null : v === '1' || v === 'true';
		case 'e': {
			const code = (v ?? '').trim().toUpperCase();
			if (isErrorCode(code)) return err(code as ErrorCode);
			scan.unknownErrors++;
			return err('#VALUE!');
		}
		case 'd': {
			const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?))?/.exec(v ?? '');
			if (!m) return null;
			const day = dateSerial(+m[1], +m[2], +m[3], date1904) ?? 0;
			return day + (m[4] ? (+m[4] * 3600 + +m[5] * 60 + +m[6]) / 86400 : 0);
		}
		default: {
			if (v === undefined || v.trim() === '') return null;
			const n = Number(v);
			return Number.isFinite(n) ? n : err('#VALUE!');
		}
	}
}

/** Reads a worksheet part once, with the offsets a writer splices at. */
function scanSheet(
	xml: string,
	sst: Strings,
	date1904: boolean,
	budget: { cells: number }
): SheetScan {
	const scan: SheetScan = {
		prefix: '',
		rows: [],
		colEls: [],
		merges: [],
		formatPr: {},
		refs: [],
		present: new Map(),
		counts: new Map(),
		unknownErrors: 0
	};
	const stack: string[] = [];
	let row: RowSrc | null = null;
	let cell: CellSrc | null = null;
	let lastRow = -1;
	let lastCol = -1;
	let field: 'f' | 'v' | 't' | null = null;
	let inIs = 0;
	let phonetic = 0;
	let text = '';
	const open = new Map<string, Span>();
	let formulaSpan: Span | null = null;
	const shared = new Map<
		string,
		{ row: number; col: number; ast: ReturnType<typeof parseFormula> | null; text: string }
	>();
	for (const t of tokenize(xml)) {
		if (t.type === 'start') {
			const n = local(t.name);
			if (stack.length === 0)
				scan.prefix = t.name.includes(':') ? t.name.slice(0, t.name.indexOf(':') + 1) : '';
			const depth = stack.length;
			if (!t.selfClosing) stack.push(n);
			const span: Span = { start: t.start, end: t.end, tagEnd: t.end, name: n, attrs: t.attrs };
			if (COUNTED.has(n)) scan.counts.set(n, (scan.counts.get(n) ?? 0) + 1);
			if (depth === 1 && !scan.present.has(n)) scan.present.set(n, span);
			if (!t.selfClosing) open.set(`${depth}:${n}`, span);
			if (REF_ATTRS[n]) scan.refs.push(span);
			if (
				REF_FORMULAS.has(n) &&
				(stack.includes('conditionalFormatting') || stack.includes('dataValidation'))
			) {
				formulaSpan = span;
				text = '';
			}
			switch (n) {
				case 'sheetData':
					scan.sheetData = { ...span, selfClosing: t.selfClosing };
					break;
				case 'dimension':
					scan.dimension = span;
					break;
				case 'cols':
					scan.cols = span;
					break;
				case 'col':
					scan.colEls.push(t.attrs);
					break;
				case 'mergeCells':
					scan.mergeCells = span;
					break;
				case 'mergeCell': {
					const a = parseArea(t.attrs.ref ?? '');
					if (a) scan.merges.push(a);
					if (scan.merges.length > SHEET_LIMITS.merges)
						throw new XlsxError('too many merged cells');
					break;
				}
				case 'sheetFormatPr':
					scan.formatPr = t.attrs;
					break;
				case 'pane':
					scan.pane = t.attrs;
					break;
				case 'row': {
					const r = t.attrs.r !== undefined ? Number(t.attrs.r) - 1 : lastRow + 1;
					if (!Number.isInteger(r) || r < 0 || r >= MAX_ROWS || r <= lastRow)
						throw new XlsxError('bad row');
					lastRow = r;
					lastCol = -1;
					row = {
						row: r,
						start: t.start,
						end: t.end,
						tagEnd: t.end,
						selfClosing: t.selfClosing,
						hasR: t.attrs.r !== undefined,
						attrs: t.attrs,
						cells: []
					};
					scan.rows.push(row);
					break;
				}
				case 'c': {
					if (!row) throw new XlsxError('cell outside a row');
					let col = lastCol + 1;
					if (t.attrs.r !== undefined) {
						const p = parseA1(t.attrs.r);
						if (!p || p.row !== row.row) throw new XlsxError('bad cell reference');
						col = p.col;
					}
					if (col >= MAX_COLS || col <= lastCol) throw new XlsxError('bad cell order');
					lastCol = col;
					if (--budget.cells < 0) throw new XlsxError('too many cells');
					cell = {
						row: row.row,
						col,
						start: t.start,
						end: t.end,
						tagEnd: t.end,
						hasR: t.attrs.r !== undefined,
						s: Number(t.attrs.s ?? 0) || 0,
						t: t.attrs.t,
						value: null
					};
					row.cells.push(cell);
					if (t.selfClosing) {
						cell = null;
					}
					break;
				}
				case 'f':
					if (cell) {
						cell.f = { t: t.attrs.t, ref: t.attrs.ref, si: t.attrs.si, text: '' };
						field = t.selfClosing ? null : 'f';
						text = '';
					}
					break;
				case 'v':
					if (cell) {
						cell.vStart = t.start;
						cell.vEnd = t.end;
					}
					if (cell && !t.selfClosing) {
						field = 'v';
						text = '';
					}
					break;
				case 'is':
					if (cell) inIs++;
					text = '';
					break;
				case 'rPh':
					if (!t.selfClosing) phonetic++;
					break;
				case 't':
					if (inIs && !t.selfClosing && phonetic === 0) field = 't';
					break;
			}
		} else if (t.type === 'end') {
			const n = local(t.name);
			stack.pop();
			const span = open.get(`${stack.length}:${n}`);
			if (span) {
				span.end = t.end;
				open.delete(`${stack.length}:${n}`);
			}
			if (formulaSpan && n === formulaSpan.name) {
				formulaSpan.text = text;
				formulaSpan.textStart = formulaSpan.tagEnd;
				formulaSpan.textEnd = t.start;
				scan.refs.push(formulaSpan);
				formulaSpan = null;
			}
			if (n === 'f' && cell?.f && field === 'f') {
				cell.f.text = text;
				field = null;
			} else if (n === 'v' && cell && field === 'v') {
				cell.v = text;
				cell.vEnd = t.end;
				field = null;
			} else if (n === 't' && field === 't') field = null;
			else if (n === 'rPh') phonetic--;
			else if (n === 'is' && cell) {
				inIs--;
				cell.inline = text;
			} else if (n === 'c' && cell) {
				cell.end = t.end;
				cell = null;
			} else if (n === 'row' && row) {
				row.end = t.end;
				row = null;
			} else if (n === 'sheetData' && scan.sheetData) scan.sheetData.end = t.end;
		} else if (t.type === 'text' || t.type === 'cdata') {
			const s = t.type === 'text' ? t.text : xml.slice(t.start + 9, t.end - 3);
			if (field) text += s;
			else if (formulaSpan) text += s;
			if (text.length > SHEET_LIMITS.stringLength * 2) throw new XlsxError('text too long');
		}
	}
	// Values and formulas, with shared formulas expanded from their first cell.
	for (const r of scan.rows) {
		for (const c of r.cells) {
			c.value = decodeValue(c.t, c.v, c.inline, sst, scan, date1904);
			const f = c.f;
			if (!f) continue;
			if (f.t === 'shared' && f.si !== undefined) {
				const master = shared.get(f.si);
				if (f.text !== '' && !master) {
					let ast = null;
					try {
						ast = parseFormula(f.text);
					} catch (e) {
						if (!(e instanceof FormulaSyntaxError)) throw e;
					}
					shared.set(f.si, { row: c.row, col: c.col, ast, text: f.text });
					c.formula = f.text;
				} else if (master) {
					c.formula = master.ast
						? print(translateFormula(master.ast, c.row - master.row, c.col - master.col))
						: master.text;
				} else c.formula = f.text;
			} else if (f.t === 'array') {
				c.formula = f.text;
				c.array = parseArea(f.ref ?? '') ?? {
					top: c.row,
					left: c.col,
					bottom: c.row,
					right: c.col
				};
			} else c.formula = f.text;
		}
	}
	return scan;
}

function rowInfoOf(attrs: Record<string, string>, style: (s: number) => number): RowInfo | null {
	const info: RowInfo = {};
	const ht = Number(attrs.ht);
	if (
		attrs.ht !== undefined &&
		ht >= 0 &&
		ht < 1000 &&
		(attrs.customHeight === '1' || attrs.customHeight === 'true')
	) {
		info.height = ht;
	}
	if (attrs.hidden === '1' || attrs.hidden === 'true') info.hidden = true;
	if ((attrs.customFormat === '1' || attrs.customFormat === 'true') && attrs.s !== undefined) {
		info.style = style(Number(attrs.s) || 0);
	}
	return Object.keys(info).length > 0 ? info : null;
}

/** The attributes of <col> the model holds; the writer keeps the rest from the file. */
const COL_MODEL_ATTRS = new Set(['min', 'max', 'width', 'customWidth', 'hidden', 'style']);

function colInfoOf(attrs: Record<string, string>): ColInfo | null {
	const min = Number(attrs.min) - 1;
	const max = Number(attrs.max) - 1;
	if (!(min >= 0 && max >= min && max < MAX_COLS)) return null;
	const info: ColInfo = { min, max };
	const w = Number(attrs.width);
	if (attrs.width !== undefined && w >= 0 && w <= 255) info.width = w;
	if (attrs.hidden === '1' || attrs.hidden === 'true') info.hidden = true;
	if (attrs.style !== undefined && Number(attrs.style) > 0) info.style = Number(attrs.style);
	return info;
}

export async function readXlsx(
	bytes: Uint8Array,
	limits: ZipLimits = ZIP_LIMITS
): Promise<OpenedSheets> {
	const zip = readZip(bytes, limits);
	const pkg = await readPackage(zip);
	const theme = themeColors(pkg.themePath ? await partText(zip, pkg.themePath) : null);
	const stylesPart = readStyles(pkg.stylesPath ? await partText(zip, pkg.stylesPath) : null, theme);
	const sst = readStrings(pkg.sstPath ? await partText(zip, pkg.sstPath) : null);
	const engine = new Engine({ date1904: pkg.date1904 });
	const styleCount = stylesPart.styles.length;
	const book = new Book(engine, stylesPart.styles, {
		format: 'xlsx',
		styles: styleCount,
		sheets: pkg.grid.length
	});
	const style = (s: number) => (s >= 0 && s < book.styles.length ? s : 0);
	const tally = new Tally();
	const budget = { cells: SHEET_LIMITS.cells };
	let unsupported = 0;
	let arrays = 0;
	let rich = 0;
	let unknownErrors = 0;
	const counts = new Map<string, number>();
	for (const [origin, idx] of pkg.grid.entries()) {
		const el = pkg.sheets[idx];
		const info = book.addSheet(uniqueName(engine, el.name), undefined, origin);
		if (el.state === 'hidden' || el.state === 'veryHidden') info.hidden = true;
		const xml = await partText(zip, el.path as string);
		if (xml === null) continue;
		const scan = scanSheet(xml, sst, pkg.date1904, budget);
		unknownErrors += scan.unknownErrors;
		for (const [k, n] of scan.counts) counts.set(k, (counts.get(k) ?? 0) + n);
		const fp = scan.formatPr;
		if (Number(fp.defaultRowHeight) > 0) info.defaultRowHeight = Number(fp.defaultRowHeight);
		if (Number(fp.defaultColWidth) > 0) info.defaultColWidth = Number(fp.defaultColWidth);
		else if (Number(fp.baseColWidth) > 0) info.defaultColWidth = Number(fp.baseColWidth) + 0.71;
		info.cols = scan.colEls
			.map(colInfoOf)
			.filter((c): c is ColInfo => c !== null)
			.map((c) => (c.style === undefined ? c : { ...c, style: style(c.style) }));
		info.merges = scan.merges;
		const pane = scan.pane;
		if (pane && (pane.state === 'frozen' || pane.state === 'frozenSplit')) {
			info.frozen = {
				rows: Math.max(0, Math.trunc(Number(pane.ySplit ?? 0))),
				cols: Math.max(0, Math.trunc(Number(pane.xSplit ?? 0)))
			};
		}
		for (const r of scan.rows) {
			const ri = rowInfoOf(r.attrs, style);
			if (ri) info.rows.set(r.row, ri);
			for (const c of r.cells) {
				if (c.t === 's' && sst.rich.has(Number(c.v))) rich++;
				engine.load(info.id, c.row, c.col, {
					value: c.value,
					formula: c.formula,
					style: style(c.s),
					array: c.array
				});
				if (c.array) arrays++;
			}
		}
	}
	const wb = parseXml(pkg.workbook);
	const dn = kids(wb).find((k) => local(k.name) === 'definedNames');
	const nameEls = dn ? kids(dn).filter((k) => local(k.name) === 'definedName') : [];
	if (nameEls.length > SHEET_LIMITS.names) throw new XlsxError('too many names');
	engine.names = nameEls.map((n, key) => {
		const at =
			n.attrs.localSheetId === undefined
				? undefined
				: pkg.grid.indexOf(Number(n.attrs.localSheetId));
		const sheet = at === undefined || at < 0 ? undefined : book.sheets[at]?.id;
		return {
			name: n.attrs.name ?? '',
			text: n.children.map((c) => ('text' in c ? c.text : '')).join(''),
			sheet,
			key
		};
	});
	engine.loaded();
	for (const s of book.sheets) {
		for (const c of engine.cells(s.id))
			if (c.formula && c.formula.status !== 'ok' && !c.formula.array) unsupported++;
	}

	const names = zip.entries.map((e) => e.name);
	const parts = (re: RegExp) => names.filter((n) => re.test(n)).length;
	const kept = (label: string, n: number) => n > 0 && tally.add(label, 'kept', n);
	kept('Chart', parts(/^xl\/charts\/chart\d*\.xml$/));
	kept('Picture', parts(/^xl\/media\//));
	kept('Pivot table', parts(/^xl\/pivotTables\/[^/]+\.xml$/));
	kept('Table', parts(/^xl\/tables\/[^/]+\.xml$/));
	kept('Comments', parts(/^xl\/comments\d*\.xml$/) + parts(/^xl\/threadedComments\//));
	kept('Macros', parts(/vbaProject\.bin$/));
	kept('Link to another workbook', parts(/^xl\/externalLinks\/externalLink\d*\.xml$/));
	kept('Slicer', parts(/^xl\/slicers\//));
	kept('Chart sheet', pkg.sheets.filter((s) => s.kind !== 'worksheet').length);
	kept('Defined name', nameEls.length);
	kept('Conditional formatting', counts.get('conditionalFormatting') ?? 0);
	kept('Data validation', counts.get('dataValidation') ?? 0);
	kept('Hyperlink', counts.get('hyperlink') ?? 0);
	kept('Sheet protection', counts.get('sheetProtection') ?? 0);
	kept('Filter', counts.get('autoFilter') ?? 0);
	kept('Extension data (sparklines and others)', counts.get('extLst') ?? 0);
	kept(
		'Embedded object or control',
		(counts.get('oleObjects') ?? 0) + (counts.get('controls') ?? 0)
	);
	if (unsupported > 0) tally.add('Formula not calculated here', 'locked', unsupported);
	if (arrays > 0) tally.add('Array formula', 'locked', arrays);
	if (rich > 0)
		tally.add(
			'Text with mixed formatting in a cell keeps it unless the cell is edited',
			'changed',
			rich
		);
	if (unknownErrors > 0)
		tally.add('Error values from a newer Excel are shown as #VALUE!', 'changed', unknownErrors);
	const fixedRanges = ['Chart', 'Pivot table', 'Table', 'Slicer'].filter((l) =>
		tally.census().items.some((i) => i.label === l)
	);
	return { book, census: tally.census(), fixedRanges };
}

function uniqueName(engine: Engine, name: string): string {
	let n = name || 'Sheet';
	for (let k = 2; engine.sheetByName(n); k++) n = `${name} (${k})`;
	return n;
}

// Writing.

const cellEq = (c: Cell | undefined, src: CellSrc) => {
	if (!c) return src.value === null && src.formula === undefined && src.s === 0;
	if (c.style !== src.s) return false;
	if ((c.formula?.text ?? undefined) !== src.formula) return false;
	return sameValue(c.value, src.value);
};

function tryParse(text: string) {
	try {
		return parseFormula(text);
	} catch (e) {
		if (e instanceof FormulaSyntaxError) return null;
		throw e;
	}
}

function setAttr(tag: string, name: string, value: string | null): string {
	// Either quote, and space around `=`, as XML allows.
	const re = new RegExp(`(\\s)${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*(?:"[^"]*"|'[^']*')`);
	if (value === null) return tag.replace(re, '');
	if (re.test(tag)) return tag.replace(re, `$1${name}="${escapeAttr(value)}"`);
	const at = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1;
	return `${tag.slice(0, at)} ${name}="${escapeAttr(value)}"${tag.slice(at)}`;
}

interface WriteCtx {
	book: Book;
	strings: StringTable;
	xfOf: (style: number) => number;
	/** Whether style ids are this file's own cell format indexes. */
	sameStyles: boolean;
	sheetName: string;
	prefix: string;
}

class StringTable {
	readonly #index = new Map<string, number>();
	readonly added: string[] = [];
	refsDelta = 0;
	constructor(readonly base: Strings) {
		base.texts.forEach((t, i) => {
			if (!base.rich.has(i) && !this.#index.has(t)) this.#index.set(t, i);
		});
	}
	idx(text: string): number {
		const found = this.#index.get(text);
		if (found !== undefined) return found;
		const i = this.base.texts.length + this.added.length;
		this.added.push(text);
		this.#index.set(text, i);
		return i;
	}
}

function valueXml(v: Scalar, formula: boolean, strings: StringTable): { t?: string; v?: string } {
	if (v === null) return {};
	if (typeof v === 'number') return { v: String(v) };
	if (typeof v === 'boolean') return { t: 'b', v: v ? '1' : '0' };
	if (isError(v)) return { t: 'e', v: v.error };
	if (formula) return { t: 'str', v: v };
	strings.refsDelta++;
	return { t: 's', v: String(strings.idx(v)) };
}

function cellXml(c: Cell, ctx: WriteCtx): string {
	const p = ctx.prefix;
	const f = c.formula;
	const { t, v } = valueXml(c.value, f !== undefined, ctx.strings);
	const s = ctx.xfOf(c.style);
	let out = `<${p}c r="${a1(c.row, c.col)}"${s ? ` s="${s}"` : ''}${t ? ` t="${t}"` : ''}`;
	if (!f && v === undefined) return `${out}/>`;
	out += '>';
	if (f) {
		out += f.array
			? `<${p}f t="array" ref="${areaA1(f.array)}">${escapeXml(f.text)}</${p}f>`
			: `<${p}f>${escapeXml(f.text)}</${p}f>`;
	}
	if (v !== undefined) out += `<${p}v>${escapeXml(v)}</${p}v>`;
	return `${out}</${p}c>`;
}

const rowAxis = (steps: readonly AxisStep[], row: number) => {
	let r: number | null = row;
	for (const s of steps) if (s.axis === 'row' && r !== null) r = movePos(r, s.at, s.count);
	return r !== null && r < MAX_ROWS ? r : null;
};

/** The row element's start tag for where and how it is now. */
function rowTag(
	src: RowSrc | null,
	xml: string,
	row: number,
	info: RowInfo | undefined,
	ctx: WriteCtx
): string {
	let tag = src ? xml.slice(src.start, src.tagEnd) : `<${ctx.prefix}row r="${row + 1}">`;
	if (src?.selfClosing) tag = `${tag.slice(0, -2)}>`;
	tag = setAttr(tag, 'r', String(row + 1));
	tag = setAttr(tag, 'spans', null);
	const ht = info?.height;
	if (ht !== undefined) {
		tag = setAttr(tag, 'ht', String(ht));
		tag = setAttr(tag, 'customHeight', '1');
	} else if (src && src.attrs.customHeight !== undefined) {
		tag = setAttr(setAttr(tag, 'ht', null), 'customHeight', null);
	}
	tag = setAttr(tag, 'hidden', info?.hidden ? '1' : null);
	if (info?.style !== undefined) {
		tag = setAttr(setAttr(tag, 's', String(ctx.xfOf(info.style))), 'customFormat', '1');
	} else tag = setAttr(setAttr(tag, 's', null), 'customFormat', null);
	return tag;
}

const sameRowInfo = (a: RowInfo | null | undefined, b: RowInfo | null | undefined) =>
	(a?.height ?? null) === (b?.height ?? null) &&
	!!a?.hidden === !!b?.hidden &&
	(a?.style ?? null) === (b?.style ?? null);

interface Patched {
	xml: string;
	changed: boolean;
	/** Formula cells were added, removed or moved: calcChain.xml no longer matches. */
	formulasMoved: boolean;
	/** A formula this engine cannot rewrite moved with its cell. */
	staleText: boolean;
}

/**
 * Writes a sheet into its original part: unchanged rows and cells copied, moved
 * ones readdressed, the rest generated.
 */
function patchSheet(xml: string, scan: SheetScan, info: SheetInfo, ctx: WriteCtx): Patched {
	const { book } = ctx;
	const engine = book.engine;
	const steps = info.steps;
	const splices: { start: number; end: number; text: string }[] = [];
	let formulasMoved = false;
	let staleText = false;
	const origStyle = (s: number) => (ctx.sameStyles ? s : -1);

	// Where every cell of the file is now, and which shared formulas still hold.
	const image = new Map<number, CellSrc>();
	const now = new Map<CellSrc, { row: number; col: number } | null>();
	const groups = new Map<string, CellSrc[]>();
	for (const r of scan.rows) {
		for (const c of r.cells) {
			const cur = currentOf(steps, c.row, c.col);
			now.set(c, cur);
			if (cur) image.set(cellKey(cur.row, cur.col), c);
			if (c.f?.t === 'shared' && c.f.si !== undefined) {
				const g = groups.get(c.f.si) ?? [];
				g.push(c);
				groups.set(c.f.si, g);
			}
		}
	}
	/**
	 * `value` when a formula is as the file has it and only its result or style
	 * changed, which keeps the cell's markup, shared formula and all.
	 */
	const change = (c: CellSrc): 'none' | 'value' | 'full' => {
		const cur = now.get(c);
		if (!cur) return 'full';
		const cell = engine.cell(info.id, cur.row, cur.col);
		const src = { ...c, s: origStyle(c.s) };
		if (cellEq(cell, src)) return 'none';
		if (cell?.formula && cell.formula.text === c.formula) return 'value';
		return 'full';
	};
	const dirty = (c: CellSrc) => change(c) === 'full';
	const moved = (c: CellSrc) => {
		const cur = now.get(c);
		return !!cur && (cur.row !== c.row || cur.col !== c.col);
	};
	// A shared formula this engine cannot parse cannot be written out cell by
	// cell: its members would all get the first cell's text. It stays shared,
	// readdressed, unless its first cell is gone.
	const opaque = new Set<string>();
	const broken = new Set<string>();
	for (const [si, g] of groups) {
		const master = g.find((c) => c.f?.text);
		if (!master || tryParse(master.f!.text) === null) {
			opaque.add(si);
			if (master && !now.get(master)) broken.add(si);
		} else if (g.some((c) => dirty(c) || moved(c))) broken.add(si);
	}
	const isOpaque = (c: CellSrc) => c.f?.t === 'shared' && opaque.has(c.f.si ?? '');
	const regenerate = (c: CellSrc) =>
		dirty(c) ||
		(c.f?.t === 'shared' && broken.has(c.f.si ?? '')) ||
		(moved(c) && !!c.f?.ref && !isOpaque(c));

	// Engine cells that are not where a cell of the file went, by row.
	const fresh = new Map<number, Cell[]>();
	for (const c of engine.cells(info.id)) {
		if (image.has(cellKey(c.row, c.col))) continue;
		if (c.formula) formulasMoved = true;
		const list = fresh.get(c.row) ?? [];
		list.push(c);
		fresh.set(c.row, list);
	}
	for (const list of fresh.values()) list.sort((a, b) => a.col - b.col);

	const rowElementAt = new Map<number, RowSrc>();
	for (const r of scan.rows) {
		const cur = rowAxis(steps, r.row);
		if (cur !== null) rowElementAt.set(cur, r);
	}

	// A file may leave out row and cell addresses; once anything moves or is
	// added they are written out, since the implied ones would shift.
	const implicit = scan.rows.some((r) => !r.hasR || r.cells.some((c) => !c.hasR));
	const needR =
		implicit &&
		(fresh.size > 0 ||
			steps.length > 0 ||
			[...info.rows.keys()].some((k) => !rowElementAt.has(k)) ||
			scan.rows.some(
				(r) =>
					!sameRowInfo(
						info.rows.get(r.row),
						rowInfoOf(r.attrs, (s) => (ctx.sameStyles ? s : -1))
					) || r.cells.some((c) => change(c) !== 'none' || moved(c))
			));

	const rowText = (src: RowSrc | null, cur: number): string => {
		const tag = rowTag(src, xml, cur, info.rows.get(cur), ctx);
		let inner = '';
		const add = fresh.get(cur) ?? [];
		let k = 0;
		const flush = (before: number) => {
			while (k < add.length && add[k].col < before) inner += cellXml(add[k++], ctx);
		};
		let prevEnd = src ? src.tagEnd : 0;
		for (const c of src?.cells ?? []) {
			const at = now.get(c);
			const gap = xml.slice(prevEnd, c.start);
			prevEnd = c.end;
			if (!at) {
				if (c.formula !== undefined) formulasMoved = true;
				if (c.t === 's') ctx.strings.refsDelta--;
				continue;
			}
			flush(at.col);
			inner += gap;
			const cell = engine.cell(info.id, at.row, at.col);
			if (regenerate(c)) {
				if (c.t === 's') ctx.strings.refsDelta--;
				if ((c.formula !== undefined) !== !!cell?.formula || (c.formula !== undefined && moved(c)))
					formulasMoved = true;
				if (cell) inner += cellXml(cell, ctx);
			} else if (moved(c) || (needR && !c.hasR) || change(c) === 'value') {
				if (c.formula !== undefined && moved(c)) {
					formulasMoved = true;
					if (cell?.formula?.status === 'invalid') staleText = true;
				}
				let tag = xml.slice(c.start, c.tagEnd);
				let body = xml.slice(c.tagEnd, c.end);
				if (moved(c) || !c.hasR) tag = setAttr(tag, 'r', a1(at.row, at.col));
				if (moved(c) && c.f?.ref && isOpaque(c)) {
					const area = parseArea(c.f.ref);
					const next = area && currentArea(steps, area);
					if (next)
						body = body.replace(new RegExp(`<${ctx.prefix}f\\b[^>]*>`), (f) =>
							setAttr(f, 'ref', areaA1(next))
						);
				}
				if (change(c) === 'value' && cell) {
					if (cell.style !== origStyle(c.s)) {
						const xf = ctx.xfOf(cell.style);
						tag = setAttr(tag, 's', xf ? String(xf) : null);
					}
					const { t, v } = valueXml(cell.value, true, ctx.strings);
					tag = setAttr(tag, 't', t ?? null);
					const el = v === undefined ? '' : `<${ctx.prefix}v>${escapeXml(v)}</${ctx.prefix}v>`;
					body =
						c.vStart !== undefined && c.vEnd !== undefined
							? xml.slice(c.tagEnd, c.vStart) + el + xml.slice(c.vEnd, c.end)
							: body.replace(/<\/[^>]*>$/, (close) => el + close);
				}
				inner += tag + body;
			} else inner += xml.slice(c.start, c.end);
		}
		flush(MAX_COLS);
		if (src && !src.selfClosing)
			inner += xml.slice(prevEnd, src.end - `</${ctx.prefix}row>`.length);
		if (inner === '' && !info.rows.get(cur)) return '';
		return `${tag}${inner}</${ctx.prefix}row>`;
	};

	const rowUnchanged = (r: RowSrc, cur: number) =>
		cur === r.row &&
		(!needR || r.hasR) &&
		!fresh.has(cur) &&
		sameRowInfo(
			info.rows.get(cur),
			rowInfoOf(r.attrs, (s) => (ctx.sameStyles ? s : -1))
		) &&
		r.cells.every((c) => !regenerate(c) && change(c) === 'none' && !moved(c) && (!needR || c.hasR));

	// Rows of the file, in place; new rows go after the last row above them.
	const newRows = new Set<number>(fresh.keys());
	for (const [r, ri] of info.rows) if (ri && !rowElementAt.has(r)) newRows.add(r);
	for (const r of rowElementAt.keys()) newRows.delete(r);
	const pending = [...newRows].sort((a, b) => a - b);
	let p = 0;
	const sd = scan.sheetData;
	let rowsOut = '';
	const insertNew = (before: number) => {
		let out = '';
		while (p < pending.length && pending[p] < before) out += rowText(null, pending[p++]);
		return out;
	};
	if (sd && !sd.selfClosing) {
		let cursor = sd.tagEnd;
		for (const r of scan.rows) {
			const cur = rowAxis(steps, r.row);
			cursor = r.end;
			if (cur === null) {
				// A deleted row has no place in the new order: new rows wait for
				// the next row that is kept.
				for (const c of r.cells) {
					if (c.formula !== undefined) formulasMoved = true;
					if (c.t === 's') ctx.strings.refsDelta--;
				}
				splices.push({ start: r.start, end: r.end, text: '' });
				continue;
			}
			const ins = insertNew(cur);
			if (ins) splices.push({ start: r.start, end: r.start, text: ins });
			if (!rowUnchanged(r, cur)) {
				splices.push({ start: r.start, end: r.end, text: rowText(r, cur) });
			}
		}
		const tail = insertNew(MAX_ROWS);
		if (tail) splices.push({ start: cursor, end: cursor, text: tail });
	} else {
		rowsOut = insertNew(MAX_ROWS);
	}
	if (sd?.selfClosing && rowsOut) {
		const open = xml.slice(sd.start, sd.end).replace(/\/>$/, '>');
		splices.push({
			start: sd.start,
			end: sd.end,
			text: `${open}${rowsOut}</${ctx.prefix}sheetData>`
		});
	}

	const anyCellChange = splices.length > 0;

	// The used range.
	if (scan.dimension && anyCellChange) {
		let top = MAX_ROWS,
			left = MAX_COLS,
			bottom = -1,
			right = -1;
		for (const c of engine.cells(info.id)) {
			if (c.row < top) top = c.row;
			if (c.row > bottom) bottom = c.row;
			if (c.col < left) left = c.col;
			if (c.col > right) right = c.col;
		}
		const ref = bottom < 0 ? 'A1' : areaA1({ top, left, bottom, right });
		const d = scan.dimension;
		if (d.attrs.ref !== ref)
			splices.push({
				start: d.start,
				end: d.tagEnd,
				text: setAttr(xml.slice(d.start, d.tagEnd), 'ref', ref)
			});
	}

	// Column widths.
	const origCols = scan.colEls.map(colInfoOf).filter((c): c is ColInfo => c !== null);
	const colKey = (cs: ColInfo[]) =>
		JSON.stringify(cs.map((c) => [c.min, c.max, c.width ?? null, !!c.hidden, c.style ?? null]));
	const curCols = info.cols.map((c) =>
		c.style === undefined ? c : { ...c, style: ctx.sameStyles ? c.style : -1 }
	);
	if (
		colKey(curCols) !==
		colKey(
			ctx.sameStyles
				? origCols
				: origCols.map((c) => (c.style === undefined ? c : { ...c, style: -1 }))
		)
	) {
		const p = ctx.prefix;
		// What the model does not hold (bestFit, outlineLevel, collapsed) comes from
		// the file's column that held these columns.
		const held = scan.colEls.flatMap((attrs) => {
			const ci = colInfoOf(attrs);
			const lo = ci && currentOf(steps, 0, ci.min)?.col;
			const hi = ci && currentOf(steps, 0, ci.max)?.col;
			if (lo === null || lo === undefined || hi === null || hi === undefined) return [];
			const rest = Object.entries(attrs)
				.filter(([k]) => !COL_MODEL_ATTRS.has(k))
				.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
				.join('');
			return rest ? [{ lo, hi, rest }] : [];
		});
		const restOf = (c: ColInfo) => held.find((h) => c.min >= h.lo && c.max <= h.hi)?.rest ?? '';
		const cols = info.cols
			.filter((c) => c.width !== undefined || c.hidden || c.style !== undefined || restOf(c))
			.map((c) => {
				const s = c.style === undefined ? 0 : ctx.xfOf(c.style);
				return `<${p}col min="${c.min + 1}" max="${c.max + 1}" width="${c.width ?? info.defaultColWidth}"${c.width !== undefined ? ' customWidth="1"' : ''}${c.hidden ? ' hidden="1"' : ''}${s ? ` style="${s}"` : ''}${restOf(c)}/>`;
			})
			.join('');
		const el = cols ? `<${p}cols>${cols}</${p}cols>` : '';
		if (scan.cols) splices.push({ start: scan.cols.start, end: scan.cols.end, text: el });
		else if (el && sd) splices.push({ start: sd.start, end: sd.start, text: el });
	}

	// Merged cells.
	const mergeKey = (ms: Area[]) => ms.map(areaA1).sort().join(' ');
	if (mergeKey(info.merges) !== mergeKey(scan.merges)) {
		const p = ctx.prefix;
		const el =
			info.merges.length > 0
				? `<${p}mergeCells count="${info.merges.length}">${info.merges.map((m) => `<${p}mergeCell ref="${areaA1(m)}"/>`).join('')}</${p}mergeCells>`
				: '';
		if (scan.mergeCells)
			splices.push({ start: scan.mergeCells.start, end: scan.mergeCells.end, text: el });
		else if (el) {
			const after = [
				'sheetData',
				'sheetCalcPr',
				'sheetProtection',
				'protectedRanges',
				'scenarios',
				'autoFilter',
				'sortState',
				'dataConsolidate',
				'customSheetViews'
			]
				.map((n) => scan.present.get(n))
				.filter((s): s is Span => s !== undefined)
				.reduce((m, s) => Math.max(m, s.end), -1);
			if (after >= 0) splices.push({ start: after, end: after, text: el });
		}
	}

	// References outside the cells, when rows or columns moved.
	if (steps.length > 0) {
		for (const span of scan.refs) {
			if (span.text !== undefined && span.textStart !== undefined && span.textEnd !== undefined) {
				let ast;
				try {
					ast = parseFormula(span.text);
				} catch {
					continue;
				}
				let next = ast;
				for (const s of steps)
					next = shiftFormula(next, { sheet: ctx.sheetName, ...s }, ctx.sheetName);
				if (next !== ast)
					splices.push({ start: span.textStart, end: span.textEnd, text: escapeXml(print(next)) });
				continue;
			}
			let tag = xml.slice(span.start, span.tagEnd);
			let gone = false;
			for (const attr of REF_ATTRS[span.name] ?? []) {
				const v = span.attrs[attr];
				if (v === undefined) continue;
				const areas = v
					.split(/\s+/)
					.filter(Boolean)
					.map((r) => {
						const a = parseArea(r);
						return a ? currentArea(steps, a) : null;
					});
				const kept = areas.filter((a): a is Area => a !== null);
				if (kept.length === 0) {
					gone = true;
					break;
				}
				tag = setAttr(tag, attr, kept.map(areaA1).join(' '));
			}
			if (
				gone &&
				(span.name === 'conditionalFormatting' ||
					span.name === 'dataValidation' ||
					span.name === 'hyperlink')
			) {
				splices.push({ start: span.start, end: span.end, text: '' });
			} else if (!gone && tag !== xml.slice(span.start, span.tagEnd)) {
				splices.push({ start: span.start, end: span.tagEnd, text: tag });
			}
		}
	}

	if (splices.length === 0) return { xml, changed: false, formulasMoved, staleText };
	splices.sort((a, b) => a.start - b.start || a.end - b.end);
	let out = '';
	let at = 0;
	for (const s of splices) {
		if (s.start < at) continue;
		out += xml.slice(at, s.start) + s.text;
		at = s.end;
	}
	out += xml.slice(at);
	// A validation removed above leaves its parent's count behind.
	out = out.replace(
		new RegExp(
			`<${ctx.prefix}dataValidations(\\s[^>]*)?>([\\s\\S]*?)</${ctx.prefix}dataValidations>`
		),
		(whole, attrs: string | undefined, inner: string) => {
			const n = (inner.match(new RegExp(`<${ctx.prefix}dataValidation[\\s>/]`, 'g')) ?? []).length;
			if (n === 0) return '';
			if (!attrs || !/\scount\s*=/.test(attrs)) return whole;
			const open = `<${ctx.prefix}dataValidations${attrs}>`;
			return setAttr(open, 'count', String(n)) + whole.slice(open.length);
		}
	);
	return { xml: out, changed: true, formulasMoved, staleText };
}

const TEMPLATE_SHEET = (prefix: string, info: SheetInfo) => {
	const pane =
		info.frozen && (info.frozen.rows > 0 || info.frozen.cols > 0)
			? `<sheetViews><sheetView workbookViewId="0"><pane${info.frozen.cols ? ` xSplit="${info.frozen.cols}"` : ''}${info.frozen.rows ? ` ySplit="${info.frozen.rows}"` : ''} topLeftCell="${a1(info.frozen.rows, info.frozen.cols)}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>`
			: '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
		`<${prefix}worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><dimension ref="A1"/>${pane}` +
		`<sheetFormatPr defaultRowHeight="${info.defaultRowHeight}"/><sheetData/></${prefix}worksheet>`
	);
};

const enc = new TextEncoder();

async function template(date1904: boolean): Promise<Uint8Array> {
	const files: [string, string][] = [
		[
			'[Content_Types].xml',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="' +
				CT.styles +
				'"/></Types>'
		],
		[
			'_rels/.rels',
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
		],
		[
			'xl/workbook.xml',
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">${date1904 ? '<workbookPr date1904="1"/>' : ''}<bookViews><workbookView/></bookViews><sheets/></workbook>`
		],
		[
			'xl/_rels/workbook.xml.rels',
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${TYPES.styles}" Target="styles.xml"/></Relationships>`
		],
		['xl/styles.xml', TEMPLATE_STYLES]
	];
	return writeZip(
		null,
		files.map(([name, text]) => ({ name, data: enc.encode(text) }))
	);
}

/** Takes elements out of a part by a test on their attributes. */
function removeElements(
	xml: string,
	name: string,
	test: (attrs: Record<string, string>) => boolean
): string {
	const spans = findSpans(xml, (n) => local(n) === name).filter((s) => test(s.attrs));
	for (const s of spans.reverse()) xml = xml.slice(0, s.start) + xml.slice(s.end);
	return xml;
}

/**
 * Writes the workbook. Given the `.xlsx` it was opened from, it writes into it
 * and keeps what did not change; otherwise it writes a new package.
 */
export async function writeXlsx(book: Book, original?: Uint8Array): Promise<Uint8Array> {
	const same = original !== undefined && book.source.format === 'xlsx';
	const zip = readZip(same ? original : await template(book.date1904));
	const pkg = await readPackage(zip);
	const engine = book.engine;
	const theme = themeColors(pkg.themePath ? await partText(zip, pkg.themePath) : null);
	const stylesXml =
		(pkg.stylesPath ? await partText(zip, pkg.stylesPath) : null) ?? TEMPLATE_STYLES;
	const stylesPart = readStyles(stylesXml, theme);
	const appender = new StyleAppender(stylesXml, stylesPart);
	const sstXml = pkg.sstPath ? await partText(zip, pkg.sstPath) : null;
	const strings = new StringTable(readStrings(sstXml));
	const xfOf = (id: number) => {
		if (id === 0) return 0;
		if (same && id < book.source.styles) return id;
		return appender.xfOf(book.styles[id] ?? book.styles[0]);
	};
	const changes: ZipChange[] = [];
	const remove = new Set<string>();
	const ct = new ContentTypes((await partText(zip, '[Content_Types].xml')) ?? '');
	const relsText = { removeIds: new Set<string>() };
	let formulasMoved = false;
	const ordered = book.ordered();
	// Excel recalculates on open what could not be brought up to date here.
	let needFullCalc =
		engine.health.stale > 0 ||
		engine.health.cycles > 0 ||
		(ordered.some((s) => s.steps.length > 0) &&
			ordered.some((s) =>
				[...engine.cells(s.id)].some((c) => c.formula && c.formula.status !== 'ok')
			));
	const origins = new Set(
		ordered.map((s) => (same ? s.origin : null)).filter((o): o is number => o !== null)
	);

	// Sheets of the file that were deleted.
	for (const [origin, idx] of pkg.grid.entries()) {
		if (origins.has(origin)) continue;
		const el = pkg.sheets[idx];
		if (el.path) {
			remove.add(el.path);
			remove.add(relsPathOf(el.path));
			const text = await partText(zip, el.path);
			if (text && /<(\w+:)?f[\s>]/.test(text)) formulasMoved = true;
			if (text) strings.refsDelta -= (text.match(/<(?:\w+:)?c\s[^>]*\bt="s"/g) ?? []).length;
		}
		relsText.removeIds.add(el.rid);
	}
	if (remove.size > 0) await dropOrphans(zip, remove);

	// Each sheet, patched into its part or written new.
	const sheetEls: string[] = [];
	const usedPaths = new Set(zip.entries.map((e) => e.name));
	let nextSheetId = Math.max(0, ...pkg.sheets.map((s) => s.sheetId)) + 1;
	const ridPrefix = /\s(\w+):id="/.exec(pkg.workbook.slice(...spanOfSheets(pkg)))?.[1] ?? 'r';
	for (const info of ordered) {
		const name = engine.sheetName(info.id);
		const origin = same ? info.origin : null;
		let path: string;
		let source: string;
		let elText: string;
		if (origin !== null && pkg.sheets[pkg.grid[origin]]?.path) {
			const el = pkg.sheets[pkg.grid[origin]];
			path = el.path as string;
			source = (await partText(zip, path)) ?? TEMPLATE_SHEET('', info);
			elText = pkg.workbook.slice(el.start, el.end);
		} else {
			let n = 1;
			while (usedPaths.has(`xl/worksheets/sheet${n}.xml`)) n++;
			path = `xl/worksheets/sheet${n}.xml`;
			usedPaths.add(path);
			source = TEMPLATE_SHEET('', info);
			const rid = pkg.rels.ensure(TYPES.worksheet, resolveRelative(pkg.workbookPath, path));
			ct.ensureOverride(path, CT.worksheet);
			elText = `<sheet name="" sheetId="${nextSheetId++}" ${ridPrefix}:id="${rid}"/>`;
		}
		elText = setAttr(elText, 'name', name);
		elText = setAttr(
			elText,
			'state',
			info.hidden
				? /\sstate\s*=\s*["']veryHidden["']/.test(elText)
					? 'veryHidden'
					: 'hidden'
				: null
		);
		sheetEls.push(elText);
		const scan = scanSheet(source, strings.base, engine.date1904, { cells: SHEET_LIMITS.cells });
		// Cells point at formats we could not read: writing would drop them.
		if (
			same &&
			stylesPart.styles.length === 0 &&
			scan.rows.some((r) => r.cells.some((c) => c.s > 0))
		)
			throw new XlsxError('cell formats not readable');
		const patched = patchSheet(source, scan, info, {
			book,
			strings,
			xfOf,
			sameStyles: same,
			sheetName: name,
			prefix: scan.prefix
		});
		if (patched.formulasMoved) formulasMoved = true;
		if (patched.staleText) needFullCalc = true;
		if (patched.changed || origin === null)
			changes.push({ name: path, data: enc.encode(patched.xml) });
	}

	// The workbook part.
	let wb = pkg.workbook;
	const [sStart, sEnd] = spanOfSheets(pkg);
	const origEls = pkg.sheets.map((s) => pkg.workbook.slice(s.start, s.end));
	const gridSet = new Set(pkg.grid);
	const listed: string[] = [];
	let g = 0;
	for (const i of pkg.sheets.keys()) {
		if (!gridSet.has(i)) listed.push(origEls[i]);
		else if (origins.has(pkg.grid.indexOf(i)) && g < sheetEls.length) listed.push(sheetEls[g++]);
	}
	while (g < sheetEls.length) listed.push(sheetEls[g++]);
	// Where each sheet of the file is listed now, found by its relationship id.
	const newIndex = new Map<number, number>();
	for (const [i, s] of pkg.sheets.entries()) {
		const at = listed.findIndex((t) => t.includes(`:id="${s.rid}"`));
		if (at >= 0) newIndex.set(i, at);
	}
	const sheetsChanged = listed.join('') !== origEls.join('');
	if (sheetsChanged) {
		const prefix = /^<(\w+:)?sheets/.exec(pkg.workbook.slice(sStart, sEnd))?.[1] ?? '';
		const openTag =
			/^<[^>]*?>/.exec(pkg.workbook.slice(sStart, sEnd))?.[0].replace(/\/>$/, '>') ??
			`<${prefix}sheets>`;
		wb = wb.slice(0, sStart) + `${openTag}${listed.join('')}</${prefix}sheets>` + wb.slice(sEnd);
		formulasMoved = true;
	}
	wb = rewriteNames(wb, book, pkg, newIndex);
	if (sheetsChanged) {
		wb = wb.replace(
			/<((?:\w+:)?workbookView)\b([^>]*?)(\/?)>/,
			(m, n: string, attrs: string, close: string) => {
				let t = `<${n}${attrs}${close}>`;
				for (const a of ['activeTab', 'firstSheet']) {
					const v = Number(new RegExp(`\\s${a}\\s*=\\s*["'](\\d+)["']`).exec(attrs)?.[1] ?? 0);
					if (v >= listed.length) t = setAttr(t, a, '0');
				}
				return t;
			}
		);
	}
	if (needFullCalc) wb = withFullCalc(wb);
	if (wb !== pkg.workbook) changes.push({ name: pkg.workbookPath, data: enc.encode(wb) });

	// Shared strings, appended.
	if (strings.added.length > 0 || (strings.refsDelta !== 0 && sstXml !== null)) {
		const added = strings.added
			.map(
				(t) => `<si><t${/^\s|\s$/.test(t) ? ' xml:space="preserve"' : ''}>${escapeXml(t)}</t></si>`
			)
			.join('');
		let sst =
			sstXml ??
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${MAIN_NS}" count="0" uniqueCount="0"></sst>`;
		sst = spliceBeforeClose(sst, 'sst', added);
		const unique = strings.base.texts.length + strings.added.length;
		sst = sst.replace(/<((?:\w+:)?sst)\b([^>]*)>/, (m, n: string, attrs: string) => {
			let t = `<${n}${attrs}>`;
			const count = Number(/\scount\s*=\s*["'](\d+)["']/.exec(attrs)?.[1] ?? NaN);
			if (Number.isFinite(count))
				t = setAttr(t, 'count', String(Math.max(0, count + strings.refsDelta)));
			if (/uniqueCount=/.test(attrs)) t = setAttr(t, 'uniqueCount', String(unique));
			return t;
		});
		const path = pkg.sstPath ?? 'xl/sharedStrings.xml';
		if (!pkg.sstPath) {
			pkg.rels.ensure(TYPES.sharedStrings, resolveRelative(pkg.workbookPath, path));
			ct.ensureOverride(path, CT.sharedStrings);
		}
		changes.push({ name: path, data: enc.encode(sst) });
	}

	// Styles, appended.
	if (appender.changed) {
		const path = pkg.stylesPath ?? 'xl/styles.xml';
		if (!pkg.stylesPath) {
			pkg.rels.ensure(TYPES.styles, resolveRelative(pkg.workbookPath, path));
			ct.ensureOverride(path, CT.styles);
		}
		changes.push({ name: path, data: enc.encode(appender.text()) });
	}

	// The calculation chain lists formula cells; when that list changed it goes, and Excel rebuilds it.
	if (formulasMoved && pkg.calcChainPath && zip.get(pkg.calcChainPath)) {
		remove.add(pkg.calcChainPath);
		const rel = pkg.rels.byType(TYPES.calcChain);
		if (rel) relsText.removeIds.add(rel.id);
	}

	let relsOut = pkg.rels.text();
	if (relsText.removeIds.size > 0)
		relsOut = removeElements(relsOut, 'Relationship', (a) => relsText.removeIds.has(a.Id ?? ''));
	const relsPath = relsPathOf(pkg.workbookPath);
	const relsOrig = await partText(zip, relsPath);
	if (relsOut !== relsOrig) changes.push({ name: relsPath, data: enc.encode(relsOut) });
	let ctOut = ct.text();
	if (remove.size > 0)
		ctOut = removeElements(ctOut, 'Override', (a) =>
			remove.has((a.PartName ?? '').replace(/^\//, ''))
		);
	if (ctOut !== (await partText(zip, '[Content_Types].xml'))) {
		changes.push({ name: '[Content_Types].xml', data: enc.encode(ctOut) });
	}
	const base: ZipArchive = {
		entries: zip.entries.filter((e) => !remove.has(e.name)),
		get: (n) => (remove.has(n) ? undefined : zip.get(n))
	};
	return writeZip(
		base,
		changes.filter((c) => !remove.has(c.name))
	);
}

/**
 * Adds to `remove` the parts only removed parts reached, such as a deleted
 * sheet's drawings, comments and tables, and their relationships; a part that
 * anything kept still points at stays.
 */
async function dropOrphans(zip: ZipArchive, remove: Set<string>): Promise<void> {
	const targets = async (part: string) => {
		const text = await partText(zip, relsPathOf(part));
		if (text === null) return [];
		return new Rels('', text).list
			.filter((r) => !r.external)
			.map((r) => resolveTarget(part, r.target))
			.filter((t) => zip.get(t) !== undefined);
	};
	const reach = async (from: string[], skip: Set<string>) => {
		const seen = new Set<string>();
		const stack = [...from];
		while (stack.length > 0) {
			for (const t of await targets(stack.pop() as string)) {
				if (seen.has(t) || skip.has(t)) continue;
				seen.add(t);
				stack.push(t);
			}
		}
		return seen;
	};
	const gone = await reach([...remove], remove);
	if (gone.size === 0) return;
	// Every part with relationships that is not going, the package itself included.
	const kept = zip.entries
		.map((e) => /^(.*?)_rels\/([^/]*)\.rels$/.exec(e.name))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => m[1] + m[2])
		.filter((part) => !remove.has(part) && !gone.has(part));
	for (const part of await reach(kept, remove)) gone.delete(part);
	for (const part of gone) {
		remove.add(part);
		remove.add(relsPathOf(part));
	}
}

function spanOfSheets(pkg: Package): [number, number] {
	const s = findSpans(pkg.workbook, (n, depth) => depth === 1 && local(n) === 'sheets')[0];
	return s ? [s.start, s.end] : [0, 0];
}

/** A target from the workbook's folder to a part. */
function resolveRelative(from: string, to: string): string {
	const dir = from.slice(0, from.lastIndexOf('/') + 1);
	return to.startsWith(dir) ? to.slice(dir.length) : `/${to}`;
}

/** Defined names after their references moved, and with their sheets' new positions. */
function rewriteNames(wb: string, book: Book, pkg: Package, newIndex: Map<number, number>): string {
	const spans = findSpans(wb, (n) => local(n) === 'definedName');
	if (spans.length === 0) return wb;
	const byKey = new Map(
		book.engine.names.filter((n) => n.key !== undefined).map((n) => [n.key as number, n])
	);
	let out = '';
	let at = 0;
	spans.forEach((s, k) => {
		const name = byKey.get(k);
		const el = wb.slice(s.start, s.end);
		let next = el;
		const lid = s.attrs.localSheetId;
		const idx = lid === undefined ? undefined : newIndex.get(Number(lid));
		if (!name || (lid !== undefined && idx === undefined)) next = '';
		else {
			const textNow = parseXml(el)
				.children.map((c) => ('text' in c ? c.text : ''))
				.join('');
			if (textNow !== name.text) {
				const open = /^<[^>]*>/.exec(el)?.[0] ?? '';
				const tagName = /^<([^\s/>]+)/.exec(open)?.[1] ?? 'definedName';
				next = `${open.replace(/\/>$/, '>')}${escapeXml(name.text)}</${tagName}>`;
			}
			if (idx !== undefined && String(idx) !== lid) {
				const open = /^<[^>]*>/.exec(next)?.[0] ?? '';
				next = setAttr(open, 'localSheetId', String(idx)) + next.slice(open.length);
			}
		}
		out += wb.slice(at, s.start) + next;
		at = s.end;
	});
	out += wb.slice(at);
	return out.replace(/<((?:\w+:)?definedNames)(\s[^>]*)?>\s*<\/\1>/, '');
}

function withFullCalc(wb: string): string {
	const calc = /<((?:\w+:)?calcPr)\b([^>]*?)(\/?)>/.exec(wb);
	if (calc) {
		const tag = setAttr(calc[0], 'fullCalcOnLoad', '1');
		return wb.slice(0, calc.index) + tag + wb.slice(calc.index + calc[0].length);
	}
	const prefix = /^[\s\S]*?<(\w+:)?workbook[\s>]/.exec(wb)?.[1] ?? '';
	for (const after of ['definedNames', 'externalReferences', 'functionGroups', 'sheets']) {
		const s = findSpans(wb, (n, d) => d === 1 && local(n) === after)[0];
		if (s) return wb.slice(0, s.end) + `<${prefix}calcPr fullCalcOnLoad="1"/>` + wb.slice(s.end);
	}
	return spliceBeforeClose(wb, 'workbook', `<${prefix}calcPr fullCalcOnLoad="1"/>`);
}
