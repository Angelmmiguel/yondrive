/**
 * `.odt`: OpenDocument text mapped to the document model and written back by the
 * same rule as `.docx` (PLAN 6.2). Formatting lives in named and automatic
 * styles, so a regenerated paragraph reuses the automatic styles its text already
 * had and adds its own, prefixed `Yd`, only for what is new. Lists nest in ODF, so
 * a list whose items are all still there in order keeps its markup and only its
 * changed paragraphs are regenerated; otherwise the list is rebuilt around the
 * paragraphs, which are still copied when they did not change.
 */
import {
	cleanMarks,
	extensionOfImage,
	hexColor,
	marksKey,
	normalizeInlines,
	sameBlock,
	sniffImage,
	Tally,
	type Align,
	type Block,
	type BlockStyle,
	type Cell,
	type Census,
	type DocModel,
	type Inline,
	type Locked,
	type Marks,
	type Paragraph,
	type Row,
	type Table
} from './model';
import { partText, spliceBeforeClose } from './ooxml';
import { emit, plan, type SourceItem } from './patch';
import { imageSize } from './docx';
import {
	child,
	descendants,
	escapeAttr,
	escapeXml,
	isElement,
	kids,
	parseXml,
	type XElement
} from './xml';
import { entryData, readZip, writeZip, ZIP_LIMITS, type ZipArchive, type ZipLimits } from './zip';

export class OdfError extends Error {}

const ODT_MIME = 'application/vnd.oasis.opendocument.text';

const PRELUDE = new Set([
	'office:forms',
	'text:tracked-changes',
	'text:variable-decls',
	'text:sequence-decls',
	'text:user-field-decls',
	'text:dde-connection-decls',
	'text:alphabetical-index-auto-mark-file',
	'table:calculation-settings',
	'table:content-validations',
	'table:label-ranges'
]);
const GAPS = new Set([
	'text:soft-page-break',
	'text:bookmark',
	'text:bookmark-start',
	'text:bookmark-end'
]);
const ANCHORS = new Set([
	'text:bookmark',
	'text:bookmark-start',
	'text:bookmark-end',
	'text:reference-mark',
	'text:reference-mark-start',
	'text:reference-mark-end'
]);
const LOCKING: Record<string, string> = {
	'text:note': 'Footnote',
	'office:annotation': 'Comment',
	'office:annotation-end': 'Comment',
	'text:change': 'Tracked change',
	'text:change-start': 'Tracked change',
	'text:change-end': 'Tracked change',
	'text:ruby': 'Phonetic guide',
	'text:meta': 'Metadata',
	'text:meta-field': 'Field',
	'draw:text-box': 'Text box',
	'draw:object': 'Embedded object',
	'draw:object-ole': 'Embedded object',
	'text:section': 'Section',
	'text:table-of-content': 'Table of contents',
	'text:numbered-paragraph': 'Numbered paragraph'
};
const IGNORED = new Set(['text:soft-page-break', 'office:annotation-end']);

interface TextStyle {
	name: string;
	family: string;
	parent?: string;
	display: string;
	listStyle?: string;
	props: Record<string, string>;
	/** From automatic styles: direct formatting, as opposed to a named style. */
	auto?: boolean;
	align?: string;
}

type ListLevels = Map<number, { kind: 'bullet' | 'number'; char: string }>;

type Source =
	| {
			kind: 'paragraph';
			item: SourceItem;
			model: Paragraph;
			startTag: string;
			tag: string;
			styleName?: string;
			anchors: string;
			spans: Map<string, string>;
			unit: number;
			checkByText: boolean;
	  }
	| { kind: 'image'; item: SourceItem; frame: string; key: string }
	| {
			kind: 'table';
			item: SourceItem;
			model: Table;
			startTag: string;
			columns: string;
			count: number;
			unit: number;
	  }
	| { kind: 'row'; item: SourceItem; model: Row; startTag: string }
	| { kind: 'cell'; item: SourceItem; model: Cell; startTag: string }
	| { kind: 'locked'; item: SourceItem; unit: number };

interface Unit {
	item: SourceItem;
	el: XElement;
	/** The leaf items it holds: one, or a list's paragraphs. */
	leaves: number[];
	list?: { style?: string };
}

interface Parsed {
	zip: ZipArchive;
	xml: string;
	stylesXml: string;
	root: XElement;
	text: XElement;
	styles: Map<string, TextStyle>;
	lists: Map<string, ListLevels>;
	fonts: Map<string, string>;
	sources: Map<number, Source>;
	units: Unit[];
	leaves: SourceItem[];
	model: DocModel;
	tally: Tally;
	normalStyle: string;
}

export async function readOdt(
	bytes: Uint8Array,
	limits: ZipLimits = ZIP_LIMITS
): Promise<{ model: DocModel; census: Census }> {
	const p = await parse(bytes, limits);
	return { model: p.model, census: p.tally.census() };
}

async function parse(bytes: Uint8Array, limits: ZipLimits): Promise<Parsed> {
	const zip = readZip(bytes, limits);
	const xml = await partText(zip, 'content.xml');
	if (xml === null) throw new OdfError('no content.xml');
	const stylesXml = (await partText(zip, 'styles.xml')) ?? '';
	const root = parseXml(xml);
	const body = child(root, 'office:body');
	const text = body && child(body, 'office:text');
	if (root.name !== 'office:document-content' || text === undefined) {
		throw new OdfError('not an OpenDocument text');
	}
	const styles = new Map<string, TextStyle>();
	const lists = new Map<string, ListLevels>();
	const fonts = new Map<string, string>();
	const readStyles = (container: XElement | undefined, auto = false) => {
		if (container === undefined) return;
		for (const s of kids(container)) {
			if (s.name === 'style:style') {
				const tp = child(s, 'style:text-properties');
				const pp = child(s, 'style:paragraph-properties');
				styles.set(s.attrs['style:name'] ?? '', {
					name: s.attrs['style:name'] ?? '',
					family: s.attrs['style:family'] ?? '',
					parent: s.attrs['style:parent-style-name'],
					display: (
						s.attrs['style:display-name'] ?? (s.attrs['style:name'] ?? '').replace(/_20_/g, ' ')
					).toLowerCase(),
					listStyle: s.attrs['style:list-style-name'],
					props: tp?.attrs ?? {},
					auto,
					align: pp?.attrs['fo:text-align']
				});
			} else if (s.name === 'text:list-style') {
				const levels: ListLevels = new Map();
				for (const l of kids(s)) {
					const level = Number(l.attrs['text:level'] ?? 1);
					if (l.name === 'text:list-level-style-bullet') {
						levels.set(level, { kind: 'bullet', char: l.attrs['text:bullet-char'] ?? '' });
					} else if (l.name === 'text:list-level-style-number') {
						const fmt = l.attrs['style:num-format'] ?? '';
						levels.set(level, { kind: fmt === '' ? 'bullet' : 'number', char: '' });
					} else levels.set(level, { kind: 'bullet', char: '' });
				}
				lists.set(s.attrs['style:name'] ?? '', levels);
			}
		}
	};
	const readFonts = (container: XElement | undefined) => {
		for (const f of container ? kids(container, 'style:font-face') : []) {
			fonts.set(
				f.attrs['style:name'] ?? '',
				(f.attrs['svg:font-family'] ?? '').replace(/^['"]|['"]$/g, '')
			);
		}
	};
	if (stylesXml !== '') {
		const sroot = parseXml(stylesXml);
		readStyles(child(sroot, 'office:styles'));
		readStyles(child(sroot, 'office:automatic-styles'), true);
		readFonts(child(sroot, 'office:font-face-decls'));
	}
	readStyles(child(root, 'office:automatic-styles'), true);
	readFonts(child(root, 'office:font-face-decls'));
	const p: Parsed = {
		zip,
		xml,
		stylesXml,
		root,
		text,
		styles,
		lists,
		fonts,
		sources: new Map(),
		units: [],
		leaves: [],
		model: { blocks: [], images: {} },
		tally: new Tally(),
		normalStyle: 'Standard'
	};
	const reader = new Reader(p);
	for (const el of kids(text)) {
		if (PRELUDE.has(el.name) || GAPS.has(el.name)) continue;
		await reader.unit(el);
	}
	const counts = new Map<string, number>();
	for (const b of p.model.blocks) {
		if (b.type !== 'paragraph' || b.style !== 'normal' || b.list) continue;
		const src = p.sources.get(b.ref as number);
		const name = src?.kind === 'paragraph' ? reader.namedStyle(src.styleName) : undefined;
		if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
	if (common) p.normalStyle = common;
	else if (styles.has('Text_20_body')) p.normalStyle = 'Text_20_body';
	censusOf(p);
	return p;
}

const STYLE_NAMES: Record<string, BlockStyle> = {
	title: 'title',
	quotations: 'quote',
	quote: 'quote',
	'block text': 'quote',
	'preformatted text': 'code',
	'source code': 'code',
	code: 'code'
};

function toPx(v: string | undefined): number | undefined {
	const m = /^([\d.]+)(in|cm|mm|pt|pc|px)$/.exec(v ?? '');
	if (!m) return undefined;
	const n = Number(m[1]);
	const per = { in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16, px: 1 }[m[2] as 'in'];
	return Math.round(n * per);
}

class Reader {
	readonly #p: Parsed;
	#ref = 0;

	constructor(p: Parsed) {
		this.#p = p;
	}

	#next(): number {
		return this.#ref++;
	}

	#chain(name: string | undefined): TextStyle[] {
		const out: TextStyle[] = [];
		const seen = new Set<string>();
		while (name !== undefined && !seen.has(name) && out.length < 16) {
			seen.add(name);
			const s = this.#p.styles.get(name);
			if (s === undefined) break;
			out.push(s);
			name = s.parent;
		}
		return out;
	}

	/** The first named (not automatic) style a paragraph's style comes from. */
	namedStyle(name: string | undefined): string | undefined {
		const chain = this.#chain(name);
		return chain.find((s) => !/^P\d+$/.test(s.name))?.name ?? chain.at(-1)?.parent;
	}

	async unit(el: XElement): Promise<void> {
		const p = this.#p;
		const index = p.units.length;
		const unit: Unit = { item: { ref: -1, start: el.start, end: el.end }, el, leaves: [] };
		p.units.push(unit);
		const push = (b: Block) => {
			const src = p.sources.get(b.ref as number)!;
			unit.leaves.push(p.leaves.length);
			p.leaves.push(src.item);
			p.model.blocks.push(b);
		};
		if (el.name === 'text:p' || el.name === 'text:h') push(await this.paragraph(el, index));
		else if (el.name === 'table:table') push(await this.table(el, index));
		else if (el.name === 'text:list') {
			const reason = this.#listLockReason(el);
			if (reason) push(this.locked(el, reason, index));
			else {
				unit.list = { style: el.attrs['text:style-name'] };
				for (const b of await this.#list(el, 0, el.attrs['text:style-name'], index)) push(b);
			}
		} else push(this.locked(el, LOCKING[el.name] ?? 'Unrecognised content', index));
	}

	locked(el: XElement, label: string, unit: number): Locked {
		const ref = this.#next();
		this.#p.sources.set(ref, { kind: 'locked', item: { ref, start: el.start, end: el.end }, unit });
		this.#p.tally.add(label, 'locked');
		return { type: 'locked', label, text: preview(el), ref };
	}

	#listLockReason(list: XElement): string | null {
		for (const item of kids(list)) {
			if (item.name === 'text:list-header') return 'List with unnumbered items';
			if (item.name !== 'text:list-item') continue;
			const paras = kids(item).filter((c) => c.name === 'text:p' || c.name === 'text:h');
			if (paras.length !== 1) return 'List item with several paragraphs';
			for (const c of kids(item)) {
				if (c.name === 'text:list') {
					const r = this.#listLockReason(c);
					if (r) return r;
				} else if (
					c.name !== 'text:p' &&
					c.name !== 'text:h' &&
					c.name !== 'text:soft-page-break'
				) {
					return 'List with complex content';
				}
			}
			const r = this.#paragraphLockReason(paras[0]);
			if (r) return r;
		}
		return null;
	}

	async #list(
		list: XElement,
		level: number,
		style: string | undefined,
		unit: number
	): Promise<Paragraph[]> {
		const out: Paragraph[] = [];
		const own = list.attrs['text:style-name'] ?? style;
		for (const item of kids(list, 'text:list-item')) {
			const itemStyle = item.attrs['text:style-override'] ?? own;
			for (const c of kids(item)) {
				if (c.name === 'text:list') out.push(...(await this.#list(c, level + 1, own, unit)));
				else if (c.name === 'text:p' || c.name === 'text:h') {
					const para = (await this.paragraph(c, unit)) as Paragraph;
					const lvl = this.#p.lists.get(itemStyle ?? '')?.get(level + 1);
					const char = lvl?.char ?? '';
					const kind = lvl?.kind ?? 'bullet';
					para.list = { kind, level: Math.min(level, 8) };
					if (char === '☐' || char === '☒' || char === '☑') {
						para.list = { kind: 'check', level: Math.min(level, 8), checked: char !== '☐' };
					} else if (kind === 'bullet' && takeCheck(para)) {
						const src = this.#p.sources.get(para.ref as number);
						if (src?.kind === 'paragraph') src.checkByText = true;
					}
					const src = this.#p.sources.get(para.ref as number);
					if (src?.kind === 'paragraph') src.model = para;
					out.push(para);
				}
			}
		}
		return out;
	}

	#paragraphLockReason(el: XElement): string | null {
		for (const d of descendants(el)) {
			if (LOCKING[d.name]) return LOCKING[d.name];
			if (d.name.startsWith('draw:') && !['draw:frame', 'draw:image'].includes(d.name))
				return 'Drawing';
			if (
				d.name === 'draw:frame' &&
				!kids(d).every(
					(k) => k.name === 'draw:image' || k.name === 'svg:title' || k.name === 'svg:desc'
				)
			) {
				return 'Drawing';
			}
			if (FIELDS.test(d.name)) return 'Field';
		}
		const walk = (e: XElement): string | null => {
			for (const c of kids(e)) {
				if (['text:span', 'text:a'].includes(c.name)) {
					const r = walk(c);
					if (r) return r;
				} else if (
					!['text:s', 'text:tab', 'text:line-break', 'draw:frame'].includes(c.name) &&
					!ANCHORS.has(c.name) &&
					!IGNORED.has(c.name)
				) {
					return 'Unrecognised content';
				}
			}
			return null;
		};
		return walk(el);
	}

	#style(el: XElement): BlockStyle {
		if (el.name === 'text:h') {
			const lvl = Math.min(Math.max(Number(el.attrs['text:outline-level'] ?? 1), 1), 6);
			return `h${lvl}` as BlockStyle;
		}
		for (const s of this.#chain(el.attrs['text:style-name'])) {
			const mapped = STYLE_NAMES[s.display];
			if (mapped) return mapped;
			const h = /^heading (\d)$/.exec(s.display);
			if (h && Number(h[1]) <= 6) return `h${h[1]}` as BlockStyle;
		}
		return 'normal';
	}

	#align(name: string | undefined): Align | undefined {
		for (const s of this.#chain(name)) {
			// A named style's alignment is the style's, not the paragraph's own.
			if (!s.auto) break;
			switch (s.align) {
				case 'start':
				case 'left':
					return 'left';
				case 'center':
					return 'center';
				case 'end':
				case 'right':
					return 'right';
				case 'justify':
					return 'justify';
			}
		}
		return undefined;
	}

	#marks(name: string | undefined, base: Marks): Marks {
		const m: Marks = { ...base };
		const chain = this.#chain(name).reverse();
		for (const s of chain) {
			if (/source|teletype|code|verbatim/i.test(s.name)) m.code = true;
			const t = s.props;
			if (t['fo:font-weight'] !== undefined) {
				if (t['fo:font-weight'] === 'bold' || Number(t['fo:font-weight']) >= 600) m.bold = true;
				else delete m.bold;
			}
			if (t['fo:font-style'] !== undefined) {
				if (t['fo:font-style'] === 'italic' || t['fo:font-style'] === 'oblique') m.italic = true;
				else delete m.italic;
			}
			const u = t['style:text-underline-style'];
			if (u !== undefined) {
				if (u !== 'none') m.underline = true;
				else delete m.underline;
			}
			const s2 = t['style:text-line-through-style'];
			if (s2 !== undefined) {
				if (s2 !== 'none') m.strike = true;
				else delete m.strike;
			}
			const family =
				t['fo:font-family'] ??
				(t['style:font-name']
					? (this.#p.fonts.get(t['style:font-name']) ?? t['style:font-name'])
					: undefined);
			// Fonts and sizes of named styles belong to the style, not the text.
			if (family && s.auto) m.font = family.replace(/^['"]|['"]$/g, '');
			const size = /^([\d.]+)pt$/.exec(t['fo:font-size'] ?? '');
			if (size && s.auto) m.size = Number(size[1]);
			const color = hexColor(t['fo:color']);
			if (color) m.color = color;
			const bg = hexColor(t['fo:background-color']);
			if (bg) m.highlight = bg;
		}
		return cleanMarks(m);
	}

	async paragraph(el: XElement, unit: number): Promise<Paragraph | Locked> {
		const reason = this.#paragraphLockReason(el);
		if (reason) return this.locked(el, reason, unit);
		const ref = this.#next();
		const src = this.#p.xml;
		const styleName = el.attrs['text:style-name'];
		const content: Inline[] = [];
		const anchors: string[] = [];
		const spans = new Map<string, string>();
		const walk = async (e: XElement, marks: Marks) => {
			for (const c of e.children) {
				if (!isElement(c)) {
					content.push({ type: 'text', text: c.text.replace(/[ \t\r\n]+/g, ' '), marks });
					continue;
				}
				switch (c.name) {
					case 'text:span': {
						const m = this.#marks(c.attrs['text:style-name'], marks);
						const key = spanKey(m);
						if (c.attrs['text:style-name'] && key !== '{}' && !spans.has(key)) {
							spans.set(key, c.attrs['text:style-name']);
						}
						await walk(c, m);
						break;
					}
					case 'text:a':
						await walk(c, { ...marks, link: c.attrs['xlink:href'] ?? '' });
						break;
					case 'text:s':
						content.push({
							type: 'text',
							text: ' '.repeat(Math.min(Number(c.attrs['text:c'] ?? 1) || 1, 1000)),
							marks
						});
						break;
					case 'text:tab':
						content.push({ type: 'text', text: '\t', marks });
						break;
					case 'text:line-break':
						content.push({ type: 'break' });
						break;
					case 'draw:frame':
						content.push(await this.#image(c, marks.link));
						break;
					default:
						if (ANCHORS.has(c.name)) anchors.push(src.slice(c.start, c.end));
				}
			}
		};
		await walk(el, this.#marks(undefined, {}));
		const first = content[0];
		if (first?.type === 'text') content[0] = { ...first, text: first.text.replace(/^ /, '') };
		const para: Paragraph = {
			type: 'paragraph',
			style: this.#style(el),
			content: normalizeInlines(content),
			ref
		};
		const align = this.#align(styleName);
		if (align) para.align = align;
		this.#p.sources.set(ref, {
			kind: 'paragraph',
			item: { ref, start: el.start, end: el.end },
			model: para,
			startTag: src.slice(el.start, el.innerStart).replace(/\/>$/, '>'),
			tag: el.name,
			styleName,
			anchors: anchors.join(''),
			spans,
			unit,
			checkByText: false
		});
		return para;
	}

	async #image(frame: XElement, link: string | undefined): Promise<Inline> {
		const ref = this.#next();
		const img = child(frame, 'draw:image');
		const href = img?.attrs['xlink:href'] ?? '';
		let key = `remote:${ref}`;
		if (href !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('/')) {
			key = href.replace(/^\.\//, '');
			if (this.#p.model.images[key] === undefined) {
				const entry = this.#p.zip.get(key);
				if (entry) {
					const bytes = await entryData(entry);
					const mime = sniffImage(bytes);
					if (mime === 'application/octet-stream')
						this.#p.tally.add('Image in a format not shown here', 'kept');
					this.#p.model.images[key] = { mime, bytes };
				}
			}
		} else this.#p.tally.add('Linked image, not loaded', 'kept');
		const desc = child(frame, 'svg:desc') ?? child(frame, 'svg:title');
		const image: Inline = {
			type: 'image',
			image: key,
			alt: desc ? textContent(desc) : (frame.attrs['draw:name'] ?? ''),
			ref
		};
		const width = toPx(frame.attrs['svg:width']);
		const height = toPx(frame.attrs['svg:height']);
		if (width && height) {
			image.width = width;
			image.height = height;
		}
		if (link !== undefined) image.link = link;
		this.#p.sources.set(ref, {
			kind: 'image',
			item: { ref, start: frame.start, end: frame.end },
			frame: this.#p.xml.slice(frame.start, frame.end),
			key
		});
		return image;
	}

	async table(el: XElement, unit: number): Promise<Table | Locked> {
		const reason = tableLockReason(el);
		if (reason) return this.locked(el, reason, unit);
		for (const d of descendants(el)) {
			if (d.name === 'text:p' || d.name === 'text:h') {
				const r = this.#paragraphLockReason(d);
				if (r) return this.locked(el, r, unit);
			}
		}
		const src = this.#p.xml;
		const ref = this.#next();
		const rows: Row[] = [];
		const columns: XElement[] = [];
		let count = 0;
		const readRows = async (container: XElement, header: boolean) => {
			for (const c of kids(container)) {
				if (c.name === 'table:table-column') {
					columns.push(c);
					count += Number(c.attrs['table:number-columns-repeated'] ?? 1) || 1;
				} else if (c.name === 'table:table-columns' || c.name === 'table:table-header-columns') {
					await readRows(c, header);
				} else if (c.name === 'table:table-header-rows') await readRows(c, true);
				else if (c.name === 'table:table-rows') await readRows(c, header);
				else if (c.name === 'table:table-row') {
					const rowRef = this.#next();
					const cells: Cell[] = [];
					for (const tc of kids(c, 'table:table-cell')) {
						const cellRef = this.#next();
						const content: Paragraph[] = [];
						for (const p of kids(tc)) {
							if (p.name === 'text:p' || p.name === 'text:h')
								content.push((await this.paragraph(p, unit)) as Paragraph);
						}
						if (content.length === 0)
							content.push({ type: 'paragraph', style: 'normal', content: [] });
						const cell: Cell = { content, ref: cellRef };
						if (header) cell.header = true;
						this.#p.sources.set(cellRef, {
							kind: 'cell',
							item: { ref: cellRef, start: tc.start, end: tc.end },
							model: cell,
							startTag: src.slice(tc.start, tc.innerStart).replace(/\/>$/, '>')
						});
						cells.push(cell);
					}
					const row: Row = { cells, ref: rowRef };
					this.#p.sources.set(rowRef, {
						kind: 'row',
						item: { ref: rowRef, start: c.start, end: c.end },
						model: row,
						startTag: src.slice(c.start, c.innerStart)
					});
					rows.push(row);
				}
			}
		};
		await readRows(el, false);
		const table: Table = { type: 'table', rows, ref };
		this.#p.sources.set(ref, {
			kind: 'table',
			item: { ref, start: el.start, end: el.end },
			model: table,
			startTag: src.slice(el.start, el.innerStart),
			columns: columns.map((c) => src.slice(c.start, c.end)).join(''),
			count,
			unit
		});
		return table;
	}
}

const FIELDS =
	/^text:(page-number|page-count|date|time|sequence|sequence-ref|variable-get|variable-set|variable-input|user-field-get|user-field-input|chapter|bookmark-ref|reference-ref|note-ref|title|subject|author-name|author-initials|file-name|template-name|sender-|placeholder|expression|text-input|drop-down|hidden-text|conditional-text|hidden-paragraph|word-count|character-count|paragraph-count|table-count|image-count|object-count|initial-creator|creation-date|creation-time|description|keywords|editing-|modification-|print-|creator|database-|script|execute-macro|dde-connection|measure|table-formula|toc-mark|alphabetical-index-mark|user-index-mark|bibliography-mark)/;

function tableLockReason(el: XElement): string | null {
	for (const d of descendants(el)) {
		if (d.name === 'table:table') return 'Nested table';
		if (d.name === 'table:covered-table-cell') return 'Table with merged cells';
		if (d.name === 'table:table-cell') {
			if (
				Number(d.attrs['table:number-columns-spanned'] ?? 1) > 1 ||
				Number(d.attrs['table:number-rows-spanned'] ?? 1) > 1
			) {
				return 'Table with merged cells';
			}
			if (d.attrs['table:formula'] !== undefined) return 'Table with formulas';
			if (Number(d.attrs['table:number-columns-repeated'] ?? 1) > 1)
				return 'Table with repeated cells';
			for (const k of kids(d))
				if (k.name !== 'text:p' && k.name !== 'text:h') return 'Table with complex content';
		}
		if (d.name === 'table:table-row' && Number(d.attrs['table:number-rows-repeated'] ?? 1) > 1) {
			return 'Table with repeated rows';
		}
	}
	return null;
}

const CHECK_OFF = '☐ ';
const CHECK_ON = ['☒ ', '☑ '];

function takeCheck(p: Paragraph): boolean {
	const first = p.content[0];
	if (first?.type !== 'text') return false;
	let checked: boolean;
	if (first.text.startsWith(CHECK_OFF)) checked = false;
	else if (CHECK_ON.some((c) => first.text.startsWith(c))) checked = true;
	else return false;
	p.list = { kind: 'check', level: p.list?.level ?? 0, checked };
	p.content = normalizeInlines([{ ...first, text: first.text.slice(2) }, ...p.content.slice(1)]);
	return true;
}

const textContent = (el: XElement): string =>
	el.children.map((c) => (isElement(c) ? textContent(c) : c.text)).join('');

function preview(el: XElement): string {
	let out = '';
	const walk = (e: XElement) => {
		for (const c of e.children) {
			if (!isElement(c)) out += c.text.replace(/[ \t\r\n]+/g, ' ');
			else if (c.name === 'text:tab') out += '\t';
			else if (c.name === 'text:line-break') out += '\n';
			else if (c.name === 'text:s') out += ' ';
			else if (c.name === 'text:tracked-changes' || c.name === 'office:annotation') continue;
			else {
				walk(c);
				if (c.name === 'text:p' || c.name === 'text:h' || c.name === 'table:table-row') out += '\n';
			}
		}
	};
	walk(el);
	return out.replace(/\n{3,}/g, '\n\n').trim();
}

const spanKey = (marks: Marks) => {
	const { link, ...rest } = cleanMarks(marks);
	void link;
	return marksKey(rest);
};

function censusOf(p: Parsed): void {
	for (const e of p.zip.entries) {
		if (/^(Basic|Scripts)\//.test(e.name)) {
			p.tally.add('Macros', 'kept');
			break;
		}
	}
	if (p.zip.entries.some((e) => /^Object \d+\//.test(e.name)))
		p.tally.add('Embedded objects', 'kept');
	if (/<style:(header|footer)[\s>]/.test(p.stylesXml)) p.tally.add('Headers and footers', 'kept');
	if (p.zip.get('Thumbnails/thumbnail.png'))
		p.tally.add('Preview picture, not updated on save', 'kept');
	if (child(p.text, 'text:tracked-changes') !== undefined)
		p.tally.add('Record of tracked changes', 'kept');
}

// Writing.

const NAMED_STYLES: Record<
	string,
	{ name: string; display: string; xml: string; family?: string }
> = {
	title: {
		name: 'Title',
		display: 'Title',
		xml: '<style:text-properties fo:font-size="28pt" fo:font-weight="bold"/>'
	},
	quote: {
		name: 'Quotations',
		display: 'Quotations',
		xml: '<style:paragraph-properties fo:margin-left="0.4in" fo:margin-right="0.4in"/>'
	},
	code: {
		name: 'Preformatted_20_Text',
		display: 'Preformatted Text',
		xml: '<style:text-properties style:font-name="Liberation Mono" fo:font-family="\'Liberation Mono\'" fo:font-size="10pt"/>'
	},
	codeChar: {
		name: 'Source_20_Text',
		display: 'Source Text',
		family: 'text',
		xml: '<style:text-properties fo:font-family="\'Liberation Mono\'"/>'
	}
};
for (let i = 1; i <= 6; i++) {
	NAMED_STYLES[`h${i}`] = {
		name: `Heading_20_${i}`,
		display: `Heading ${i}`,
		xml: `<style:text-properties fo:font-size="${[20, 16, 14, 13, 12, 11][i - 1]}pt" fo:font-weight="bold"/>`
	};
}

class Writer {
	readonly p: Parsed;
	readonly model: DocModel;
	readonly used = new Set<number>();
	readonly media: { name: string; data: Uint8Array; mime: string }[] = [];
	readonly #auto: string[] = [];
	readonly #autoKeys = new Map<string, string>();
	readonly #named: string[] = [];
	#n = 0;

	constructor(p: Parsed, model: DocModel) {
		this.p = p;
		this.model = model;
	}

	#fresh(prefix: string): string {
		let name: string;
		do name = `Yd${prefix}${++this.#n}`;
		while (this.p.styles.has(name));
		return name;
	}

	named(kind: string): string {
		const def = NAMED_STYLES[kind];
		const found = [...this.p.styles.values()].find(
			(s) => s.family === (def.family ?? 'paragraph') && s.display === def.display.toLowerCase()
		);
		if (found) return found.name;
		this.p.styles.set(def.name, {
			name: def.name,
			family: def.family ?? 'paragraph',
			display: def.display.toLowerCase(),
			props: {}
		});
		this.#named.push(
			`<style:style style:name="${def.name}" style:display-name="${def.display}" style:family="${def.family ?? 'paragraph'}"${def.family ? '' : ` style:parent-style-name="${this.p.normalStyle}"`}>${def.xml}</style:style>`
		);
		return def.name;
	}

	/** An automatic style, shared by everything that asks for the same thing. */
	auto(family: string, parent: string | undefined, body: string): string {
		const key = `${family}|${parent ?? ''}|${body}`;
		const known = this.#autoKeys.get(key);
		if (known) return known;
		const name = this.#fresh(family === 'paragraph' ? 'P' : family === 'text' ? 'T' : 'L');
		this.p.styles.set(name, { name, family, parent, display: name.toLowerCase(), props: {} });
		const parentAttr = parent ? ` style:parent-style-name="${escapeAttr(parent)}"` : '';
		this.#auto.push(
			family === 'list'
				? body.replace('%NAME%', name)
				: `<style:style style:name="${name}" style:family="${family}"${parentAttr}>${body}</style:style>`
		);
		this.#autoKeys.set(key, name);
		return name;
	}

	listStyle(kind: 'bullet' | 'number'): string {
		let levels = '';
		for (let i = 1; i <= 10; i++) {
			const props = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${(0.25 + 0.25 * i).toFixed(2)}in" fo:text-indent="-0.25in" fo:margin-left="${(0.25 + 0.25 * i).toFixed(2)}in"/></style:list-level-properties>`;
			levels +=
				kind === 'number'
					? `<text:list-level-style-number text:level="${i}" style:num-suffix="." style:num-format="${['1', 'a', 'i'][(i - 1) % 3]}">${props}</text:list-level-style-number>`
					: `<text:list-level-style-bullet text:level="${i}" text:bullet-char="${['•', '◦', '▪'][(i - 1) % 3]}">${props}</text:list-level-style-bullet>`;
		}
		return this.auto(
			'list',
			undefined,
			`<text:list-style style:name="%NAME%">${levels}</text:list-style>`
		);
	}

	textStyle(marks: Marks): string | undefined {
		const { link, code, ...rest } = cleanMarks(marks);
		void link;
		let props = '';
		if (rest.bold)
			props +=
				' fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"';
		if (rest.italic)
			props +=
				' fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"';
		if (rest.underline)
			props +=
				' style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"';
		if (rest.strike)
			props += ' style:text-line-through-style="solid" style:text-line-through-type="single"';
		if (rest.font) props += ` fo:font-family="${escapeAttr(quoteFont(rest.font))}"`;
		if (rest.size) props += ` fo:font-size="${rest.size}pt"`;
		if (rest.color) props += ` fo:color="${rest.color}"`;
		if (rest.highlight) props += ` fo:background-color="${rest.highlight}"`;
		const parent = code ? this.named('codeChar') : undefined;
		if (props === '') return parent;
		return this.auto('text', parent, `<style:text-properties${props}/>`);
	}

	stylesText(): string | null {
		if (this.#named.length === 0 || this.p.stylesXml === '') return null;
		return spliceBefore(this.p.stylesXml, 'office:styles', this.#named.join(''));
	}

	contentAutoStyles(xml: string): string {
		if (this.#auto.length === 0) return xml;
		return spliceBefore(xml, 'office:automatic-styles', this.#auto.join(''), '<office:body');
	}
}

const quoteFont = (f: string) => (/\s/.test(f) ? `'${f}'` : f);

/** Inserts before the closing tag of a container, creating it before `fallback` if absent. */
function spliceBefore(xml: string, container: string, add: string, fallback?: string): string {
	const close = xml.lastIndexOf(`</${container}>`);
	if (close >= 0) return xml.slice(0, close) + add + xml.slice(close);
	const self = new RegExp(`<${container}(\\s[^>]*)?/>`).exec(xml);
	if (self)
		return `${xml.slice(0, self.index)}<${container}${self[1] ?? ''}>${add}</${container}>${xml.slice(self.index + self[0].length)}`;
	const at = fallback ? xml.indexOf(fallback) : -1;
	if (at >= 0) return `${xml.slice(0, at)}<${container}>${add}</${container}>${xml.slice(at)}`;
	return spliceBeforeClose(xml, 'document-styles', `<${container}>${add}</${container}>`);
}

const ALIGN: Record<Align, string> = {
	left: 'start',
	center: 'center',
	right: 'end',
	justify: 'justify'
};

function genInlines(content: readonly Inline[], w: Writer, spans?: Map<string, string>): string {
	let out = '';
	let i = 0;
	while (i < content.length) {
		const it = content[i];
		const link = it.type === 'text' ? it.marks.link : it.type === 'image' ? it.link : undefined;
		if (link !== undefined) {
			let inner = '';
			while (i < content.length) {
				const c = content[i];
				const l = c.type === 'text' ? c.marks.link : c.type === 'image' ? c.link : undefined;
				if (l !== link) break;
				inner += genInline(c, w, spans);
				i++;
			}
			out += `<text:a xlink:type="simple" xlink:href="${escapeAttr(link)}">${inner}</text:a>`;
		} else {
			out += genInline(it, w, spans);
			i++;
		}
	}
	return out;
}

function genText(text: string): string {
	// eslint-disable-next-line no-control-regex
	const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
	let out = '';
	const re = /(\t)|( {2,})|(^ )|(\n)/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(clean))) {
		out += escapeXml(clean.slice(last, m.index));
		if (m[1]) out += '<text:tab/>';
		else if (m[2]) out += ` <text:s text:c="${m[2].length - 1}"/>`;
		else if (m[3]) out += '<text:s/>';
		else out += '<text:line-break/>';
		last = re.lastIndex;
	}
	out += escapeXml(clean.slice(last));
	return out;
}

function genInline(it: Inline, w: Writer, spans?: Map<string, string>): string {
	if (it.type === 'break') return '<text:line-break/>';
	if (it.type === 'image') return genImage(it, w);
	const style = spans?.get(spanKey(it.marks)) ?? w.textStyle(it.marks);
	const body = genText(it.text);
	return style ? `<text:span text:style-name="${escapeAttr(style)}">${body}</text:span>` : body;
}

function genImage(img: Extract<Inline, { type: 'image' }>, w: Writer): string {
	const src = img.ref === undefined ? undefined : w.p.sources.get(img.ref);
	if (src?.kind === 'image' && src.key === img.image && !w.used.has(img.ref as number)) {
		w.used.add(img.ref as number);
		return src.frame;
	}
	let href = img.image;
	if (w.p.zip.get(href) === undefined) {
		const data = w.model.images[img.image];
		if (data === undefined) return '';
		const ext = extensionOfImage(data.mime);
		if (ext === 'bin') return '';
		href = `Pictures/yd-image-${w.media.length + 1}.${ext}`;
		w.media.push({ name: href, data: data.bytes, mime: data.mime });
	}
	const data = w.model.images[img.image];
	const natural = data ? imageSize(data.bytes) : null;
	let width = img.width ?? natural?.width ?? 400;
	let height = img.height ?? natural?.height ?? 300;
	if (width > 624) {
		height = Math.round((height * 624) / width);
		width = 624;
	}
	const desc = img.alt ? `<svg:desc>${escapeXml(img.alt)}</svg:desc>` : '';
	return `<draw:frame text:anchor-type="as-char" svg:width="${(width / 96).toFixed(4)}in" svg:height="${(height / 96).toFixed(4)}in" draw:z-index="0"><draw:image xlink:href="${escapeAttr(href)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>${desc}</draw:frame>`;
}

function genParagraph(p: Paragraph, w: Writer, ref?: number): string {
	let src = ref === undefined ? undefined : w.p.sources.get(ref);
	if (src?.kind !== 'paragraph' || w.used.has(ref as number)) src = undefined;
	else w.used.add(ref as number);
	const orig = src?.kind === 'paragraph' ? src : undefined;
	const heading = /^h[1-6]$/.test(p.style);
	const tag = heading ? 'text:h' : 'text:p';
	let style: string | undefined;
	if (orig && orig.model.style === p.style && orig.model.align === p.align) style = orig.styleName;
	else {
		const base =
			p.style === 'normal'
				? orig && orig.model.style === 'normal'
					? (orig.styleName ?? w.p.normalStyle)
					: w.p.normalStyle
				: w.named(p.style);
		style = p.align
			? w.auto('paragraph', base, `<style:paragraph-properties fo:text-align="${ALIGN[p.align]}"/>`)
			: base;
	}
	let attrs = style ? ` text:style-name="${escapeAttr(style)}"` : '';
	if (heading) attrs += ` text:outline-level="${p.style.slice(1)}"`;
	let content = p.content;
	const byStyle = orig?.model.list?.kind === 'check' && !orig.checkByText;
	if (p.list?.kind === 'check' && !byStyle) {
		content = normalizeInlines([
			{
				type: 'text',
				text: p.list.checked ? CHECK_ON[0] : CHECK_OFF,
				marks: p.content[0]?.type === 'text' ? p.content[0].marks : {}
			},
			...p.content
		]);
	}
	const start =
		orig && orig.tag === tag && style === orig.styleName ? orig.startTag : `<${tag}${attrs}>`;
	return `${start}${orig?.anchors ?? ''}${genInlines(content, w, orig?.spans)}</${tag}>`;
}

function writeParagraph(p: Paragraph, w: Writer): string {
	const src = p.ref === undefined ? undefined : w.p.sources.get(p.ref);
	if (src?.kind === 'paragraph' && !w.used.has(p.ref as number) && sameBlock(p, src.model)) {
		w.used.add(p.ref as number);
		return w.p.xml.slice(src.item.start, src.item.end);
	}
	return genParagraph(p, w, p.ref);
}

function genTable(t: Table, w: Writer): string {
	const s = t.ref === undefined ? undefined : w.p.sources.get(t.ref);
	const orig = s?.kind === 'table' && !w.used.has(t.ref as number) ? s : undefined;
	if (orig) w.used.add(t.ref as number);
	if (orig && sameBlock(t, orig.model)) return w.p.xml.slice(orig.item.start, orig.item.end);
	const count = Math.max(1, ...t.rows.map((r) => r.cells.length));
	const start = orig?.startTag ?? `<table:table table:name="YdTable${t.ref ?? w.used.size}">`;
	const columns =
		orig && orig.count === count
			? orig.columns
			: `<table:table-column table:number-columns-repeated="${count}"/>`;
	const row = (r: Row) => {
		const rs = r.ref === undefined ? undefined : w.p.sources.get(r.ref);
		const rowSrc = rs?.kind === 'row' && !w.used.has(r.ref as number) ? rs : undefined;
		if (rowSrc) w.used.add(r.ref as number);
		if (
			rowSrc &&
			sameBlock({ type: 'table', rows: [r] }, { type: 'table', rows: [rowSrc.model] })
		) {
			return w.p.xml.slice(rowSrc.item.start, rowSrc.item.end);
		}
		let cells = '';
		for (const c of r.cells) {
			const cs = c.ref === undefined ? undefined : w.p.sources.get(c.ref);
			const cellSrc = cs?.kind === 'cell' && !w.used.has(c.ref as number) ? cs : undefined;
			if (cellSrc) w.used.add(c.ref as number);
			const head = cellSrc?.startTag ?? '<table:table-cell office:value-type="string">';
			const paras =
				c.content.length === 0
					? [{ type: 'paragraph', style: 'normal', content: [] } as Paragraph]
					: c.content;
			cells += `${head}${paras.map((p) => writeParagraph(p, w)).join('')}</table:table-cell>`;
		}
		return `${rowSrc?.startTag ?? '<table:table-row>'}${cells}</table:table-row>`;
	};
	const headers = t.rows.filter((r) => r.cells.some((c) => c.header));
	const body = t.rows.filter((r) => !r.cells.some((c) => c.header));
	const head =
		headers.length > 0
			? `<table:table-header-rows>${headers.map(row).join('')}</table:table-header-rows>`
			: '';
	return `${start}${columns}${head}${body.map(row).join('')}</table:table>`;
}

/** A run of list items as a nested list, with the paragraphs copied where they did not change. */
function genList(items: readonly Paragraph[], w: Writer, style: string | undefined): string {
	let out = '';
	let depth = -1;
	const open = (first: boolean) =>
		first && style ? `<text:list text:style-name="${escapeAttr(style)}">` : '<text:list>';
	for (const p of items) {
		const level = p.list?.level ?? 0;
		if (depth < 0) {
			out += open(true) + '<text:list-item>';
			depth = 0;
			for (; depth < level; depth++) out += '<text:list><text:list-item>';
		} else if (level > depth) {
			for (; depth < level; depth++) out += '<text:list><text:list-item>';
		} else {
			for (; depth > level; depth--) out += '</text:list-item></text:list>';
			out += '</text:list-item><text:list-item>';
		}
		out += writeParagraph(p, w);
	}
	for (; depth > 0; depth--) out += '</text:list-item></text:list>';
	if (items.length > 0) out += '</text:list-item></text:list>';
	return out;
}

/** What goes in one place of `office:text`: one block, or a run of list items. */
interface Segment {
	blocks: Block[];
	list: boolean;
	/** The unit it stands in for, if any. */
	unit?: number;
}

function writeSegment(seg: Segment, w: Writer, unitAtom?: SourceItem): string {
	const p = w.p;
	if (!seg.list) {
		const b = seg.blocks[0];
		if (b.type === 'locked') {
			const src = b.ref === undefined ? undefined : p.sources.get(b.ref);
			return src ? p.xml.slice(src.item.start, src.item.end) : '';
		}
		if (b.type === 'table') return genTable(b, w);
		return writeParagraph(b, w);
	}
	const paras = seg.blocks as Paragraph[];
	const unit = seg.unit === undefined ? undefined : p.units[seg.unit];
	if (unit && unitAtom && intact(paras, unit, p)) {
		// The same items in the same places: the markup stays and changed paragraphs are spliced.
		const leaves = unit.leaves.map((i) => p.leaves[i]);
		const atoms = plan(
			p.xml,
			{ start: unit.item.start, end: unit.item.end },
			leaves,
			paras,
			(b) => b.ref
		);
		return emit(
			p.xml,
			atoms,
			(b, item) => {
				const src = p.sources.get(item.ref);
				return src?.kind === 'paragraph' && sameBlock(b, src.model);
			},
			(b) => genParagraph(b, w, b.ref)
		);
	}
	const kind = paras[0].list?.kind === 'number' ? 'number' : 'bullet';
	const origStyle = unit?.list?.style;
	const origKind = origStyle ? p.lists.get(origStyle)?.get(1)?.kind : undefined;
	const style = origStyle && origKind === kind ? origStyle : w.listStyle(kind);
	return genList(paras, w, style);
}

function intact(paras: readonly Paragraph[], unit: Unit, p: Parsed): boolean {
	if (paras.length !== unit.leaves.length) return false;
	return paras.every((b, i) => {
		const item = p.leaves[unit.leaves[i]];
		const src = p.sources.get(item.ref);
		return (
			b.ref === item.ref &&
			src?.kind === 'paragraph' &&
			JSON.stringify(b.list ?? null) === JSON.stringify(src.model.list ?? null)
		);
	});
}

export async function writeOdt(
	model: DocModel,
	original?: Uint8Array,
	limits: ZipLimits = ZIP_LIMITS
): Promise<Uint8Array> {
	const p = await parse(original ?? (await odtTemplate()), limits);
	const w = new Writer(p, model);
	const unitOf = (b: Block): number | undefined => {
		const src = b.ref === undefined ? undefined : p.sources.get(b.ref);
		return src && 'unit' in src ? src.unit : undefined;
	};
	// Runs of list items become one segment; anything else is a segment of its own.
	const segments: Segment[] = [];
	for (const b of model.blocks) {
		const isList = b.type === 'paragraph' && b.list !== undefined;
		const last = segments.at(-1);
		const unit = unitOf(b);
		const prev = last?.blocks.at(-1);
		// A list goes on through new items, and ends where another list's own items
		// begin or where a new item starts a list of another kind.
		const sameList =
			isList &&
			last?.list === true &&
			(unit === undefined || last.unit === undefined || unit === last.unit) &&
			!(
				unit === undefined &&
				(b as Paragraph).list?.level === 0 &&
				prev?.type === 'paragraph' &&
				(prev.list?.kind === 'number') !== ((b as Paragraph).list?.kind === 'number')
			);
		if (sameList && last) {
			last.blocks.push(b);
			last.unit ??= unitOf(b);
		} else segments.push({ blocks: [b], list: isList, unit: unitOf(b) });
	}
	const preludeEnd = (() => {
		let end = p.text.innerStart;
		for (const k of kids(p.text)) {
			if (PRELUDE.has(k.name)) end = k.end;
			else break;
		}
		return end;
	})();
	const unitItems = p.units.map((u, i) => ({ ref: i, start: u.item.start, end: u.item.end }));
	const atoms = plan(
		p.xml,
		{ start: p.text.innerStart, end: p.text.innerEnd, preludeEnd },
		unitItems,
		segments,
		(s) => s.unit
	);
	let inner = '';
	for (const a of atoms) {
		if (a.kind === 'gap') inner += a.text;
		else inner += writeSegment(a.block, w, a.kind === 'kept' ? a.item : undefined);
	}
	let xml = p.xml.slice(0, p.text.innerStart) + inner + p.xml.slice(p.text.innerEnd);
	xml = w.contentAutoStyles(xml);
	xml = ensureNamespaces(xml);
	const enc = new TextEncoder();
	const changes: { name: string; data: Uint8Array }[] = [];
	if (xml !== p.xml) changes.push({ name: 'content.xml', data: enc.encode(xml) });
	const styles = w.stylesText();
	if (styles !== null) changes.push({ name: 'styles.xml', data: enc.encode(styles) });
	if (w.media.length > 0) {
		changes.push(...w.media.map((m) => ({ name: m.name, data: m.data })));
		const manifest = await partText(p.zip, 'META-INF/manifest.xml');
		if (manifest !== null) {
			const add = w.media
				.map(
					(m) =>
						`<manifest:file-entry manifest:full-path="${escapeAttr(m.name)}" manifest:media-type="${m.mime}"/>`
				)
				.join('');
			changes.push({
				name: 'META-INF/manifest.xml',
				data: enc.encode(spliceBeforeClose(manifest, 'manifest', add))
			});
		}
	}
	return writeZip(p.zip, changes);
}

const NAMESPACES: Record<string, string> = {
	'xmlns:draw': 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
	'xmlns:svg': 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
	'xmlns:xlink': 'http://www.w3.org/1999/xlink',
	'xmlns:fo': 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
	'xmlns:table': 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
	'xmlns:style': 'urn:oasis:names:tc:opendocument:xmlns:style:1.0'
};

/** Declares on the root the prefixes regenerated markup uses, if it does not already. */
function ensureNamespaces(xml: string): string {
	const m = /<office:document-content\b[^>]*>/.exec(xml);
	if (!m) return xml;
	const missing = Object.entries(NAMESPACES).filter(([k]) => !m[0].includes(`${k}=`));
	if (missing.length === 0) return xml;
	const add = missing.map(([k, v]) => ` ${k}="${v}"`).join('');
	const tag = m[0].replace(/\s*>$/, `${add}>`);
	return xml.slice(0, m.index) + tag + xml.slice(m.index + m[0].length);
}

let template: Promise<Uint8Array> | null = null;

/** A minimal valid OpenDocument text. */
export function odtTemplate(): Promise<Uint8Array> {
	template ??= (() => {
		const enc = new TextEncoder();
		const ns = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"`;
		const head = '<?xml version="1.0" encoding="UTF-8"?>\n';
		const named = Object.values(NAMED_STYLES)
			.map(
				(d) =>
					`<style:style style:name="${d.name}" style:display-name="${d.display}" style:family="${d.family ?? 'paragraph'}"${d.family ? '' : ' style:parent-style-name="Standard"'}>${d.xml}</style:style>`
			)
			.join('');
		const styles = `${head}<office:document-styles ${ns}><office:styles><style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.08in"/><style:text-properties fo:font-size="11pt"/></style:default-style><style:style style:name="Standard" style:family="paragraph"/>${named}</office:styles><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="8.5in" fo:page-height="11in" fo:margin-top="1in" fo:margin-bottom="1in" fo:margin-left="1in" fo:margin-right="1in"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>`;
		const content = `${head}<office:document-content ${ns}><office:automatic-styles/><office:body><office:text><text:sequence-decls/></office:text></office:body></office:document-content>`;
		const manifest = `${head}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${ODT_MIME}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
		return writeZip(null, [
			{ name: 'mimetype', data: enc.encode(ODT_MIME), store: true },
			{ name: 'content.xml', data: enc.encode(content) },
			{ name: 'styles.xml', data: enc.encode(styles) },
			{ name: 'META-INF/manifest.xml', data: enc.encode(manifest) }
		]);
	})();
	return template;
}
