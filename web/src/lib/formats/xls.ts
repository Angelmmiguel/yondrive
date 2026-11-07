/**
 * `.xls`, Excel 97 to 2003 (BIFF8 in a compound file), best effort: cell values,
 * shared strings, the cached results of formulas, and the formulas themselves
 * where their tokens map to the engine's syntax; number formats, fonts, fills,
 * borders and alignment; merged cells, column widths and row heights. It is
 * only ever read; saving converts to `.xlsx` and the original stays in
 * Versions. A formula that does not map keeps its last value, and what is not
 * read at all (charts, pictures, comments, macros, validation, conditional
 * formats) is named in the census as not carried over.
 */
import { MAX_COLS, MAX_ROWS, type Area } from '$lib/formula/address';
import { print, rangeOf, type BinaryOp, type Node } from '$lib/formula/ast';
import { Engine, type Cell } from '$lib/formula/engine';
import { BUILTIN_FORMATS } from '$lib/formula/numfmt';
import { err, type ErrorCode, type Scalar } from '$lib/formula/values';
import { readCfb } from './cfb';
import { Tally } from './model';
import { Book, type CellStyle, type ColInfo, type Edge, type OpenedSheets } from './workbook';
import { PALETTE } from './xlsx-styles';

export class XlsError extends Error {}

export const XLS_LIMITS = { records: 4_000_000, cells: 2_000_000, strings: 2_000_000, xfs: 65000 };

const BIFF_MAX_ROWS = 65536;

interface Rec {
	type: number;
	data: Uint8Array;
	/** Offset of the record in the stream. */
	at: number;
}

function records(stream: Uint8Array): Rec[] {
	const out: Rec[] = [];
	const v = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
	let p = 0;
	while (p + 4 <= stream.length) {
		const type = v.getUint16(p, true);
		const len = v.getUint16(p + 2, true);
		if (p + 4 + len > stream.length) break;
		out.push({ type, data: stream.subarray(p + 4, p + 4 + len), at: p });
		if (out.length > XLS_LIMITS.records) throw new XlsError('too many records');
		p += 4 + len;
	}
	return out;
}

/** Reads across a record and the CONTINUE records after it, as strings in the SST span them. */
class Reader {
	#seg = 0;
	#off = 0;
	constructor(readonly segs: Uint8Array[]) {}

	#need() {
		while (this.#seg < this.segs.length && this.#off >= this.segs[this.#seg].length) {
			this.#seg++;
			this.#off = 0;
		}
		if (this.#seg >= this.segs.length) throw new XlsError('record ends early');
	}

	u8(): number {
		this.#need();
		return this.segs[this.#seg][this.#off++];
	}

	u16(): number {
		return this.u8() | (this.u8() << 8);
	}

	u32(): number {
		return (this.u16() | (this.u16() << 16)) >>> 0;
	}

	skip(n: number) {
		for (let i = 0; i < n; i++) this.u8();
	}

	get done(): boolean {
		return (
			this.#seg >= this.segs.length ||
			(this.#seg === this.segs.length - 1 && this.#off >= this.segs[this.#seg].length)
		);
	}

	/** XLUnicodeRichExtendedString: a new flags byte starts each continued piece of characters. */
	string(cchBytes: 1 | 2 = 2): string {
		const cch = cchBytes === 1 ? this.u8() : this.u16();
		let flags = this.u8();
		const runs = flags & 0x08 ? this.u16() : 0;
		const ext = flags & 0x04 ? this.u32() : 0;
		let out = '';
		let left = cch;
		while (left > 0) {
			if (this.#seg < this.segs.length && this.#off >= this.segs[this.#seg].length) {
				this.#need();
				flags = this.u8();
			}
			this.#need();
			const seg = this.segs[this.#seg];
			const wide = (flags & 1) === 1;
			const avail = Math.floor((seg.length - this.#off) / (wide ? 2 : 1));
			const take = Math.min(left, avail);
			if (take <= 0) {
				this.#off = seg.length;
				continue;
			}
			for (let i = 0; i < take; i++) {
				out += String.fromCharCode(
					wide ? seg[this.#off] | (seg[this.#off + 1] << 8) : seg[this.#off]
				);
				this.#off += wide ? 2 : 1;
			}
			left -= take;
		}
		this.skip(runs * 4 + ext);
		return out;
	}
}

const one = (data: Uint8Array) => new Reader([data]);

function rk(v: number): number {
	let n: number;
	if (v & 2) n = v >> 2;
	else {
		const b = new DataView(new ArrayBuffer(8));
		b.setUint32(4, v & 0xfffffffc, true);
		n = b.getFloat64(0, true);
	}
	return v & 1 ? n / 100 : n;
}

const ERRORS: Record<number, ErrorCode> = {
	0x00: '#NULL!',
	0x07: '#DIV/0!',
	0x0f: '#VALUE!',
	0x17: '#REF!',
	0x1d: '#NAME?',
	0x24: '#NUM!',
	0x2a: '#N/A'
};

/** Function numbers of BIFF8, with the argument count of the fixed ones. */
const FUNCS: Record<number, [string, number?]> = {
	0: ['COUNT'],
	1: ['IF'],
	2: ['ISNA', 1],
	3: ['ISERROR', 1],
	4: ['SUM'],
	5: ['AVERAGE'],
	6: ['MIN'],
	7: ['MAX'],
	8: ['ROW'],
	9: ['COLUMN'],
	10: ['NA', 0],
	12: ['STDEV'],
	13: ['DOLLAR'],
	14: ['FIXED'],
	15: ['SIN', 1],
	16: ['COS', 1],
	17: ['TAN', 1],
	18: ['ATAN', 1],
	19: ['PI', 0],
	20: ['SQRT', 1],
	21: ['EXP', 1],
	22: ['LN', 1],
	23: ['LOG10', 1],
	24: ['ABS', 1],
	25: ['INT', 1],
	26: ['SIGN', 1],
	27: ['ROUND', 2],
	28: ['LOOKUP'],
	29: ['INDEX'],
	30: ['REPT', 2],
	31: ['MID', 3],
	32: ['LEN', 1],
	33: ['VALUE', 1],
	34: ['TRUE', 0],
	35: ['FALSE', 0],
	36: ['AND'],
	37: ['OR'],
	38: ['NOT', 1],
	39: ['MOD', 2],
	46: ['VAR'],
	48: ['TEXT', 2],
	56: ['PV'],
	57: ['FV'],
	58: ['NPER'],
	59: ['PMT'],
	60: ['RATE'],
	63: ['RAND', 0],
	64: ['MATCH'],
	65: ['DATE', 3],
	66: ['TIME', 3],
	67: ['DAY', 1],
	68: ['MONTH', 1],
	69: ['YEAR', 1],
	70: ['WEEKDAY'],
	71: ['HOUR', 1],
	72: ['MINUTE', 1],
	73: ['SECOND', 1],
	74: ['NOW', 0],
	75: ['AREAS', 1],
	76: ['ROWS', 1],
	77: ['COLUMNS', 1],
	78: ['OFFSET'],
	82: ['SEARCH'],
	86: ['TYPE', 1],
	97: ['ATAN2', 2],
	98: ['ASIN', 1],
	99: ['ACOS', 1],
	100: ['CHOOSE'],
	101: ['HLOOKUP'],
	102: ['VLOOKUP'],
	105: ['ISREF', 1],
	109: ['LOG'],
	111: ['CHAR', 1],
	112: ['LOWER', 1],
	113: ['UPPER', 1],
	114: ['PROPER', 1],
	115: ['LEFT'],
	116: ['RIGHT'],
	117: ['EXACT', 2],
	118: ['TRIM', 1],
	119: ['REPLACE', 4],
	120: ['SUBSTITUTE'],
	121: ['CODE', 1],
	124: ['FIND'],
	125: ['CELL'],
	126: ['ISERR', 1],
	127: ['ISTEXT', 1],
	128: ['ISNUMBER', 1],
	129: ['ISBLANK', 1],
	130: ['T', 1],
	131: ['N', 1],
	140: ['DATEVALUE', 1],
	141: ['TIMEVALUE', 1],
	148: ['INDIRECT'],
	162: ['CLEAN', 1],
	169: ['COUNTA'],
	183: ['PRODUCT'],
	184: ['FACT', 1],
	190: ['ISNONTEXT', 1],
	193: ['STDEVP'],
	194: ['VARP'],
	197: ['TRUNC'],
	198: ['ISLOGICAL', 1],
	212: ['ROUNDUP', 2],
	213: ['ROUNDDOWN', 2],
	216: ['RANK'],
	219: ['ADDRESS'],
	220: ['DAYS360'],
	221: ['TODAY', 0],
	227: ['MEDIAN'],
	228: ['SUMPRODUCT'],
	279: ['EVEN', 1],
	285: ['FLOOR', 2],
	288: ['CEILING', 2],
	298: ['ODD', 1],
	325: ['LARGE', 2],
	326: ['SMALL', 2],
	336: ['CONCATENATE'],
	337: ['POWER', 2],
	342: ['RADIANS', 1],
	343: ['DEGREES', 1],
	344: ['SUBTOTAL'],
	345: ['SUMIF'],
	346: ['COUNTIF', 2],
	347: ['COUNTBLANK', 1],
	351: ['DATEDIF', 3]
};

class Unmapped extends Error {}

interface FormulaCtx {
	row: number;
	col: number;
	/** Sheet names by EXTERNSHEET index; undefined where it is not this workbook's one sheet. */
	sheetOf: (ixti: number) => string | undefined;
}

/** BIFF8 formula tokens as a tree, or Unmapped. `relative` reads RefN and AreaN against the cell. */
function decompile(rgce: Uint8Array, ctx: FormulaCtx): Node {
	const v = new DataView(rgce.buffer, rgce.byteOffset, rgce.byteLength);
	const stack: Node[] = [];
	let p = 0;
	const pop = (): Node => {
		const n = stack.pop();
		if (!n) throw new Unmapped('stack');
		return n;
	};
	const need = (n: number) => {
		if (p + n > rgce.length) throw new Unmapped('short');
	};
	const cellOf = (rw: number, colField: number, relative: boolean) => {
		const colRel = (colField & 0x4000) !== 0;
		const rowRel = (colField & 0x8000) !== 0;
		let col = colField & 0x3fff;
		let row = rw;
		if (relative) {
			if (rowRel) row = (ctx.row + ((rw << 16) >> 16) + BIFF_MAX_ROWS) % BIFF_MAX_ROWS;
			if (colRel) col = (ctx.col + ((col << 24) >> 24) + 256) % 256;
		}
		if (row >= MAX_ROWS || col >= MAX_COLS) throw new Unmapped('out of grid');
		return { row, col, rowAbs: !rowRel, colAbs: !colRel };
	};
	const BIN: Record<number, BinaryOp> = {
		0x03: '+',
		0x04: '-',
		0x05: '*',
		0x06: '/',
		0x07: '^',
		0x08: '&',
		0x09: '<',
		0x0a: '<=',
		0x0b: '=',
		0x0c: '>=',
		0x0d: '>',
		0x0e: '<>'
	};
	while (p < rgce.length) {
		const ptg = rgce[p++];
		const base = ptg & 0x1f;
		const cls = ptg & 0x60;
		if (ptg < 0x20 && BIN[ptg]) {
			const right = pop();
			const left = pop();
			stack.push({ type: 'binary', op: BIN[ptg], left, right });
			continue;
		}
		switch (ptg) {
			case 0x11: {
				const b = pop();
				const a = pop();
				if (a.type !== 'cell' || b.type !== 'cell' || a.sheet !== b.sheet)
					throw new Unmapped('range');
				stack.push(rangeOf('cells', a.sheet, a, b));
				continue;
			}
			case 0x12:
				stack.push({ type: 'unary', op: '+', arg: pop() });
				continue;
			case 0x13:
				stack.push({ type: 'unary', op: '-', arg: pop() });
				continue;
			case 0x14:
				stack.push({ type: 'percent', arg: pop() });
				continue;
			case 0x15:
				stack.push({ type: 'paren', expr: pop() });
				continue;
			case 0x16:
				stack.push({ type: 'missing' });
				continue;
			case 0x17: {
				need(2);
				const r = new Reader([rgce.subarray(p)]);
				const cch = rgce[p];
				const wide = rgce[p + 1] & 1;
				stack.push({ type: 'string', value: r.string(1) });
				p += 2 + cch * (wide ? 2 : 1);
				continue;
			}
			case 0x19: {
				need(3);
				const flags = rgce[p];
				const data = v.getUint16(p + 1, true);
				p += 3;
				if (flags & 0x04) p += 2 * (data + 1);
				else if (flags & 0x10) stack.push({ type: 'call', name: 'SUM', prefix: '', args: [pop()] });
				continue;
			}
			case 0x1c:
				need(1);
				stack.push({ type: 'error', code: ERRORS[rgce[p++]] ?? '#N/A' });
				continue;
			case 0x1d:
				need(1);
				stack.push({ type: 'bool', value: rgce[p++] !== 0 });
				continue;
			case 0x1e: {
				need(2);
				const n = v.getUint16(p, true);
				p += 2;
				stack.push({ type: 'number', value: n, raw: String(n) });
				continue;
			}
			case 0x1f: {
				need(8);
				const n = v.getFloat64(p, true);
				p += 8;
				if (!Number.isFinite(n)) throw new Unmapped('number');
				stack.push({
					type: 'number',
					value: n,
					raw: String(n).replace('e+', 'E+').replace('e-', 'E-')
				});
				continue;
			}
		}
		if (cls === 0) throw new Unmapped(`ptg ${ptg}`);
		switch (base) {
			case 0x01: {
				need(2);
				const iftab = v.getUint16(p, true);
				p += 2;
				const f = FUNCS[iftab];
				if (!f || f[1] === undefined) throw new Unmapped('function');
				const args: Node[] = [];
				for (let i = 0; i < f[1]; i++) args.unshift(pop());
				stack.push({ type: 'call', name: f[0], prefix: '', args });
				continue;
			}
			case 0x02: {
				need(3);
				const count = rgce[p] & 0x7f;
				const iftab = v.getUint16(p + 1, true) & 0x7fff;
				p += 3;
				const f = FUNCS[iftab];
				if (!f) throw new Unmapped('function');
				const args: Node[] = [];
				for (let i = 0; i < count; i++) args.unshift(pop());
				stack.push({ type: 'call', name: f[0], prefix: '', args });
				continue;
			}
			case 0x04:
			case 0x0c: {
				need(4);
				stack.push({
					type: 'cell',
					...cellOf(v.getUint16(p, true), v.getUint16(p + 2, true), base === 0x0c)
				});
				p += 4;
				continue;
			}
			case 0x05:
			case 0x0d: {
				need(8);
				const rel = base === 0x0d;
				const a = cellOf(v.getUint16(p, true), v.getUint16(p + 4, true), rel);
				const b = cellOf(v.getUint16(p + 2, true), v.getUint16(p + 6, true), rel);
				p += 8;
				const whole =
					v.getUint16(p - 8, true) === 0 && v.getUint16(p - 6, true) === BIFF_MAX_ROWS - 1;
				stack.push(rangeOf(whole && !rel ? 'cols' : 'cells', undefined, a, b));
				continue;
			}
			case 0x0a:
				need(4);
				p += 4;
				stack.push({ type: 'error', code: '#REF!' });
				continue;
			case 0x0b:
				need(8);
				p += 8;
				stack.push({ type: 'error', code: '#REF!' });
				continue;
			case 0x1a:
			case 0x1b: {
				need(base === 0x1a ? 6 : 10);
				const sheet = ctx.sheetOf(v.getUint16(p, true));
				if (sheet === undefined) throw new Unmapped('3-D reference');
				if (base === 0x1a) {
					stack.push({
						type: 'cell',
						sheet,
						...cellOf(v.getUint16(p + 2, true), v.getUint16(p + 4, true), false)
					});
					p += 6;
				} else {
					const a = cellOf(v.getUint16(p + 2, true), v.getUint16(p + 6, true), false);
					const b = cellOf(v.getUint16(p + 4, true), v.getUint16(p + 8, true), false);
					p += 10;
					stack.push(rangeOf('cells', sheet, a, b));
				}
				continue;
			}
			case 0x1c:
			case 0x1d:
				need(base === 0x1c ? 6 : 10);
				p += base === 0x1c ? 6 : 10;
				stack.push({ type: 'error', code: '#REF!' });
				continue;
			case 0x06:
			case 0x07:
			case 0x08:
				need(6);
				p += 6;
				continue;
			case 0x09:
				need(2);
				p += 2;
				continue;
			default:
				throw new Unmapped(`ptg ${ptg}`);
		}
	}
	if (stack.length !== 1) throw new Unmapped('stack');
	return stack[0];
}

const DG: Record<number, string> = {
	1: 'thin',
	2: 'medium',
	3: 'dashed',
	4: 'dotted',
	5: 'thick',
	6: 'double',
	7: 'hair',
	8: 'mediumDashed',
	9: 'dashDot',
	10: 'mediumDashDot',
	11: 'dashDotDot',
	12: 'mediumDashDotDot',
	13: 'slantDashDot'
};
const H = [
	'general',
	'left',
	'center',
	'right',
	'fill',
	'justify',
	'centerContinuous',
	'distributed'
] as const;
const V = ['top', 'center', 'bottom', 'justify', 'distributed'] as const;

interface Font {
	size: number;
	italic: boolean;
	strike: boolean;
	color: number;
	bold: boolean;
	underline: boolean;
	name: string;
}

export function readXls(bytes: Uint8Array): OpenedSheets {
	const cfb = readCfb(bytes);
	const stream = cfb.get('Workbook');
	if (!stream)
		throw new XlsError(
			cfb.get('Book') ? 'Excel 5 workbooks are not supported' : 'no workbook stream'
		);
	const recs = records(stream);
	const tally = new Tally();
	const palette = [...PALETTE];
	const fonts: Font[] = [];
	const formats = new Map<number, string>();
	const xfs: number[][] = [];
	const sheets: { name: string; at: number; hidden: boolean }[] = [];
	let sst: string[] = [];
	let date1904 = false;
	const externSheets: { book: number; first: number; last: number }[] = [];
	let selfBook = -1;
	let books = 0;
	let names = 0;

	const first = recs[0];
	if (!first || first.type !== 0x0809 || one(first.data).u16() !== 0x0600)
		throw new XlsError('not a BIFF8 workbook');
	for (let i = 1; i < recs.length && recs[i].type !== 0x000a; i++) {
		const r = recs[i];
		const d = r.data;
		const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
		try {
			switch (r.type) {
				case 0x002f:
					throw new XlsError('this workbook is encrypted');
				case 0x0022:
					date1904 = d.length >= 2 && dv.getUint16(0, true) === 1;
					break;
				case 0x0085: {
					const rd = one(d);
					const at = rd.u32();
					const hidden = rd.u8() !== 0;
					const type = rd.u8();
					const name = rd.string(1);
					if (type === 0) sheets.push({ name, at, hidden });
					else tally.add(type === 2 ? 'Chart sheet' : 'Macro or module sheet', 'lost');
					break;
				}
				case 0x00fc: {
					const segs = [d];
					for (let k = i + 1; k < recs.length && recs[k].type === 0x003c; k++)
						segs.push(recs[k].data);
					const rd = new Reader(segs);
					rd.u32();
					const unique = rd.u32();
					if (unique > XLS_LIMITS.strings) throw new XlsError('too many strings');
					sst = [];
					for (let k = 0; k < unique && !rd.done; k++) sst.push(rd.string());
					break;
				}
				case 0x041e: {
					const rd = one(d);
					const id = rd.u16();
					formats.set(id, rd.string());
					break;
				}
				case 0x0031: {
					const rd = one(d);
					const size = rd.u16() / 20;
					const grbit = rd.u16();
					const color = rd.u16();
					const weight = rd.u16();
					rd.u16();
					const uls = rd.u8();
					rd.skip(3);
					fonts.push({
						size,
						italic: !!(grbit & 2),
						strike: !!(grbit & 8),
						color,
						bold: weight >= 700,
						underline: uls !== 0,
						name: rd.string(1)
					});
					break;
				}
				case 0x00e0:
					if (xfs.length >= XLS_LIMITS.xfs) throw new XlsError('too many formats');
					if (d.length >= 20)
						xfs.push([
							dv.getUint16(0, true),
							dv.getUint16(2, true),
							d[6],
							d[7],
							dv.getUint32(10, true),
							dv.getUint32(14, true),
							dv.getUint16(18, true)
						]);
					break;
				case 0x0092: {
					const n = dv.getUint16(0, true);
					for (let k = 0; k < n && 2 + k * 4 + 3 <= d.length; k++) {
						palette[8 + k] = [0, 1, 2]
							.map((c) => d[2 + k * 4 + c].toString(16).padStart(2, '0'))
							.join('');
					}
					break;
				}
				case 0x01ae:
					if (d.length >= 4 && dv.getUint16(2, true) === 0x0401) selfBook = books;
					books++;
					break;
				case 0x0017: {
					const n = dv.getUint16(0, true);
					for (let k = 0; k < n && 2 + k * 6 + 6 <= d.length; k++) {
						externSheets.push({
							book: dv.getUint16(2 + k * 6, true),
							first: dv.getUint16(4 + k * 6, true),
							last: dv.getUint16(6 + k * 6, true)
						});
					}
					break;
				}
				case 0x0018:
					names++;
					break;
				case 0x01b8:
					tally.add('Hyperlink', 'lost');
					break;
			}
		} catch (e) {
			if (e instanceof XlsError && /encrypted|too many/.test(e.message)) throw e;
			// A damaged record is skipped; what it held is not shown.
		}
	}
	if (names > 0) tally.add('Defined name', 'lost', names);
	if (cfb.names().some((n) => n.startsWith('_VBA_PROJECT_CUR'))) tally.add('Macros', 'lost');

	const color = (icv: number) => {
		const i = icv & 0x7f;
		if (i === 64 || i === 0x7f || icv === 0x7fff) return undefined;
		const hex = palette[i];
		return hex ? `#${hex.toLowerCase()}` : undefined;
	};
	const styles: CellStyle[] = xfs.map(([ifnt, ifmt, align, , borders1, borders2, fills]) => {
		const f = fonts[ifnt >= 4 ? ifnt - 1 : ifnt];
		const style: CellStyle = {
			numFmt: formats.get(ifmt) ?? BUILTIN_FORMATS[ifmt] ?? 'General',
			font: {},
			border: {},
			align: {}
		};
		if (f) {
			style.font = { name: f.name, size: f.size };
			if (f.bold) style.font.bold = true;
			if (f.italic) style.font.italic = true;
			if (f.underline) style.font.underline = true;
			if (f.strike) style.font.strike = true;
			const c = color(f.color);
			if (c && c !== '#000000') style.font.color = c;
		}
		const h = H[align & 7];
		if (h && h !== 'general') style.align.h = h;
		if (align & 8) style.align.wrap = true;
		const vv = V[(align >> 4) & 7];
		if (vv && vv !== 'bottom') style.align.v = vv;
		const edge = (dg: number, icv: number): Edge | undefined => {
			const s = DG[dg];
			if (!s) return undefined;
			const c = color(icv);
			return c ? { style: s, color: c } : { style: s };
		};
		const left = edge(borders1 & 0xf, (borders1 >>> 16) & 0x7f);
		const right = edge((borders1 >>> 4) & 0xf, (borders1 >>> 23) & 0x7f);
		const top = edge((borders1 >>> 8) & 0xf, borders2 & 0x7f);
		const bottom = edge((borders1 >>> 12) & 0xf, (borders2 >>> 7) & 0x7f);
		if (left) style.border.left = left;
		if (right) style.border.right = right;
		if (top) style.border.top = top;
		if (bottom) style.border.bottom = bottom;
		if (((borders2 >>> 26) & 0x3f) === 1) {
			const fill = color(fills & 0x7f);
			if (fill) style.fill = fill;
		}
		return style;
	});

	const engine = new Engine({ date1904 });
	const book = new Book(engine, styles, {
		format: 'xls',
		styles: styles.length,
		sheets: sheets.length
	});
	const styleOf = (ixfe: number) => (ixfe < book.styles.length ? ixfe : 0);
	const sheetOf = (ixti: number) => {
		const x = externSheets[ixti];
		if (!x || x.book !== selfBook || x.first !== x.last) return undefined;
		return sheets[x.first]?.name;
	};
	const byOffset = new Map(recs.map((r, k) => [r.at, k]));
	let budget = XLS_LIMITS.cells;
	const uncached: Cell[] = [];
	let unmapped = 0;
	const counts = new Map<string, number>();
	const count = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1);

	for (const [origin, s] of sheets.entries()) {
		let name = s.name || `Sheet${origin + 1}`;
		for (let k = 2; engine.sheetByName(name); k++) name = `${s.name} (${k})`;
		const info = book.addSheet(name, undefined, origin);
		if (s.hidden) info.hidden = true;
		const start = byOffset.get(s.at);
		if (start === undefined || recs[start].type !== 0x0809) continue;
		const shared = new Map<string, { rgce: Uint8Array; area: Area }>();
		const pendingShared: { row: number; col: number; key: string; value: Scalar; style: number }[] =
			[];
		/** Where the string result of the formula just read goes, from the STRING record after it. */
		let stringResult: ((s: string) => void) | null = null;
		let frozen = false;
		const put = (row: number, col: number, value: Scalar, ixfe: number) => {
			if (row >= MAX_ROWS || col >= MAX_COLS) return;
			if (--budget < 0) throw new XlsError('too many cells');
			engine.load(info.id, row, col, { value, style: styleOf(ixfe) });
		};
		for (let k = start + 1; k < recs.length && recs[k].type !== 0x000a; k++) {
			const r = recs[k];
			const d = r.data;
			const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
			const expecting = stringResult;
			if (r.type !== 0x0207) stringResult = null;
			try {
				switch (r.type) {
					case 0x0809: {
						// A chart or other substream inside the sheet: skip to its end.
						let depth = 1;
						while (++k < recs.length && depth > 0) {
							if (recs[k].type === 0x0809) depth++;
							else if (recs[k].type === 0x000a) depth--;
						}
						k--;
						count('Chart');
						break;
					}
					case 0x00fd:
						put(
							dv.getUint16(0, true),
							dv.getUint16(2, true),
							sst[dv.getUint32(6, true)] ?? '',
							dv.getUint16(4, true)
						);
						break;
					case 0x0203:
						put(
							dv.getUint16(0, true),
							dv.getUint16(2, true),
							dv.getFloat64(6, true),
							dv.getUint16(4, true)
						);
						break;
					case 0x027e:
						put(
							dv.getUint16(0, true),
							dv.getUint16(2, true),
							rk(dv.getUint32(6, true)),
							dv.getUint16(4, true)
						);
						break;
					case 0x00bd: {
						const row = dv.getUint16(0, true);
						const firstCol = dv.getUint16(2, true);
						const n = Math.floor((d.length - 6) / 6);
						for (let c = 0; c < n; c++)
							put(
								row,
								firstCol + c,
								rk(dv.getUint32(6 + c * 6, true)),
								dv.getUint16(4 + c * 6, true)
							);
						break;
					}
					case 0x0205: {
						const b = d[6];
						put(
							dv.getUint16(0, true),
							dv.getUint16(2, true),
							d[7] ? err(ERRORS[b] ?? '#N/A') : b !== 0,
							dv.getUint16(4, true)
						);
						break;
					}
					case 0x0204:
						put(
							dv.getUint16(0, true),
							dv.getUint16(2, true),
							one(d.subarray(6)).string(),
							dv.getUint16(4, true)
						);
						break;
					case 0x0201:
						if (dv.getUint16(4, true) > 15)
							put(dv.getUint16(0, true), dv.getUint16(2, true), null, dv.getUint16(4, true));
						break;
					case 0x00be: {
						const row = dv.getUint16(0, true);
						const firstCol = dv.getUint16(2, true);
						const n = Math.floor((d.length - 6) / 2);
						for (let c = 0; c < n; c++) {
							const ixfe = dv.getUint16(4 + c * 2, true);
							if (ixfe > 15) put(row, firstCol + c, null, ixfe);
						}
						break;
					}
					case 0x0006: {
						const row = dv.getUint16(0, true);
						const col = dv.getUint16(2, true);
						const ixfe = dv.getUint16(4, true);
						let value: Scalar;
						if (dv.getUint16(12, true) === 0xffff) {
							const t = d[6];
							value =
								t === 1 ? d[8] !== 0 : t === 2 ? err(ERRORS[d[8]] ?? '#N/A') : t === 3 ? '' : null;
						} else value = dv.getFloat64(6, true);
						const cce = dv.getUint16(20, true);
						const rgce = d.subarray(22, 22 + cce);
						const isString = dv.getUint16(12, true) === 0xffff && d[6] === 0;
						if (rgce[0] === 0x01 && rgce.length >= 5) {
							const p = {
								row,
								col,
								key: `${dv.getUint16(23, true)},${dv.getUint16(25, true)}`,
								value,
								style: ixfe
							};
							pendingShared.push(p);
							if (isString) stringResult = (t) => (p.value = t);
							break;
						}
						if (row >= MAX_ROWS || col >= MAX_COLS) break;
						if (--budget < 0) throw new XlsError('too many cells');
						let text: string | undefined;
						try {
							text = print(decompile(rgce, { row, col, sheetOf }));
						} catch (e) {
							if (!(e instanceof Unmapped)) throw e;
							unmapped++;
						}
						const cell = engine.load(info.id, row, col, {
							value,
							formula: text,
							style: styleOf(ixfe)
						});
						if (isString) stringResult = (t) => (cell.value = t);
						break;
					}
					case 0x0207:
						expecting?.(one(d).string());
						break;
					case 0x023e:
						frozen = d.length >= 2 && (dv.getUint16(0, true) & 0x08) !== 0;
						break;
					case 0x04bc: {
						const area = {
							top: dv.getUint16(0, true),
							bottom: dv.getUint16(2, true),
							left: d[4],
							right: d[5]
						};
						const cce = dv.getUint16(8, true);
						shared.set(`${area.top},${area.left}`, { rgce: d.subarray(10, 10 + cce), area });
						break;
					}
					case 0x0221:
						count('Array formula');
						break;
					case 0x00e5: {
						const n = dv.getUint16(0, true);
						for (let m = 0; m < n && 2 + m * 8 + 8 <= d.length; m++) {
							const o = 2 + m * 8;
							info.merges.push({
								top: dv.getUint16(o, true),
								bottom: dv.getUint16(o + 2, true),
								left: dv.getUint16(o + 4, true),
								right: dv.getUint16(o + 6, true)
							});
						}
						break;
					}
					case 0x007d: {
						const ci: ColInfo = {
							min: dv.getUint16(0, true),
							max: Math.min(dv.getUint16(2, true), MAX_COLS - 1),
							width: Math.round((dv.getUint16(4, true) / 256) * 100) / 100
						};
						if (dv.getUint16(8, true) & 1) ci.hidden = true;
						if (ci.max >= ci.min) info.cols.push(ci);
						break;
					}
					case 0x0208: {
						const row = dv.getUint16(0, true);
						const miy = dv.getUint16(6, true);
						const flags = dv.getUint16(12, true);
						const ri: { height?: number; hidden?: true } = {};
						if (flags & 0x40) ri.height = (miy & 0x7fff) / 20;
						if (flags & 0x20) ri.hidden = true;
						if (ri.height !== undefined || ri.hidden) info.rows.set(row, ri);
						break;
					}
					case 0x0055:
						info.defaultColWidth = dv.getUint16(0, true) + 0.71;
						break;
					case 0x0225:
						info.defaultRowHeight = dv.getUint16(2, true) / 20 || info.defaultRowHeight;
						break;
					case 0x0041: {
						const x = dv.getUint16(0, true);
						const y = dv.getUint16(2, true);
						if (frozen && (x || y)) info.frozen = { rows: y, cols: x };
						break;
					}
					case 0x001c:
						count('Comment');
						break;
					case 0x00ec:
						count('Picture or drawing');
						break;
					case 0x00b0:
						count('Pivot table');
						break;
					case 0x01b0:
						count('Conditional formatting');
						break;
					case 0x01be:
						count('Data validation');
						break;
					case 0x0012:
						if (d[0] || d[1]) count('Sheet protection');
						break;
				}
			} catch (e) {
				if (e instanceof XlsError) throw e;
				// A damaged record is skipped.
			}
		}
		for (const p of pendingShared) {
			if (p.row >= MAX_ROWS || p.col >= MAX_COLS) continue;
			if (--budget < 0) throw new XlsError('too many cells');
			const sh = shared.get(p.key);
			let text: string | undefined;
			if (sh) {
				try {
					text = print(decompile(sh.rgce, { row: p.row, col: p.col, sheetOf }));
				} catch (e) {
					if (!(e instanceof Unmapped)) throw e;
					unmapped++;
				}
			} else unmapped++;
			const cell = engine.load(info.id, p.row, p.col, {
				value: p.value,
				formula: text,
				style: styleOf(p.style)
			});
			if (text !== undefined && p.value === null) uncached.push(cell);
		}
	}
	for (const s of book.sheets)
		for (const c of engine.cells(s.id)) if (c.formula && c.value === null) uncached.push(c);
	engine.loaded(uncached);
	for (const [label, n] of counts) tally.add(label, 'lost', n);
	if (unmapped > 0) tally.add('Formula kept as its last value', 'changed', unmapped);
	return { book, census: tally.census(), fixedRanges: [] };
}
