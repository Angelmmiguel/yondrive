/**
 * `.doc`, Word 97 to 2003, best effort: the text through the piece table, with
 * bold, italic, underline, strike, font, size, colour and highlight from the
 * character runs, and alignment, headings, lists and simple tables from the
 * paragraph runs. It is only ever read; saving converts to `.docx`, and the
 * original stays in Versions. What is not read is named in the census as not
 * carried over.
 */
import { readCfb } from './cfb';
import {
	cleanMarks,
	normalizeInlines,
	Tally,
	type Align,
	type Block,
	type BlockStyle,
	type Cell,
	type Census,
	type DocModel,
	type Inline,
	type Marks,
	type Paragraph,
	type Row
} from './model';

export class DocError extends Error {}

/** The most text a document may hold, in characters. */
export const DOC_LIMITS = { chars: 32 * 1024 * 1024 };

const ICO: (string | undefined)[] = [
	undefined,
	'#000000',
	'#0000ff',
	'#00ffff',
	'#00ff00',
	'#ff00ff',
	'#ff0000',
	'#ffff00',
	'#ffffff',
	'#000080',
	'#008080',
	'#008000',
	'#800080',
	'#800000',
	'#808000',
	'#808080',
	'#c0c0c0'
];

interface Piece {
	cpStart: number;
	cpEnd: number;
	fc: number;
	compressed: boolean;
}

interface Run<T> {
	start: number;
	end: number;
	props: T;
}

interface CharProps {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	size?: number;
	color?: string;
	highlight?: string;
	font?: number;
	special?: boolean;
	deleted?: boolean;
}

interface ParaProps {
	istd: number;
	align?: Align;
	inTable?: boolean;
	rowEnd?: boolean;
	ilfo?: number;
	ilvl?: number;
	outline?: number;
}

class Reader {
	readonly v: DataView;
	readonly b: Uint8Array;
	constructor(b: Uint8Array) {
		this.b = b;
		this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	}
	need(at: number, len: number) {
		if (at < 0 || len < 0 || at + len > this.b.length) throw new DocError('read out of range');
	}
	u8(at: number) {
		this.need(at, 1);
		return this.b[at];
	}
	u16(at: number) {
		this.need(at, 2);
		return this.v.getUint16(at, true);
	}
	i16(at: number) {
		this.need(at, 2);
		return this.v.getInt16(at, true);
	}
	u32(at: number) {
		this.need(at, 4);
		return this.v.getUint32(at, true);
	}
	i32(at: number) {
		this.need(at, 4);
		return this.v.getInt32(at, true);
	}
	slice(at: number, len: number) {
		this.need(at, len);
		return this.b.subarray(at, at + len);
	}
}

/** Each property change of a grpprl: its code and operand. */
function* sprms(
	r: Reader,
	from: number,
	to: number
): Generator<{ code: number; at: number; size: number }> {
	let i = from;
	while (i + 2 <= to) {
		const code = r.u16(i);
		const spra = code >> 13;
		let size: number;
		let at = i + 2;
		switch (spra) {
			case 0:
			case 1:
				size = 1;
				break;
			case 2:
			case 4:
			case 5:
				size = 2;
				break;
			case 3:
				size = 4;
				break;
			case 7:
				size = 3;
				break;
			default:
				if (code === 0xd608 || code === 0xd606) {
					size = r.u16(at);
					at += 2;
					size -= 1;
				} else {
					size = r.u8(at);
					at += 1;
				}
		}
		if (at + size > to) return;
		yield { code, at, size };
		i = at + size;
	}
}

const toggle = (v: number, current: boolean | undefined) =>
	v === 0 ? false : v === 1 ? true : v === 0x81 ? !current : v === 0x80 ? false : current;

function charProps(r: Reader, from: number, to: number): CharProps {
	const p: CharProps = {};
	for (const s of sprms(r, from, to)) {
		const op = s.size >= 1 ? r.u8(s.at) : 0;
		switch (s.code) {
			case 0x0835:
				p.bold = toggle(op, p.bold);
				break;
			case 0x0836:
				p.italic = toggle(op, p.italic);
				break;
			case 0x0837:
			case 0x2a53:
				p.strike = toggle(op, p.strike);
				break;
			case 0x2a3e:
				p.underline = op !== 0;
				break;
			case 0x4a43:
				p.size = r.u16(s.at) / 2;
				break;
			case 0x2a42:
				p.color = ICO[op];
				break;
			case 0x6870: {
				const [red, green, blue, auto] = [
					r.u8(s.at),
					r.u8(s.at + 1),
					r.u8(s.at + 2),
					r.u8(s.at + 3)
				];
				p.color =
					auto === 0xff
						? undefined
						: `#${[red, green, blue].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
				break;
			}
			case 0x2a0c:
				p.highlight = ICO[op];
				break;
			case 0x4a4f:
				p.font = r.u16(s.at);
				break;
			case 0x0855:
				p.special = op !== 0;
				break;
			case 0x0800:
				p.deleted = op !== 0;
				break;
		}
	}
	return p;
}

function paraProps(r: Reader, from: number, to: number): ParaProps {
	const p: ParaProps = { istd: to - from >= 2 ? r.u16(from) : 0 };
	for (const s of sprms(r, from + 2, to)) {
		const op = r.u8(s.at);
		switch (s.code) {
			case 0x2403:
			case 0x2461:
				p.align = (['left', 'center', 'right', 'justify'] as Align[])[op] ?? undefined;
				break;
			case 0x2416:
				p.inTable = op !== 0;
				break;
			case 0x2417:
				p.rowEnd = op !== 0;
				break;
			case 0x460b:
				p.ilfo = r.u16(s.at);
				break;
			case 0x260a:
				p.ilvl = op;
				break;
			case 0x2640:
				p.outline = op;
				break;
			case 0x6649:
				if (r.u32(s.at) > 1) p.inTable = true;
				break;
		}
	}
	return p;
}

/** Character or paragraph runs from a PlcfBte and its formatted disk pages. */
function fkpRuns<T>(
	word: Reader,
	table: Reader,
	fc: number,
	lcb: number,
	papx: boolean,
	read: (from: number, to: number) => T
): Run<T>[] {
	if (lcb < 12) return [];
	const n = (lcb - 4) / 8;
	if (!Number.isInteger(n) || n > 100000) throw new DocError('bad bin table');
	const out: Run<T>[] = [];
	for (let i = 0; i < n; i++) {
		const pn = table.u32(fc + (n + 1) * 4 + i * 4) & 0x3fffff;
		const page = pn * 512;
		word.need(page, 512);
		const crun = word.u8(page + 511);
		if ((crun + 1) * 4 + crun * (papx ? 13 : 1) > 511) throw new DocError('bad page');
		for (let k = 0; k < crun; k++) {
			const start = word.u32(page + k * 4);
			const end = word.u32(page + (k + 1) * 4);
			const off = word.u8(page + (crun + 1) * 4 + k * (papx ? 13 : 1)) * 2;
			if (off === 0) {
				out.push({ start, end, props: read(0, 0) });
				continue;
			}
			let from: number;
			let to: number;
			if (papx) {
				const cb = word.u8(page + off);
				if (cb === 0) {
					from = page + off + 2;
					to = from + 2 * word.u8(page + off + 1);
				} else {
					from = page + off + 1;
					to = from + 2 * cb - 1;
				}
			} else {
				from = page + off + 1;
				to = from + word.u8(page + off);
			}
			if (to > page + 512) throw new DocError('bad run');
			out.push({ start, end, props: read(from, to) });
		}
	}
	return out.sort((a, b) => a.start - b.start);
}

function find<T>(runs: Run<T>[], fc: number): T | undefined {
	let lo = 0;
	let hi = runs.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const r = runs[mid];
		if (fc < r.start) hi = mid - 1;
		else if (fc >= r.end) lo = mid + 1;
		else return r.props;
	}
	return undefined;
}

export function readDoc(bytes: Uint8Array): { model: DocModel; census: Census } {
	const cfb = readCfb(bytes);
	const wordBytes = cfb.get('WordDocument');
	if (wordBytes === undefined) throw new DocError('not a Word document');
	const word = new Reader(wordBytes);
	if (word.u16(0) !== 0xa5ec) throw new DocError('not a Word document');
	const nFib = word.u16(2);
	if (nFib < 101) throw new DocError('Word 6 and earlier are not read');
	const flags = word.u16(0x0a);
	if (flags & 0x0100) throw new DocError('This document is protected with a password');
	const tableName = flags & 0x0200 ? '1Table' : '0Table';
	const tableBytes = cfb.get(tableName);
	if (tableBytes === undefined) throw new DocError('no table stream');
	const table = new Reader(tableBytes);
	const tally = new Tally();

	const csw = word.u16(32);
	const lwAt = 34 + csw * 2;
	const cslw = word.u16(lwAt);
	const lw = lwAt + 2;
	const ccpText = word.i32(lw + 12);
	if (ccpText < 0 || ccpText > DOC_LIMITS.chars) throw new DocError('bad text length');
	for (const [k, label] of [
		[16, 'Footnotes'],
		[20, 'Headers and footers'],
		[28, 'Comments'],
		[32, 'Endnotes'],
		[36, 'Text boxes']
	] as const) {
		if (cslw * 4 > k && word.i32(lw + k) > 0) tally.add(label, 'lost');
	}
	const fcLcbAt = lw + cslw * 4 + 2;
	const cbRgFcLcb = word.u16(lw + cslw * 4);
	const pair = (i: number) =>
		i < cbRgFcLcb
			? { fc: word.u32(fcLcbAt + i * 8), lcb: word.u32(fcLcbAt + i * 8 + 4) }
			: { fc: 0, lcb: 0 };

	// The piece table.
	const clx = pair(33);
	if (clx.lcb === 0) throw new DocError('no piece table');
	let at = clx.fc;
	const clxEnd = clx.fc + clx.lcb;
	while (at < clxEnd && table.u8(at) === 1) at += 3 + table.i16(at + 1);
	if (table.u8(at) !== 2) throw new DocError('bad piece table');
	const lcb = table.u32(at + 1);
	const plc = at + 5;
	const n = (lcb - 4) / 12;
	if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new DocError('bad piece table');
	const pieces: Piece[] = [];
	for (let i = 0; i < n; i++) {
		const raw = table.u32(plc + (n + 1) * 4 + i * 8 + 2);
		pieces.push({
			cpStart: table.u32(plc + i * 4),
			cpEnd: table.u32(plc + (i + 1) * 4),
			compressed: (raw & 0x40000000) !== 0,
			fc: raw & 0x3fffffff
		});
	}

	const chars = fkpRuns(word, table, pair(12).fc, pair(12).lcb, false, (f, t) =>
		charProps(word, f, t)
	);
	const paras = fkpRuns(word, table, pair(13).fc, pair(13).lcb, true, (f, t) =>
		t > f ? paraProps(word, f, t) : { istd: 0 }
	);
	const styles = readStyles(table, pair(1));
	const fonts = readFonts(table, pair(15));
	const lists = readLists(table, pair(73), pair(74));
	if (cfb.names().some((p) => p.startsWith('Macros/') || p === 'Macros'))
		tally.add('Macros', 'lost');
	if (cfb.names().includes('ObjectPool') || cfb.names().some((p) => p.startsWith('ObjectPool/'))) {
		tally.add('Embedded objects', 'lost');
	}

	// The text with the fc of each character, for its properties.
	const blocks: Block[] = [];
	let content: Inline[] = [];
	let rows: Row[] = [];
	let cells: Cell[] = [];
	let cellParas: Paragraph[] = [];
	const fields: { phase: 'inst' | 'result'; inst: string; link?: string }[] = [];
	let pictures = 0;

	const marksAt = (fc: number): Marks => {
		const c = find(chars, fc) ?? {};
		const m: Marks = {};
		if (c.bold) m.bold = true;
		if (c.italic) m.italic = true;
		if (c.underline) m.underline = true;
		if (c.strike) m.strike = true;
		if (c.size && c.size !== 12 && c.size !== 10 && c.size < 1600) m.size = c.size;
		if (c.color && c.color !== '#000000') m.color = c.color;
		if (c.highlight) m.highlight = c.highlight;
		if (c.font !== undefined && c.font > 0 && fonts[c.font]) m.font = fonts[c.font];
		const link = [...fields].reverse().find((f) => f.phase === 'result' && f.link)?.link;
		if (link) m.link = link;
		return cleanMarks(m);
	};

	const endParagraph = (fc: number): Paragraph => {
		const pp = find(paras, fc) ?? { istd: 0 };
		const p: Paragraph = {
			type: 'paragraph',
			style: styleOf(pp, styles),
			content: normalizeInlines(content)
		};
		if (pp.align && pp.align !== 'left') p.align = pp.align;
		if (pp.ilfo !== undefined && pp.ilfo > 0) {
			const level = Math.min(pp.ilvl ?? 0, 8);
			p.list = { kind: lists(pp.ilfo, level) ? 'bullet' : 'number', level };
		}
		content = [];
		return p;
	};

	const flushTable = () => {
		if (cells.length > 0) rows.push({ cells });
		cells = [];
		if (rows.length > 0) {
			const width = Math.max(...rows.map((r) => r.cells.length));
			for (const r of rows) {
				while (r.cells.length < width)
					r.cells.push({ content: [{ type: 'paragraph', style: 'normal', content: [] }] });
			}
			blocks.push({ type: 'table', rows });
		}
		rows = [];
	};

	let deletedRuns = 0;
	for (const piece of pieces) {
		if (piece.cpStart >= ccpText) break;
		const end = Math.min(piece.cpEnd, ccpText);
		const width = piece.compressed ? 1 : 2;
		const base = piece.compressed ? piece.fc / 2 : piece.fc;
		if (end < piece.cpStart) throw new DocError('bad piece');
		word.need(base, (end - piece.cpStart) * width);
		const decoder = piece.compressed ? new TextDecoder('windows-1252') : null;
		let buf = '';
		let bufFc = -1;
		const flush = () => {
			if (buf !== '') content.push({ type: 'text', text: buf, marks: marksAt(bufFc) });
			buf = '';
		};
		for (let cp = piece.cpStart; cp < end; cp++) {
			const fc = base + (cp - piece.cpStart) * width;
			const code = piece.compressed ? word.u8(fc) : word.u16(fc);
			const ch = piece.compressed ? decoder!.decode(word.slice(fc, 1)) : String.fromCharCode(code);
			const props = find(chars, fc);
			if (props?.deleted) {
				deletedRuns++;
				continue;
			}
			const field = fields[fields.length - 1];
			if (code === 0x13) {
				flush();
				fields.push({ phase: 'inst', inst: '' });
				continue;
			}
			if (code === 0x14 && field) {
				flush();
				field.phase = 'result';
				const m = /HYPERLINK\s+(\\l\s+)?"([^"]*)"/.exec(field.inst);
				if (m) field.link = m[1] ? `#${m[2]}` : m[2];
				else tally.add('Fields, kept as their text', 'changed');
				continue;
			}
			if (code === 0x15 && field) {
				flush();
				fields.pop();
				continue;
			}
			if (field?.phase === 'inst') {
				field.inst += ch;
				continue;
			}
			// A different run starts a new piece of text.
			if (buf !== '' && find(chars, bufFc) !== props) flush();
			if (buf === '') bufFc = fc;
			if (code === 0x0d || code === 0x07 || code === 0x0c) {
				flush();
				const pp = find(paras, fc) ?? { istd: 0 };
				if (code === 0x07 && pp.rowEnd) {
					content = [];
					if (cells.length > 0) rows.push({ cells });
					cells = [];
					continue;
				}
				const p = endParagraph(fc);
				if (pp.inTable || code === 0x07) {
					cellParas.push(p);
					if (code === 0x07) {
						cells.push({ content: cellParas });
						cellParas = [];
					}
					continue;
				}
				if (rows.length > 0 || cells.length > 0) flushTable();
				blocks.push(p);
				if (code === 0x0c)
					blocks.push({
						type: 'paragraph',
						style: 'normal',
						content: [{ type: 'break', page: true }]
					});
				continue;
			}
			if (code === 0x0b) {
				flush();
				content.push({ type: 'break' });
				continue;
			}
			if (props?.special && (code === 0x01 || code === 0x08)) {
				pictures++;
				continue;
			}
			if (props?.special && (code === 0x02 || code === 0x05)) continue;
			if (code === 0x09) buf += '\t';
			else if (code === 0x1e) buf += '‑';
			else if (code === 0x1f) buf += '­';
			else if (code < 0x20) continue;
			else buf += ch;
		}
		flush();
	}
	if (content.length > 0) blocks.push(endParagraph(0));
	if (cellParas.length > 0) cells.push({ content: cellParas });
	flushTable();
	if (pictures > 0) tally.add('Pictures', 'lost', pictures);
	if (deletedRuns > 0) tally.add('Tracked deletions, left out', 'lost');
	tally.add('Converted to .docx on save; the original stays in Versions', 'changed');
	return { model: { blocks, images: {} }, census: tally.census() };
}

function styleOf(p: ParaProps, styles: Map<number, { sti: number; name: string }>): BlockStyle {
	const s = styles.get(p.istd);
	const sti = s ? s.sti : p.istd;
	if (sti >= 1 && sti <= 6) return `h${sti}` as BlockStyle;
	const name = s?.name.toLowerCase() ?? '';
	const h = /^heading (\d)$/.exec(name);
	if (h && Number(h[1]) <= 6) return `h${h[1]}` as BlockStyle;
	if (sti === 62 || name === 'title') return 'title';
	if (name === 'quote' || name === 'block text') return 'quote';
	if (p.outline !== undefined && p.outline < 6) return `h${p.outline + 1}` as BlockStyle;
	return 'normal';
}

function readStyles(
	t: Reader,
	at: { fc: number; lcb: number }
): Map<number, { sti: number; name: string }> {
	const out = new Map<number, { sti: number; name: string }>();
	if (at.lcb < 4) return out;
	try {
		const cbStshi = t.u16(at.fc);
		const cstd = t.u16(at.fc + 2);
		const cbBase = t.u16(at.fc + 4);
		let p = at.fc + 2 + cbStshi;
		const end = at.fc + at.lcb;
		for (let i = 0; i < cstd && p + 2 <= end; i++) {
			const cbStd = t.u16(p);
			if (cbStd > 0 && cbStd >= cbBase + 2) {
				const sti = t.u16(p + 2) & 0x0fff;
				const nameAt = p + 2 + cbBase;
				const cch = t.u16(nameAt);
				let name = '';
				for (let k = 0; k < cch && k < 255; k++)
					name += String.fromCharCode(t.u16(nameAt + 2 + k * 2));
				out.set(i, { sti, name });
			}
			p += 2 + cbStd;
		}
	} catch {
		// The names are a nicety: without them, the built-in numbering decides.
	}
	return out;
}

function readFonts(t: Reader, at: { fc: number; lcb: number }): string[] {
	const out: string[] = [];
	if (at.lcb < 6) return out;
	try {
		let p = at.fc;
		const end = at.fc + at.lcb;
		const extended = t.u16(p) === 0xffff;
		const count = extended ? t.u16(p + 2) : t.u16(p);
		p += extended ? 6 : 4;
		for (let i = 0; i < count && p < end; i++) {
			const cb = t.u8(p) + 1;
			let name = '';
			for (let k = p + 40; k + 1 < p + cb; k += 2) {
				const c = t.u16(k);
				if (c === 0) break;
				name += String.fromCharCode(c);
			}
			out.push(name);
			p += cb;
		}
	} catch {
		// Fonts stay as the editor's default.
	}
	return out;
}

/** Whether list `ilfo` at a level is bulleted, from the list definitions. */
function readLists(
	t: Reader,
	lst: { fc: number; lcb: number },
	lfo: { fc: number; lcb: number }
): (ilfo: number, level: number) => boolean {
	const bulleted = new Map<number, boolean[]>();
	const byLfo: number[] = [];
	try {
		if (lst.lcb >= 2) {
			const count = t.i16(lst.fc);
			const lists: { lsid: number; simple: boolean }[] = [];
			for (let i = 0; i < count && i < 4096; i++) {
				const o = lst.fc + 2 + i * 28;
				lists.push({ lsid: t.i32(o), simple: (t.u8(o + 26) & 1) !== 0 });
			}
			let p = lst.fc + lst.lcb;
			for (const l of lists) {
				const levels: boolean[] = [];
				for (let k = 0; k < (l.simple ? 1 : 9); k++) {
					const nfc = t.u8(p + 4);
					const cbChpx = t.u8(p + 24);
					const cbPapx = t.u8(p + 25);
					p += 28 + cbPapx + cbChpx;
					const cch = t.u16(p);
					p += 2 + cch * 2;
					levels.push(nfc === 23);
				}
				bulleted.set(l.lsid, levels);
			}
		}
		if (lfo.lcb >= 4) {
			const count = t.i32(lfo.fc);
			for (let i = 0; i < count && i < 4096; i++) byLfo.push(t.i32(lfo.fc + 4 + i * 16));
		}
	} catch {
		// Lists then show as bulleted.
	}
	return (ilfo, level) => {
		const levels = bulleted.get(byLfo[ilfo - 1]);
		return levels === undefined ? true : (levels[level] ?? levels[0] ?? true);
	};
}
