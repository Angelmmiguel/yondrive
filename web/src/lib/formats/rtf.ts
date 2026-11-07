/**
 * Rich Text Format, by a direct converter: read into the model, written whole
 * from it. RTF has no parts to leave untouched, so what the model does not hold
 * (headers, footnotes, fields other than links, objects, shapes, comments) is
 * named in the census as not kept on save.
 */
import {
	cleanMarks,
	hexColor,
	normalizeInlines,
	sniffImage,
	Tally,
	type Align,
	type Block,
	type BlockStyle,
	type Cell,
	type Census,
	type DocModel,
	type Inline,
	type ListInfo,
	type Marks,
	type Paragraph,
	type Row
} from './model';
import { imageSize } from './docx';

export const RTF_LIMITS = { size: 64 * 1024 * 1024, depth: 512 };

export class RtfError extends Error {}

type Token =
	| { t: '{' }
	| { t: '}' }
	| { t: 'word'; word: string; param: number | null }
	| { t: 'hex'; byte: number }
	| { t: 'text'; text: string };

function* tokens(src: string): Generator<Token> {
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === '{') {
			yield { t: '{' };
			i++;
		} else if (c === '}') {
			yield { t: '}' };
			i++;
		} else if (c === '\\') {
			const n = src[i + 1];
			if (n === undefined) return;
			if (/[a-zA-Z]/.test(n)) {
				const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(src.slice(i + 1, i + 50))!;
				yield { t: 'word', word: m[1], param: m[2] === undefined ? null : Number(m[2]) };
				i += 1 + m[0].length;
			} else if (n === "'") {
				const byte = parseInt(src.slice(i + 2, i + 4), 16);
				if (Number.isFinite(byte)) yield { t: 'hex', byte };
				i += 4;
			} else if (n === '\r' || n === '\n') {
				yield { t: 'word', word: 'par', param: null };
				i += 2;
			} else {
				const sym: Record<string, string> = { '~': ' ', _: '‑', '-': '­' };
				if (n === '*') yield { t: 'word', word: '*', param: null };
				else if (sym[n]) yield { t: 'text', text: sym[n] };
				else if (n === '{' || n === '}' || n === '\\') yield { t: 'text', text: n };
				i += 2;
			}
		} else if (c === '\r' || c === '\n') i++;
		else {
			let j = i;
			while (j < src.length && !'{}\\\r\n'.includes(src[j])) j++;
			yield { t: 'text', text: src.slice(i, j) };
			i = j;
		}
	}
}

interface CharState {
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
	font: number | null;
	size: number | null;
	color: number;
	highlight: number;
	charStyle: number | null;
}

interface State {
	dest:
		| 'body'
		| 'skip'
		| 'fonttbl'
		| 'colortbl'
		| 'stylesheet'
		| 'pict'
		| 'fldinst'
		| 'fldrslt'
		| 'listtext';
	char: CharState;
	uc: number;
	pict?: { kind: string; w: number; h: number; hex: string[] };
	field?: { inst: string; link?: string };
}

interface StyleDef {
	name: string;
	char: Partial<CharState>;
	isChar: boolean;
}

const plainChar = (): CharState => ({
	bold: false,
	italic: false,
	underline: false,
	strike: false,
	font: null,
	size: null,
	color: 0,
	highlight: 0,
	charStyle: null
});

const LOST: Record<string, string> = {
	header: 'Headers and footers',
	headerl: 'Headers and footers',
	headerr: 'Headers and footers',
	headerf: 'Headers and footers',
	footer: 'Headers and footers',
	footerl: 'Headers and footers',
	footerr: 'Headers and footers',
	footerf: 'Headers and footers',
	footnote: 'Footnotes',
	annotation: 'Comments',
	atnid: 'Comments',
	object: 'Embedded objects',
	shp: 'Shapes',
	shppict: '',
	nonshppict: '',
	info: '',
	xmlnstbl: '',
	listtable: '',
	listoverridetable: '',
	rsidtbl: '',
	generator: '',
	themedata: 'Theme',
	colorschememapping: '',
	latentstyles: '',
	datastore: '',
	pgdsctbl: '',
	revtbl: 'Tracked changes'
};

const STYLE_NAMES: Record<string, BlockStyle> = {
	title: 'title',
	quote: 'quote',
	quotations: 'quote',
	'block text': 'quote',
	'source code': 'code',
	'preformatted text': 'code',
	'html preformatted': 'code'
};

export function readRtf(bytes: Uint8Array): { model: DocModel; census: Census } {
	if (bytes.length > RTF_LIMITS.size) throw new RtfError('too large');
	// RTF is 7-bit; anything else arrives through escapes in the declared code page.
	const src = new TextDecoder('latin1').decode(bytes);
	if (!src.startsWith('{\\rtf')) throw new RtfError('not RTF');
	const tally = new Tally();
	let codepage = 'windows-1252';
	const fonts = new Map<number, string>();
	const colors: (string | undefined)[] = [];
	const styles = new Map<number, StyleDef>();
	const charStyles = new Map<number, StyleDef>();
	const images: DocModel['images'] = {};
	const blocks: Block[] = [];

	let para = freshPara();
	let inTable = false;
	let row: Cell[] = [];
	let rows: Row[] = [];
	let cell: Paragraph[] = [];
	let pendingBytes: number[] = [];
	let skipFallback = 0;
	let fontEntry: { n: number; name: string } | null = null;
	let colorEntry = { r: 0, g: 0, b: 0, any: false };
	let styleEntry: { n: number; isChar: boolean; name: string; char: CharState } | null = null;
	let listTextHasDigit = false;
	let starred = false;

	const stack: State[] = [];
	let st: State = { dest: 'body', char: plainChar(), uc: 1 };

	function freshPara() {
		return {
			content: [] as Inline[],
			align: undefined as Align | undefined,
			style: 0,
			outline: null as number | null,
			list: null as { level: number; ls: number } | null,
			listNumbered: false,
			intbl: false
		};
	}

	const decodeBytes = () => {
		if (pendingBytes.length === 0) return '';
		let out: string;
		try {
			out = new TextDecoder(codepage).decode(new Uint8Array(pendingBytes));
		} catch {
			out = new TextDecoder('windows-1252').decode(new Uint8Array(pendingBytes));
		}
		pendingBytes = [];
		return out;
	};

	const marksOf = (c: CharState): Marks => {
		const m: Marks = {};
		const cs = c.charStyle === null ? undefined : charStyles.get(c.charStyle);
		const ps = styles.get(para.style);
		const base = ps?.char ?? {};
		if (cs && /verbatim|code|source/i.test(cs.name)) m.code = true;
		if (c.bold && !base.bold) m.bold = true;
		if (c.italic && !base.italic) m.italic = true;
		if (c.underline) m.underline = true;
		if (c.strike) m.strike = true;
		const font = c.font === null ? undefined : fonts.get(c.font);
		const styleFont = cs?.char.font ?? base.font;
		if (font && c.font !== styleFont && c.font !== 0) m.font = font;
		if (c.size !== null && c.size !== (base.size ?? null) && c.size !== 24) m.size = c.size / 2;
		const color = colors[c.color];
		if (c.color > 0 && color) m.color = color;
		const hl = colors[c.highlight];
		if (c.highlight > 0 && hl) m.highlight = hl;
		if (st.field?.link) m.link = st.field.link;
		return cleanMarks(m);
	};

	const emitText = (text: string) => {
		if (text === '') return;
		if (st.dest === 'listtext') {
			if (/\d/.test(text)) listTextHasDigit = true;
			return;
		}
		if (st.dest === 'fldinst') {
			if (st.field) st.field.inst += text;
			return;
		}
		if (st.dest !== 'body' && st.dest !== 'fldrslt') return;
		para.content.push({ type: 'text', text, marks: marksOf(st.char) });
	};

	const flushBytes = () => emitText(decodeBytes());

	const endParagraph = () => {
		flushBytes();
		let style: BlockStyle = 'normal';
		const name = styles.get(para.style)?.name.toLowerCase() ?? '';
		const h = /^heading (\d)$/.exec(name);
		if (h && Number(h[1]) <= 6) style = `h${h[1]}` as BlockStyle;
		else if (STYLE_NAMES[name]) style = STYLE_NAMES[name];
		else if (para.outline !== null && para.outline < 6)
			style = `h${para.outline + 1}` as BlockStyle;
		const p: Paragraph = { type: 'paragraph', style, content: normalizeInlines(para.content) };
		if (para.align) p.align = para.align;
		if (para.list) {
			const numbered = para.listNumbered || listTextHasDigit;
			const list: ListInfo = {
				kind: numbered ? 'number' : 'bullet',
				level: Math.min(para.list.level, 8)
			};
			p.list = list;
			const first = p.content[0];
			if (!numbered && first?.type === 'text' && /^[☐☑☒] /.test(first.text)) {
				p.list = { kind: 'check', level: list.level, checked: first.text[0] !== '☐' };
				p.content = normalizeInlines([
					{ ...first, text: first.text.slice(2) },
					...p.content.slice(1)
				]);
			}
		}
		const keep = {
			style: para.style,
			align: para.align,
			list: para.list,
			listNumbered: para.listNumbered,
			outline: para.outline,
			intbl: para.intbl
		};
		para = freshPara();
		Object.assign(para, keep);
		listTextHasDigit = false;
		return p;
	};

	const finishRow = () => {
		if (row.length > 0) rows.push({ cells: row });
		row = [];
	};
	const finishTable = () => {
		finishRow();
		if (rows.length > 0) {
			const width = Math.max(...rows.map((r) => r.cells.length));
			for (const r of rows)
				while (r.cells.length < width)
					r.cells.push({ content: [{ type: 'paragraph', style: 'normal', content: [] }] });
			blocks.push({ type: 'table', rows });
		}
		rows = [];
		inTable = false;
	};

	let depth = 0;
	for (const tok of tokens(src)) {
		if (tok.t !== 'hex' && pendingBytes.length > 0 && !(tok.t === 'text' && skipFallback > 0))
			flushBytes();
		if (tok.t === '{') {
			if (++depth > RTF_LIMITS.depth) throw new RtfError('nested too deep');
			stack.push(st);
			st = { ...st, char: { ...st.char }, pict: undefined };
			continue;
		}
		if (tok.t === '}') {
			depth--;
			const closing = st;
			if (closing.dest === 'fonttbl' && fontEntry) {
				fonts.set(fontEntry.n, fontEntry.name.replace(/;\s*$/, '').trim());
				fontEntry = null;
			}
			if (closing.dest === 'stylesheet' && styleEntry) {
				const def = {
					name: styleEntry.name.replace(/;\s*$/, '').trim(),
					char: styleEntry.char,
					isChar: styleEntry.isChar
				};
				(styleEntry.isChar ? charStyles : styles).set(styleEntry.n, def);
				styleEntry = null;
			}
			if (closing.dest === 'pict' && closing.pict && stack[stack.length - 1]?.dest !== 'pict') {
				const pict = closing.pict;
				const hex = pict.hex.join('').replace(/[^0-9a-fA-F]/g, '');
				if (pict.kind !== '' && hex.length > 0) {
					const data = new Uint8Array(hex.length >> 1);
					for (let k = 0; k < data.length; k++) data[k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16);
					const key = `rtf:${Object.keys(images).length + 1}`;
					images[key] = { mime: sniffImage(data), bytes: data };
					const img: Inline = { type: 'image', image: key, alt: '' };
					if (pict.w > 0 && pict.h > 0) {
						img.width = Math.round(pict.w / 15);
						img.height = Math.round(pict.h / 15);
					}
					const parent = stack[stack.length - 1];
					if (
						parent &&
						(parent.dest === 'body' || parent.dest === 'fldrslt' || parent.dest === 'skip')
					)
						para.content.push(img);
				} else tally.add('Picture in a format not read', 'lost');
			}
			const parent = stack.pop();
			if (parent === undefined) break;
			if (closing.dest === 'fldinst' && parent.field) {
				const m = /HYPERLINK\s+(?:\\l\s+)?"([^"]*)"/.exec(closing.field?.inst ?? '');
				parent.field.inst = closing.field?.inst ?? '';
				if (m)
					parent.field.link = /^\\l/.test(
						(closing.field?.inst ?? '').split('HYPERLINK')[1]?.trim() ?? ''
					)
						? `#${m[1]}`
						: m[1];
				else if ((closing.field?.inst ?? '').trim() !== '')
					tally.add('Fields, kept as their text', 'lost');
			}
			st = parent;
			continue;
		}
		if (tok.t === 'hex') {
			if (skipFallback > 0) {
				skipFallback--;
				continue;
			}
			if (st.dest === 'pict' && st.pict) {
				st.pict.hex.push(tok.byte.toString(16).padStart(2, '0'));
				continue;
			}
			pendingBytes.push(tok.byte);
			continue;
		}
		if (tok.t === 'text') {
			let text = tok.text;
			if (skipFallback > 0) {
				const n = Math.min(skipFallback, text.length);
				text = text.slice(n);
				skipFallback -= n;
			}
			if (st.dest === 'pict' && st.pict) st.pict.hex.push(text);
			else if (st.dest === 'fonttbl' && fontEntry) fontEntry.name += text;
			else if (st.dest === 'stylesheet' && styleEntry) styleEntry.name += text;
			else if (st.dest === 'colortbl') {
				for (const ch of text) {
					if (ch === ';') {
						colors.push(colorEntry.any ? hexColor(rgb(colorEntry)) : undefined);
						colorEntry = { r: 0, g: 0, b: 0, any: false };
					}
				}
			} else emitText(text);
			continue;
		}
		const { word, param } = tok;
		skipFallback = 0;
		if (word === '*') {
			starred = true;
			continue;
		}
		if (starred) {
			// An ignorable destination: read only the few this converter knows.
			starred = false;
			if (word !== 'fldinst' && !(st.dest === 'stylesheet' && word === 'cs')) st.dest = 'skip';
		}
		if (st.dest === 'skip') continue;
		if (st.dest === 'listtext' && word !== 'u') continue;
		if (st.dest === 'fonttbl') {
			if (word === 'f' && param !== null) fontEntry = { n: param, name: '' };
			continue;
		}
		if (st.dest === 'colortbl') {
			if (word === 'red') colorEntry = { ...colorEntry, r: param ?? 0, any: true };
			else if (word === 'green') colorEntry = { ...colorEntry, g: param ?? 0, any: true };
			else if (word === 'blue') colorEntry = { ...colorEntry, b: param ?? 0, any: true };
			continue;
		}
		if (st.dest === 'stylesheet') {
			if ((word === 's' || word === 'cs') && param !== null) {
				styleEntry = { n: param, isChar: word === 'cs', name: '', char: plainChar() };
				st.char = styleEntry.char;
			} else applyChar(st.char, word, param);
			continue;
		}
		if (st.dest === 'pict' && st.pict) {
			if (word === 'pngblip') st.pict.kind = 'png';
			else if (word === 'jpegblip') st.pict.kind = 'jpeg';
			else if (word === 'picwgoal') st.pict.w = param ?? 0;
			else if (word === 'pichgoal') st.pict.h = param ?? 0;
			else if (['emfblip', 'wmetafile', 'macpict', 'dibitmap', 'wbitmap'].includes(word))
				st.pict.kind = '';
			continue;
		}
		switch (word) {
			case 'ansicpg':
				if (param && [874, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258].includes(param)) {
					codepage = `windows-${param}`;
				} else if (param === 932) codepage = 'shift_jis';
				else if (param === 936) codepage = 'gbk';
				else if (param === 949) codepage = 'euc-kr';
				else if (param === 950) codepage = 'big5';
				break;
			case 'fonttbl':
				st.dest = 'fonttbl';
				break;
			case 'colortbl':
				st.dest = 'colortbl';
				break;
			case 'stylesheet':
				st.dest = 'stylesheet';
				break;
			case 'pict':
				st.dest = 'pict';
				st.pict = { kind: '', w: 0, h: 0, hex: [] };
				break;
			case 'field':
				st.field = { inst: '' };
				break;
			case 'fldinst':
				st.dest = 'fldinst';
				st.field = { inst: '' };
				break;
			case 'fldrslt':
				st.dest = 'fldrslt';
				break;
			case 'listtext':
			case 'pntext':
				st.dest = 'listtext';
				break;
			case 'uc':
				st.uc = Math.min(Math.max(param ?? 1, 0), 8);
				break;
			case 'u': {
				let cp = param ?? 0;
				if (cp < 0) cp += 65536;
				if (pendingBytes.length > 0) flushBytes();
				emitText(String.fromCharCode(cp));
				skipFallback = st.uc;
				break;
			}
			case 'par':
			case 'sect':
			case 'page': {
				const inCell = para.intbl;
				const p = endParagraph();
				if (inCell) cell.push(p);
				else {
					if (inTable || rows.length > 0) finishTable();
					blocks.push(p);
				}
				if (word === 'page' && !inTable)
					blocks.push({
						type: 'paragraph',
						style: 'normal',
						content: [{ type: 'break', page: true }]
					});
				break;
			}
			case 'line':
				para.content.push({ type: 'break' });
				break;
			case 'tab':
				emitText('\t');
				break;
			case 'emdash':
				emitText('—');
				break;
			case 'endash':
				emitText('–');
				break;
			case 'bullet':
				emitText('•');
				break;
			case 'lquote':
				emitText('‘');
				break;
			case 'rquote':
				emitText('’');
				break;
			case 'ldblquote':
				emitText('“');
				break;
			case 'rdblquote':
				emitText('”');
				break;
			case 'pard':
				para.align = undefined;
				para.style = 0;
				para.list = null;
				para.listNumbered = false;
				para.outline = null;
				para.intbl = false;
				break;
			case 'plain':
				st.char = plainChar();
				break;
			case 'ql':
				para.align = 'left';
				break;
			case 'qc':
				para.align = 'center';
				break;
			case 'qr':
				para.align = 'right';
				break;
			case 'qj':
				para.align = 'justify';
				break;
			case 's':
				para.style = param ?? 0;
				break;
			case 'outlinelevel':
				para.outline = param;
				break;
			case 'ls':
				para.list = { level: para.list?.level ?? 0, ls: param ?? 0 };
				para.listNumbered = listTextHasDigit || para.listNumbered;
				break;
			case 'ilvl':
				para.list = { level: param ?? 0, ls: para.list?.ls ?? 0 };
				break;
			case 'intbl':
				para.intbl = true;
				inTable = true;
				break;
			case 'cell': {
				flushBytes();
				const p = endParagraph();
				if (p.content.length > 0 || cell.length === 0) cell.push(p);
				row.push({ content: cell });
				cell = [];
				break;
			}
			case 'row':
				finishRow();
				break;
			case 'trowd':
				inTable = true;
				break;
			default:
				if (LOST[word] !== undefined && depth > 1) {
					if (LOST[word] !== '') tally.add(LOST[word], 'lost');
					st.dest = 'skip';
				} else if (['fldinst', 'bkmkstart', 'bkmkend', 'xe', 'tc'].includes(word)) st.dest = 'skip';
				else applyChar(st.char, word, param);
		}
		if (word === 'ls' || word === 'pnlvlbody') para.listNumbered = listTextHasDigit;
		if (word === 'pnlvlbody' || word === 'pnlvlblt') {
			para.list = { level: para.list?.level ?? 0, ls: 0 };
			para.listNumbered = word === 'pnlvlbody';
		}
	}
	flushBytes();
	if (para.content.length > 0) blocks.push(endParagraph());
	if (inTable || rows.length > 0) finishTable();
	tally.add(
		'Saving rewrites the whole file: formatting this editor does not show is not kept',
		'changed'
	);
	return { model: { blocks, images }, census: tally.census() };
}

const rgb = (c: { r: number; g: number; b: number }) =>
	`#${[c.r, c.g, c.b].map((v) => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')).join('')}`;

function applyChar(c: CharState, word: string, param: number | null): void {
	const on = param === null || param !== 0;
	switch (word) {
		case 'b':
			c.bold = on;
			break;
		case 'i':
			c.italic = on;
			break;
		case 'ul':
		case 'uldb':
		case 'ulth':
		case 'uld':
		case 'ulw':
			c.underline = on;
			break;
		case 'ulnone':
			c.underline = false;
			break;
		case 'strike':
		case 'striked':
			c.strike = on;
			break;
		case 'f':
			c.font = param;
			break;
		case 'fs':
			c.size = param !== null && param > 0 && param < 3200 ? param : null;
			break;
		case 'cf':
			c.color = param ?? 0;
			break;
		case 'highlight':
		case 'cb':
		case 'chcbpat':
			c.highlight = param ?? 0;
			break;
		case 'cs':
			c.charStyle = param;
			break;
	}
}

// Writing.

const escape = (s: string) => {
	let out = '';
	for (const ch of s) {
		const cp = ch.codePointAt(0) ?? 0;
		if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
		else if (ch === '\t') out += '\\tab ';
		else if (ch === ' ') out += '\\~';
		else if (cp < 0x20) continue;
		else if (cp < 0x80) out += ch;
		else if (cp <= 0xffff) out += `\\u${cp > 32767 ? cp - 65536 : cp}?`;
		else {
			const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
			const lo = ((cp - 0x10000) % 0x400) + 0xdc00;
			out += `\\u${hi - 65536}?\\u${lo - 65536}?`;
		}
	}
	return out;
};

const HEADING_SIZES = [40, 32, 28, 26, 24, 22];

export async function writeRtf(model: DocModel): Promise<Uint8Array> {
	const fonts = ['Calibri', 'Consolas'];
	const colors: string[] = [];
	const fontIndex = (f: string) => {
		let i = fonts.indexOf(f);
		if (i < 0) i = fonts.push(f) - 1;
		return i;
	};
	const colorIndex = (c: string) => {
		let i = colors.indexOf(c);
		if (i < 0) i = colors.push(c) - 1;
		return i + 1;
	};
	const styleDefs: { n: number; name: string; fmt: string; style: BlockStyle }[] = [
		{ n: 0, name: 'Normal', fmt: '', style: 'normal' },
		{ n: 1, name: 'Title', fmt: '\\b\\fs56', style: 'title' },
		...[1, 2, 3, 4, 5, 6].map((h) => ({
			n: h + 1,
			name: `heading ${h}`,
			fmt: `\\b\\fs${HEADING_SIZES[h - 1]}`,
			style: `h${h}` as BlockStyle
		})),
		{ n: 8, name: 'Quote', fmt: '', style: 'quote' },
		{ n: 9, name: 'Source Code', fmt: '\\f1\\fs20', style: 'code' }
	];
	const run = (it: Inline, base: string): string => {
		if (it.type === 'break') return it.page ? '\\page ' : '\\line ';
		if (it.type === 'image') {
			const img = model.images[it.image];
			if (!img || (img.mime !== 'image/png' && img.mime !== 'image/jpeg')) return '';
			const size = imageSize(img.bytes);
			const w = it.width ?? size?.width ?? 400;
			const h = it.height ?? size?.height ?? 300;
			let hex = '';
			for (let k = 0; k < img.bytes.length; k++) {
				hex += img.bytes[k].toString(16).padStart(2, '0');
				if (k % 64 === 63) hex += '\n';
			}
			return `{\\pict${img.mime === 'image/png' ? '\\pngblip' : '\\jpegblip'}\\picwgoal${w * 15}\\pichgoal${h * 15}\n${hex}}`;
		}
		const m = it.marks;
		let fmt = base;
		if (m.code) fmt += '\\cs10\\f1';
		if (m.bold) fmt += '\\b';
		if (m.italic) fmt += '\\i';
		if (m.underline) fmt += '\\ul';
		if (m.strike) fmt += '\\strike';
		if (m.font) fmt += `\\f${fontIndex(m.font)}`;
		if (m.size) fmt += `\\fs${Math.round(m.size * 2)}`;
		if (m.color) fmt += `\\cf${colorIndex(m.color)}`;
		if (m.highlight) fmt += `\\highlight${colorIndex(m.highlight)}`;
		const body = fmt === '' ? `{${escape(it.text)}}` : `{${fmt} ${escape(it.text)}}`;
		return m.link
			? `{\\field{\\*\\fldinst HYPERLINK ${m.link.startsWith('#') ? `\\\\l "${escape(m.link.slice(1))}"` : `"${escape(m.link)}"`}}{\\fldrslt ${body}}}`
			: body;
	};
	const paragraph = (p: Paragraph, extra = ''): string => {
		const def = styleDefs.find((d) => d.style === p.style) ?? styleDefs[0];
		let pp = `\\pard\\plain${extra}\\s${def.n}`;
		if (/^h[1-6]$/.test(p.style)) pp += `\\outlinelevel${Number(p.style[1]) - 1}`;
		if (p.style === 'quote') pp += '\\li720\\ri720';
		if (p.align) pp += { left: '\\ql', center: '\\qc', right: '\\qr', justify: '\\qj' }[p.align];
		let lead = '';
		if (p.list) {
			const numbered = p.list.kind === 'number';
			const indent = 720 * (p.list.level + 1);
			pp += `\\fi-360\\li${indent}\\ls${numbered ? 2 : 1}\\ilvl${p.list.level}`;
			lead = `{\\listtext\\pard\\plain ${numbered ? '1.' : '\\u8226?'}\\tab}`;
			if (p.list.kind === 'check') lead += `{${escape(p.list.checked ? '☒ ' : '☐ ')}}`;
		}
		const base = def.fmt;
		const body = p.content.map((it) => run(it, base)).join('');
		return `${pp}${base} ${lead}${body}`;
	};
	let body = '';
	const blockOut = (b: Block) => {
		if (b.type === 'paragraph') body += `${paragraph(b)}\\par\n`;
		else if (b.type === 'locked') {
			for (const line of b.text.split('\n')) body += `\\pard\\plain\\s0 ${escape(line)}\\par\n`;
		} else {
			const width = Math.max(1, ...b.rows.map((r) => r.cells.length));
			const cellW = Math.floor(9360 / width);
			for (const r of b.rows) {
				let rowOut = `\\trowd\\trgaph108${r.cells.some((c) => c.header) ? '\\trhdr' : ''}`;
				for (let c = 1; c <= width; c++)
					rowOut += `\\clbrdrt\\brdrs\\clbrdrl\\brdrs\\clbrdrb\\brdrs\\clbrdrr\\brdrs\\cellx${cellW * c}`;
				for (let c = 0; c < width; c++) {
					const paras = r.cells[c]?.content ?? [];
					const list =
						paras.length > 0
							? paras
							: [{ type: 'paragraph', style: 'normal', content: [] } as Paragraph];
					rowOut += list
						.map((p, k) => `${paragraph(p, '\\intbl')}${k < list.length - 1 ? '\\par ' : ''}`)
						.join('');
					rowOut += '\\cell ';
				}
				body += `${rowOut}\\row\n`;
			}
		}
	};
	for (const b of model.blocks) blockOut(b);
	const fontTable = `{\\fonttbl${fonts.map((f, i) => `{\\f${i}${i === 1 ? '\\fmodern' : '\\fswiss'} ${escape(f)};}`).join('')}}`;
	const colorTable = `{\\colortbl;${colors.map((c) => `\\red${parseInt(c.slice(1, 3), 16)}\\green${parseInt(c.slice(3, 5), 16)}\\blue${parseInt(c.slice(5, 7), 16)};`).join('')}}`;
	const styleSheet = `{\\stylesheet${styleDefs.map((d) => `{\\s${d.n}${d.fmt} ${d.name};}`).join('')}{\\*\\cs10\\additive\\f1 Verbatim Char;}}`;
	const level = (numbered: boolean, i: number) =>
		numbered
			? `{\\listlevel\\levelnfc${[0, 4, 2][i % 3]}\\leveljc0\\levelfollow0\\levelstartat1{\\leveltext\\'02\\'0${i}.;}{\\levelnumbers\\'01;}\\fi-360\\li${720 * (i + 1)}}`
			: `{\\listlevel\\levelnfc23\\leveljc0\\levelfollow0\\levelstartat1{\\leveltext\\'01\\u8226 ?;}{\\levelnumbers;}\\fi-360\\li${720 * (i + 1)}}`;
	const listTable = `{\\*\\listtable{\\list\\listtemplateid1${Array.from({ length: 9 }, (_, i) => level(false, i)).join('')}\\listid1}{\\list\\listtemplateid2${Array.from({ length: 9 }, (_, i) => level(true, i)).join('')}\\listid2}}{\\*\\listoverridetable{\\listoverride\\listid1\\listoverridecount0\\ls1}{\\listoverride\\listid2\\listoverridecount0\\ls2}}`;
	const out = `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1${fontTable}\n${colorTable}\n${styleSheet}\n${listTable}\n\\fs24\n${body}}`;
	return new TextEncoder().encode(out);
}
