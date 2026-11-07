/**
 * `xl/styles.xml`: cell formats read into the model's styles, and new ones
 * appended for a save. Existing entries are never changed, since cells and
 * conditional formats elsewhere point at them by index; a new style reuses an
 * existing font, fill, border and number format when one reads the same.
 */
import { BUILTIN_FORMATS, builtinIdOf } from '$lib/formula/numfmt';
import { spliceBeforeClose } from './ooxml';
import type { CellStyle, Edge, Font, HAlign, VAlign } from './workbook';
import { escapeAttr, kids as children, parseXml, type XElement } from './xml';

export const STYLE_LIMITS = { xfs: 65000, parts: 20000 };

export class StylesError extends Error {}

/** Excel's legacy palette, for `indexed` colours. */
export const PALETTE = [
	'000000',
	'FFFFFF',
	'FF0000',
	'00FF00',
	'0000FF',
	'FFFF00',
	'FF00FF',
	'00FFFF',
	'000000',
	'FFFFFF',
	'FF0000',
	'00FF00',
	'0000FF',
	'FFFF00',
	'FF00FF',
	'00FFFF',
	'800000',
	'008000',
	'000080',
	'808000',
	'800080',
	'008080',
	'C0C0C0',
	'808080',
	'9999FF',
	'993366',
	'FFFFCC',
	'CCFFFF',
	'660066',
	'FF8080',
	'0066CC',
	'CCCCFF',
	'000080',
	'FF00FF',
	'FFFF00',
	'00FFFF',
	'800080',
	'800000',
	'008080',
	'0000FF',
	'00CCFF',
	'CCFFFF',
	'CCFFCC',
	'FFFF99',
	'99CCFF',
	'FF99CC',
	'CC99FF',
	'FFCC99',
	'3366FF',
	'33CCCC',
	'99CC00',
	'FFCC00',
	'FF9900',
	'FF6600',
	'666699',
	'969696',
	'003366',
	'339966',
	'003300',
	'333300',
	'993300',
	'993366',
	'333399',
	'333333'
];

/** Theme colours in the order `theme="n"` counts them. */
export function themeColors(xml: string | null): string[] {
	if (!xml) return [];
	const root = parseXml(xml);
	const scheme = findDeep(root, 'clrScheme');
	if (!scheme) return [];
	const byName = new Map<string, string>();
	for (const k of kids(scheme)) {
		const c = kids(k)[0];
		const v = c?.attrs.val && /srgbClr$/.test(c.name) ? c.attrs.val : c?.attrs.lastClr;
		if (v) byName.set(local(k.name), v);
	}
	return [
		'lt1',
		'dk1',
		'lt2',
		'dk2',
		'accent1',
		'accent2',
		'accent3',
		'accent4',
		'accent5',
		'accent6',
		'hlink',
		'folHlink'
	].map((n) => byName.get(n) ?? '000000');
}

const local = (n: string) => n.slice(n.indexOf(':') + 1);

/** Child elements by local name, so a part written with a prefix (`x:styleSheet`) reads the same. */
const kids = (el: XElement, name?: string): XElement[] =>
	children(el).filter((k) => name === undefined || local(k.name) === name);

const child = (el: XElement, name: string): XElement | undefined => kids(el, name)[0];

function findDeep(el: XElement, name: string): XElement | undefined {
	for (const k of kids(el)) {
		if (local(k.name) === name) return k;
		const f = findDeep(k, name);
		if (f) return f;
	}
	return undefined;
}

function tint(hex: string, t: number): string {
	if (!t) return hex;
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	let h = 0;
	let s = 0;
	let l = (max + min) / 2;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
		h /= 6;
	}
	l = t < 0 ? l * (1 + t) : l * (1 - t) + t;
	const hue = (p: number, q: number, x: number) => {
		if (x < 0) x += 1;
		if (x > 1) x -= 1;
		if (x < 1 / 6) return p + (q - p) * 6 * x;
		if (x < 1 / 2) return q;
		if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
		return p;
	};
	let out: number[];
	if (s === 0) out = [l, l, l];
	else {
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		out = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
	}
	return out
		.map((v) =>
			Math.round(v * 255)
				.toString(16)
				.padStart(2, '0')
		)
		.join('');
}

/** A `<color>` as `#rrggbb`, from rgb, theme or palette; undefined for automatic. */
export function colorOf(
	el: XElement | undefined,
	theme: string[],
	palette = PALETTE
): string | undefined {
	if (!el) return undefined;
	const a = el.attrs;
	let hex: string | undefined;
	if (a.rgb && /^[0-9a-f]{6,8}$/i.test(a.rgb)) hex = a.rgb.slice(-6);
	else if (a.theme !== undefined) hex = theme[Number(a.theme)];
	else if (a.indexed !== undefined) {
		const i = Number(a.indexed);
		hex = i === 64 ? '000000' : i === 65 ? 'FFFFFF' : palette[i];
	}
	if (!hex) return undefined;
	return `#${tint(hex, Number(a.tint ?? 0)).toLowerCase()}`;
}

const flag = (el: XElement | undefined) =>
	el !== undefined && el.attrs.val !== '0' && el.attrs.val !== 'false' && el.attrs.val !== 'none';

function fontOf(f: XElement, theme: string[], palette: string[]): Font {
	const out: Font = {};
	const name = child(f, 'name')?.attrs.val;
	if (name) out.name = name;
	const sz = Number(child(f, 'sz')?.attrs.val);
	if (sz > 0 && sz < 1000) out.size = sz;
	if (flag(child(f, 'b'))) out.bold = true;
	if (flag(child(f, 'i'))) out.italic = true;
	const u = child(f, 'u');
	if (u && u.attrs.val !== 'none') out.underline = true;
	if (flag(child(f, 'strike'))) out.strike = true;
	const color = colorOf(child(f, 'color'), theme, palette);
	if (color) out.color = color;
	return out;
}

function fillOf(f: XElement, theme: string[], palette: string[]): string | undefined {
	const p = child(f, 'patternFill');
	if (!p || p.attrs.patternType !== 'solid') return undefined;
	return colorOf(child(p, 'fgColor'), theme, palette);
}

const EDGES = ['left', 'right', 'top', 'bottom'] as const;

function borderOf(b: XElement, theme: string[], palette: string[]): CellStyle['border'] {
	const out: CellStyle['border'] = {};
	for (const side of EDGES) {
		const e = child(b, side);
		if (!e?.attrs.style || e.attrs.style === 'none') continue;
		const edge: Edge = { style: e.attrs.style };
		const color = colorOf(child(e, 'color'), theme, palette);
		if (color) edge.color = color;
		out[side] = edge;
	}
	return out;
}

const H = new Set([
	'general',
	'left',
	'center',
	'right',
	'fill',
	'justify',
	'centerContinuous',
	'distributed'
]);
const V = new Set(['top', 'center', 'bottom', 'justify', 'distributed']);

function alignOf(a: XElement | undefined): CellStyle['align'] {
	const out: CellStyle['align'] = {};
	if (!a) return out;
	const h = a.attrs.horizontal;
	if (h && H.has(h) && h !== 'general') out.h = h as HAlign;
	const v = a.attrs.vertical;
	if (v && V.has(v) && v !== 'bottom') out.v = v as VAlign;
	if (a.attrs.wrapText === '1' || a.attrs.wrapText === 'true') out.wrap = true;
	const indent = Number(a.attrs.indent);
	if (indent > 0 && indent < 256) out.indent = indent;
	const rot = Number(a.attrs.textRotation);
	if (rot > 0 && rot <= 255) out.rotate = rot;
	return out;
}

export interface StylesPart {
	styles: CellStyle[];
	numFmts: Map<number, string>;
	fonts: Font[];
	fills: (string | undefined)[];
	borders: CellStyle['border'][];
	dxfs: number;
	/** The namespace prefix the part writes its elements with, `x:` or none. */
	prefix: string;
}

const key = (v: unknown) => JSON.stringify(v ?? null);

export function readStyles(xml: string | null, theme: string[]): StylesPart {
	const empty: StylesPart = {
		styles: [],
		numFmts: new Map(),
		fonts: [],
		fills: [],
		borders: [],
		dxfs: 0,
		prefix: ''
	};
	if (!xml) return empty;
	const root = parseXml(xml);
	const customPalette = child(root, 'colors') && child(child(root, 'colors')!, 'indexedColors');
	const palette = customPalette
		? kids(customPalette, 'rgbColor').map((c) => (c.attrs.rgb ?? '000000').slice(-6))
		: PALETTE;
	const numFmts = new Map<number, string>();
	for (const n of kids(child(root, 'numFmts') ?? root, 'numFmt')) {
		const id = Number(n.attrs.numFmtId);
		if (Number.isInteger(id) && n.attrs.formatCode !== undefined)
			numFmts.set(id, n.attrs.formatCode);
	}
	const list = (parent: string, name: string) => {
		const p = child(root, parent);
		const items = p ? kids(p, name) : [];
		if (items.length > STYLE_LIMITS.parts) throw new StylesError('too many styles');
		return items;
	};
	const fonts = list('fonts', 'font').map((f) => fontOf(f, theme, palette));
	const fills = list('fills', 'fill').map((f) => fillOf(f, theme, palette));
	const borders = list('borders', 'border').map((b) => borderOf(b, theme, palette));
	const xfs = list('cellXfs', 'xf');
	if (xfs.length > STYLE_LIMITS.xfs) throw new StylesError('too many cell formats');
	const styles = xfs.map((xf): CellStyle => {
		const id = Number(xf.attrs.numFmtId ?? 0);
		const style: CellStyle = {
			numFmt: numFmts.get(id) ?? BUILTIN_FORMATS[id] ?? 'General',
			font: { ...(fonts[Number(xf.attrs.fontId ?? 0)] ?? {}) },
			border: { ...(borders[Number(xf.attrs.borderId ?? 0)] ?? {}) },
			align: alignOf(child(xf, 'alignment'))
		};
		const fill = fills[Number(xf.attrs.fillId ?? 0)];
		if (fill) style.fill = fill;
		return style;
	});
	const dxfs = child(root, 'dxfs') ? kids(child(root, 'dxfs')!, 'dxf').length : 0;
	const prefix = root.name.includes(':') ? root.name.slice(0, root.name.indexOf(':') + 1) : '';
	return { styles, numFmts, fonts, fills, borders, dxfs, prefix };
}

const argb = (hex: string) => `FF${hex.slice(1).toUpperCase()}`;

function fontXml(f: Font): string {
	return (
		'<font>' +
		(f.bold ? '<b/>' : '') +
		(f.italic ? '<i/>' : '') +
		(f.strike ? '<strike/>' : '') +
		(f.underline ? '<u/>' : '') +
		`<sz val="${f.size ?? 11}"/>` +
		(f.color ? `<color rgb="${argb(f.color)}"/>` : '<color theme="1"/>') +
		`<name val="${escapeAttr(f.name ?? 'Calibri')}"/>` +
		'</font>'
	);
}

const fillXml = (c: string) =>
	`<fill><patternFill patternType="solid"><fgColor rgb="${argb(c)}"/><bgColor indexed="64"/></patternFill></fill>`;

function borderXml(b: CellStyle['border']): string {
	const side = (n: string, e?: Edge) =>
		e
			? `<${n} style="${escapeAttr(e.style)}">${e.color ? `<color rgb="${argb(e.color)}"/>` : '<color auto="1"/>'}</${n}>`
			: `<${n}/>`;
	return `<border>${side('left', b.left)}${side('right', b.right)}${side('top', b.top)}${side('bottom', b.bottom)}<diagonal/></border>`;
}

/**
 * New cell formats for styles the file does not have, appended to the part.
 * `xfOf` gives the cell format index of a style; `text` the part to write.
 */
export class StyleAppender {
	readonly #part: StylesPart;
	#xml: string;
	readonly #fontIds = new Map<string, number>();
	readonly #fillIds = new Map<string, number>();
	readonly #borderIds = new Map<string, number>();
	readonly #numIds = new Map<string, number>();
	readonly #xfIds = new Map<string, number>();
	readonly #add = {
		numFmts: [] as string[],
		fonts: [] as string[],
		fills: [] as string[],
		borders: [] as string[],
		xfs: [] as string[]
	};
	#nextNumFmt: number;

	constructor(xml: string, part: StylesPart) {
		this.#xml = xml;
		this.#part = part;
		part.fonts.forEach((f, i) => this.#fontIds.has(key(f)) || this.#fontIds.set(key(f), i));
		part.fills.forEach((f, i) => this.#fillIds.has(key(f)) || this.#fillIds.set(key(f), i));
		part.borders.forEach((b, i) => this.#borderIds.has(key(b)) || this.#borderIds.set(key(b), i));
		for (const [id, code] of part.numFmts) if (!this.#numIds.has(code)) this.#numIds.set(code, id);
		this.#nextNumFmt = Math.max(163, ...part.numFmts.keys()) + 1;
		part.styles.forEach((s, i) => this.#xfIds.has(key(s)) || this.#xfIds.set(key(s), i));
	}

	get changed(): boolean {
		return this.#add.xfs.length > 0;
	}

	xfOf(style: CellStyle): number {
		const k = key(style);
		const found = this.#xfIds.get(k);
		if (found !== undefined) return found;
		const id = this.#part.styles.length + this.#add.xfs.length;
		const numFmtId = this.#numFmt(style.numFmt);
		const fontId = this.#id(
			this.#fontIds,
			style.font,
			this.#part.fonts.length,
			this.#add.fonts,
			fontXml
		);
		const fillId = style.fill
			? this.#id(this.#fillIds, style.fill, this.#part.fills.length, this.#add.fills, fillXml)
			: 0;
		const borderId = this.#id(
			this.#borderIds,
			style.border,
			this.#part.borders.length,
			this.#add.borders,
			borderXml
		);
		const a = style.align;
		const align =
			a.h || a.v || a.wrap || a.indent || a.rotate
				? `<alignment${a.h ? ` horizontal="${a.h}"` : ''}${a.v ? ` vertical="${a.v}"` : ''}${a.wrap ? ' wrapText="1"' : ''}${a.indent ? ` indent="${a.indent}"` : ''}${a.rotate ? ` textRotation="${a.rotate}"` : ''}/>`
				: '';
		this.#add.xfs.push(
			`<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"${align ? ' applyAlignment="1">' + align + '</xf>' : '/>'}`
		);
		this.#xfIds.set(k, id);
		return id;
	}

	#numFmt(code: string): number {
		const builtin = builtinIdOf(code);
		if (builtin >= 0) return builtin;
		const found = this.#numIds.get(code);
		if (found !== undefined) return found;
		const id = this.#nextNumFmt++;
		this.#numIds.set(code, id);
		this.#add.numFmts.push(`<numFmt numFmtId="${id}" formatCode="${escapeAttr(code)}"/>`);
		return id;
	}

	#id<T>(
		ids: Map<string, number>,
		v: T,
		base: number,
		add: string[],
		xml: (v: T) => string
	): number {
		const k = key(v);
		const found = ids.get(k);
		if (found !== undefined) return found;
		const id = base + add.length;
		add.push(xml(v));
		ids.set(k, id);
		return id;
	}

	/** The part with the additions, and every count that changed. */
	text(): string {
		let xml = this.#xml;
		const p = this.#part.prefix;
		// What is added carries the part's prefix, the elements inside it too.
		const prefixed = (s: string) => (p ? s.replace(/<(\/?)(?=[A-Za-z])/g, `<$1${p}`) : s);
		const append = (name: string, added: string[], following: string[]) => {
			if (added.length === 0) return;
			const parent = p + name;
			const items = added.map(prefixed);
			const before = following.map((b) => p + b);
			const open = new RegExp(`<${parent}(\\s[^>]*?)?(/?)>`).exec(xml);
			if (open && open[2] === '/') {
				xml =
					xml.slice(0, open.index) +
					`<${parent}${open[1] ?? ''}>${items.join('')}</${parent}>` +
					xml.slice(open.index + open[0].length);
			} else if (open) {
				const close = xml.indexOf(`</${parent}>`, open.index);
				xml = xml.slice(0, close) + items.join('') + xml.slice(close);
			} else {
				// The element is missing: put it before the first that follows it.
				const next = before.map((b) => xml.search(new RegExp(`<${b}[\\s/>]`))).find((i) => i >= 0);
				const el = `<${parent} count="${items.length}">${items.join('')}</${parent}>`;
				if (next === undefined) xml = spliceBeforeClose(xml, 'styleSheet', el);
				else xml = xml.slice(0, next) + el + xml.slice(next);
				return;
			}
			xml = xml.replace(new RegExp(`<${parent}(\\s[^>]*)?>`), (tag) => {
				const total = countIn(xml, name);
				return tag.replace(/(\scount\s*=\s*)(["'])\d*\2/, `$1$2${total}$2`);
			});
		};
		append('numFmts', this.#add.numFmts, ['fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs']);
		append('fonts', this.#add.fonts, ['fills', 'borders', 'cellStyleXfs', 'cellXfs']);
		append('fills', this.#add.fills, ['borders', 'cellStyleXfs', 'cellXfs']);
		append('borders', this.#add.borders, ['cellStyleXfs', 'cellXfs']);
		append('cellXfs', this.#add.xfs, ['cellStyles', 'dxfs', 'tableStyles', 'colors', 'extLst']);
		return xml;
	}
}

/** How many children an element has, by counting its direct child elements. */
function countIn(xml: string, parent: string): number {
	const root = parseXml(xml);
	const el = child(root, parent);
	return el ? kids(el).length : 0;
}

/** A small styles part for a workbook written from nothing. */
export const TEMPLATE_STYLES =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
	'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
	'<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>' +
	'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
	'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
	'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
	'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
	'</styleSheet>';
