/**
 * `.docx`: Word's body mapped to the document model, and written back by PLAN
 * 6.2. A block keeps a `ref` to its element; on save an unchanged block is copied
 * from the original text, a changed one is regenerated from the model with what
 * it had that the model does not know (paragraph and run properties, bookmarks,
 * image runs) carried over, and every other part of the package keeps its
 * compressed bytes. What the editor cannot represent becomes a locked block.
 */
import {
	cleanMarks,
	extensionOfImage,
	hexColor,
	HIGHLIGHTS,
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
	type ImageData,
	type Inline,
	type ListInfo,
	type Locked,
	type Marks,
	type Paragraph,
	type Row,
	type Table
} from './model';
import {
	ContentTypes,
	find,
	partText,
	REL,
	Rels,
	relsPathOf,
	resolveTarget,
	spliceBeforeClose
} from './ooxml';
import { plan, type SourceItem } from './patch';
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

export class DocxError extends Error {}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PIC_URI = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const IMAGE_TYPES: Record<string, string> = {
	png: 'image/png',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	bmp: 'image/bmp',
	webp: 'image/webp'
};

/** Elements that make a paragraph locked, and what to call them. */
const LOCKING: Record<string, string> = {
	'w:ins': 'Tracked change',
	'w:del': 'Tracked change',
	'w:moveFrom': 'Tracked change',
	'w:moveTo': 'Tracked change',
	'w:moveFromRangeStart': 'Tracked change',
	'w:moveToRangeStart': 'Tracked change',
	'w:rPrChange': 'Tracked change',
	'w:pPrChange': 'Tracked change',
	'w:numberingChange': 'Tracked change',
	'w:customXmlInsRangeStart': 'Tracked change',
	'm:oMath': 'Equation',
	'm:oMathPara': 'Equation',
	'w:txbxContent': 'Text box',
	'w:fldChar': 'Field',
	'w:fldSimple': 'Field',
	'w:instrText': 'Field',
	'w:commentRangeStart': 'Comment',
	'w:commentRangeEnd': 'Comment',
	'w:commentReference': 'Comment',
	'w:footnoteReference': 'Footnote',
	'w:endnoteReference': 'Endnote',
	'w:sdt': 'Content control',
	'w:object': 'Embedded object',
	'w:pict': 'Drawing',
	'mc:AlternateContent': 'Drawing',
	'w:sym': 'Symbol',
	'w:ruby': 'Phonetic guide',
	'w:smartTag': 'Smart tag',
	'w:customXml': 'Custom markup',
	'w:subDoc': 'Subdocument',
	'w:ptab': 'Positioned tab',
	'w:dir': 'Text direction',
	'w:bdo': 'Text direction',
	'w:contentPart': 'Ink'
};

/** Paragraph children that are copied into a regenerated paragraph as they were. */
const ANCHORS = new Set(['w:bookmarkStart', 'w:bookmarkEnd', 'w:permStart', 'w:permEnd']);
/** Paragraph and run children that carry nothing the model needs. */
const IGNORED = new Set(['w:proofErr', 'w:lastRenderedPageBreak', 'w:rPr', 'w:annotationRef']);
/** Body children that sit between blocks rather than being one. */
const BODY_GAPS = new Set([
	'w:sectPr',
	'w:bookmarkStart',
	'w:bookmarkEnd',
	'w:permStart',
	'w:permEnd',
	'w:proofErr'
]);

const PPR_ORDER = [
	'w:pStyle',
	'w:keepNext',
	'w:keepLines',
	'w:pageBreakBefore',
	'w:framePr',
	'w:widowControl',
	'w:numPr',
	'w:suppressLineNumbers',
	'w:pBdr',
	'w:shd',
	'w:tabs',
	'w:suppressAutoHyphens',
	'w:kinsoku',
	'w:wordWrap',
	'w:overflowPunct',
	'w:topLinePunct',
	'w:autoSpaceDE',
	'w:autoSpaceDN',
	'w:bidi',
	'w:adjustRightInd',
	'w:snapToGrid',
	'w:spacing',
	'w:ind',
	'w:contextualSpacing',
	'w:mirrorIndents',
	'w:suppressOverlap',
	'w:jc',
	'w:textDirection',
	'w:textAlignment',
	'w:textboxTightWrap',
	'w:outlineLvl',
	'w:divId',
	'w:cnfStyle',
	'w:rPr',
	'w:sectPr',
	'w:pPrChange'
];

interface StyleInfo {
	id: string;
	name: string;
	type: string;
	basedOn?: string;
	numId?: string;
	ilvl?: number;
	outline?: number;
}

/** What a regenerated block needs from the element it came from. */
type Source =
	| {
			kind: 'paragraph';
			item: SourceItem;
			model: Paragraph;
			startTag: string;
			pPr: string;
			anchors: string;
			/** Run properties by the key of the marks they give. */
			runProps: Map<string, string>;
			numId?: string;
			numKind?: NumKind;
			/** A check item whose box is in its text rather than its numbering. */
			checkByText?: boolean;
	  }
	| { kind: 'image'; item: SourceItem; run: string; key: string }
	| {
			kind: 'table';
			item: SourceItem;
			model: Table;
			head: string;
			columns: number;
			gridWidth: number;
	  }
	| { kind: 'row'; item: SourceItem; model: Row; head: string }
	| { kind: 'cell'; item: SourceItem; model: Cell; head: string }
	| { kind: 'locked'; item: SourceItem };

interface Parsed {
	zip: ZipArchive;
	docPath: string;
	xml: string;
	body: XElement;
	rels: Rels;
	styles: Map<string, StyleInfo>;
	stylesPath: string | null;
	stylesXml: string | null;
	numbering: Map<string, { abstract: string; formats: Map<number, NumKind> }>;
	numberingPath: string | null;
	numberingXml: string | null;
	sources: Map<number, Source>;
	items: SourceItem[];
	model: DocModel;
	tally: Tally;
}

const on = (el: XElement | undefined) =>
	el !== undefined && !['0', 'false', 'off'].includes(el.attrs['w:val'] ?? 'true');

const attr = (el: XElement | undefined, name: string) => el?.attrs[name];

export async function readDocx(
	bytes: Uint8Array,
	limits: ZipLimits = ZIP_LIMITS
): Promise<{ model: DocModel; census: Census }> {
	const p = await parse(bytes, limits);
	return { model: p.model, census: p.tally.census() };
}

async function parse(bytes: Uint8Array, limits: ZipLimits): Promise<Parsed> {
	const zip = readZip(bytes, limits);
	const rootRels = new Rels('_rels/.rels', await partText(zip, '_rels/.rels'));
	const main = rootRels.byType(REL.officeDocument);
	const docPath = main ? resolveTarget('', main.target) : 'word/document.xml';
	const xml = await partText(zip, docPath);
	if (xml === null) throw new DocxError('no main document part');
	const root = parseXml(xml);
	const body = child(root, 'w:body');
	if (root.name !== 'w:document' || body === undefined) throw new DocxError('not a Word document');
	const rels = new Rels(relsPathOf(docPath), await partText(zip, relsPathOf(docPath)));

	const stylesRel = rels.byType(REL.styles);
	const stylesPath = stylesRel ? resolveTarget(docPath, stylesRel.target) : null;
	const stylesXml = stylesPath ? await partText(zip, stylesPath) : null;
	const numberingRel = rels.byType(REL.numbering);
	const numberingPath = numberingRel ? resolveTarget(docPath, numberingRel.target) : null;
	const numberingXml = numberingPath ? await partText(zip, numberingPath) : null;

	const p: Parsed = {
		zip,
		docPath,
		xml,
		body,
		rels,
		styles: readStyles(stylesXml),
		stylesPath,
		stylesXml,
		numbering: readNumbering(numberingXml),
		numberingPath,
		numberingXml,
		sources: new Map(),
		items: [],
		model: { blocks: [], images: {} },
		tally: new Tally()
	};
	const reader = new BodyReader(p);
	for (const el of kids(body)) {
		if (BODY_GAPS.has(el.name)) continue;
		const block = await reader.block(el);
		p.items.push(p.sources.get(block.ref as number)!.item);
		p.model.blocks.push(block);
	}
	await censusOfPackage(p);
	return p;
}

function readStyles(xml: string | null): Map<string, StyleInfo> {
	const out = new Map<string, StyleInfo>();
	if (xml === null) return out;
	for (const s of kids(parseXml(xml), 'w:style')) {
		const pPr = child(s, 'w:pPr');
		const numPr = pPr && child(pPr, 'w:numPr');
		const outline = attr(pPr && child(pPr, 'w:outlineLvl'), 'w:val');
		out.set(s.attrs['w:styleId'] ?? '', {
			id: s.attrs['w:styleId'] ?? '',
			type: s.attrs['w:type'] ?? 'paragraph',
			name: (attr(child(s, 'w:name'), 'w:val') ?? '').toLowerCase(),
			basedOn: attr(child(s, 'w:basedOn'), 'w:val'),
			numId: attr(numPr && child(numPr, 'w:numId'), 'w:val'),
			ilvl: Number(attr(numPr && child(numPr, 'w:ilvl'), 'w:val') ?? 0),
			outline: outline === undefined ? undefined : Number(outline)
		});
	}
	return out;
}

function readNumbering(xml: string | null) {
	const out = new Map<string, { abstract: string; formats: Map<number, NumKind> }>();
	if (xml === null) return out;
	const root = parseXml(xml);
	const abstracts = new Map<string, Map<number, NumKind>>();
	for (const a of kids(root, 'w:abstractNum')) {
		const formats = new Map<number, NumKind>();
		for (const lvl of kids(a, 'w:lvl')) {
			const fmt = attr(child(lvl, 'w:numFmt'), 'w:val') ?? 'decimal';
			const text = (attr(child(lvl, 'w:lvlText'), 'w:val') ?? '').trim();
			let kind: NumKind = 'number';
			if (fmt === 'none') kind = 'none';
			else if (fmt === 'bullet') {
				kind = text === BOX_OFF ? 'box-off' : BOX_ON.includes(text) ? 'box-on' : 'bullet';
			}
			formats.set(Number(lvl.attrs['w:ilvl'] ?? 0), kind);
		}
		abstracts.set(a.attrs['w:abstractNumId'] ?? '', formats);
	}
	for (const n of kids(root, 'w:num')) {
		const abstract = attr(child(n, 'w:abstractNumId'), 'w:val') ?? '';
		out.set(n.attrs['w:numId'] ?? '', { abstract, formats: abstracts.get(abstract) ?? new Map() });
	}
	return out;
}

const STYLE_NAMES: Record<string, BlockStyle> = {
	title: 'title',
	'heading 1': 'h1',
	'heading 2': 'h2',
	'heading 3': 'h3',
	'heading 4': 'h4',
	'heading 5': 'h5',
	'heading 6': 'h6',
	quote: 'quote',
	'intense quote': 'quote',
	'block text': 'quote',
	'source code': 'code',
	'html preformatted': 'code',
	code: 'code'
};
const CODE_CHAR_NAMES = new Set(['verbatim char', 'html code', 'code char', 'inline code']);

class BodyReader {
	readonly #p: Parsed;
	#ref = 0;

	constructor(p: Parsed) {
		this.#p = p;
	}

	#next(): number {
		return this.#ref++;
	}

	#item(el: XElement, ref: number): SourceItem {
		return { ref, start: el.start, end: el.end };
	}

	async block(el: XElement): Promise<Block> {
		if (el.name === 'w:p') return this.paragraph(el);
		if (el.name === 'w:tbl') return this.table(el);
		return this.locked(el, LOCKING[el.name] ?? 'Unrecognised content');
	}

	locked(el: XElement, label: string): Locked {
		const ref = this.#next();
		this.#p.sources.set(ref, { kind: 'locked', item: this.#item(el, ref) });
		this.#p.tally.add(label, 'locked');
		return { type: 'locked', label, text: preview(el), ref };
	}

	/** Why a paragraph cannot be edited, if it cannot. */
	#lockReason(el: XElement): string | null {
		for (const d of descendants(el)) {
			const reason = LOCKING[d.name];
			if (reason) return reason;
			if (d.name === 'w:drawing') {
				const uri = find(d, 'a:graphicData')?.attrs.uri ?? '';
				if (uri !== PIC_URI) return drawingKind(uri);
			}
		}
		for (const c of kids(el)) {
			if (
				!['w:pPr', 'w:r', 'w:hyperlink'].includes(c.name) &&
				!ANCHORS.has(c.name) &&
				!IGNORED.has(c.name)
			) {
				return 'Unrecognised content';
			}
		}
		for (const h of kids(el, 'w:hyperlink')) {
			for (const c of kids(h)) {
				if (c.name !== 'w:r' && !IGNORED.has(c.name) && !ANCHORS.has(c.name))
					return 'Unrecognised content';
			}
		}
		return null;
	}

	async paragraph(el: XElement): Promise<Paragraph | Locked> {
		const reason = this.#lockReason(el);
		if (reason) return this.locked(el, reason);
		const ref = this.#next();
		const src = this.#p.xml;
		const pPr = child(el, 'w:pPr');
		const styleId = attr(pPr && child(pPr, 'w:pStyle'), 'w:val');
		const style = this.#styleOf(styleId, pPr);
		const jc = attr(pPr && child(pPr, 'w:jc'), 'w:val');
		const numPr = pPr && child(pPr, 'w:numPr');
		let numId = attr(numPr && child(numPr, 'w:numId'), 'w:val');
		let ilvl = Number(attr(numPr && child(numPr, 'w:ilvl'), 'w:val') ?? 0);
		if (numPr === undefined && styleId !== undefined) {
			const s = this.#styleChain(styleId).find((x) => x.numId !== undefined);
			if (s) {
				numId = s.numId;
				ilvl = s.ilvl ?? 0;
			}
		}
		const runProps = new Map<string, string>();
		const content: Inline[] = [];
		const anchors: string[] = [];
		for (const c of kids(el)) {
			if (ANCHORS.has(c.name)) anchors.push(src.slice(c.start, c.end));
			else if (c.name === 'w:r') content.push(...(await this.#run(c, undefined, runProps)));
			else if (c.name === 'w:hyperlink') {
				const link = this.#linkOf(c);
				for (const r of kids(c, 'w:r')) content.push(...(await this.#run(r, link, runProps)));
			}
		}
		const para: Paragraph = { type: 'paragraph', style, content: normalizeInlines(content), ref };
		const align = alignOf(jc);
		if (align) para.align = align;
		let numKind: NumKind | undefined;
		let checkByText = false;
		if (numId !== undefined && numId !== '0') {
			numKind = this.#p.numbering.get(numId)?.formats.get(ilvl) ?? 'bullet';
			const level = Math.min(Math.max(ilvl, 0), 8);
			if (numKind === 'box-off' || numKind === 'box-on') {
				para.list = { kind: 'check', level, checked: numKind === 'box-on' };
			} else if (numKind !== 'none') para.list = { kind: numKind, level };
		}
		if (para.list?.kind === 'bullet') checkByText = takeCheck(para);
		this.#p.sources.set(ref, {
			kind: 'paragraph',
			item: this.#item(el, ref),
			model: para,
			startTag: src.slice(el.start, el.innerStart).replace(/\/>$/, '>'),
			pPr: pPr ? src.slice(pPr.start, pPr.end) : '',
			anchors: anchors.join(''),
			runProps,
			numId,
			numKind,
			checkByText
		});
		return para;
	}

	#styleChain(id: string | undefined): StyleInfo[] {
		const out: StyleInfo[] = [];
		const seen = new Set<string>();
		while (id !== undefined && !seen.has(id) && out.length < 16) {
			seen.add(id);
			const s = this.#p.styles.get(id);
			if (s === undefined) break;
			out.push(s);
			id = s.basedOn;
		}
		return out;
	}

	#styleOf(id: string | undefined, pPr: XElement | undefined): BlockStyle {
		for (const s of this.#styleChain(id)) {
			const mapped = STYLE_NAMES[s.name];
			if (mapped) return mapped;
			if (s.outline !== undefined && s.outline < 6) return `h${s.outline + 1}` as BlockStyle;
		}
		if (id !== undefined && /^heading\s?[1-6]$/i.test(id)) {
			return `h${id.slice(-1)}` as BlockStyle;
		}
		if (id === 'Title') return 'title';
		const outline = attr(pPr && child(pPr, 'w:outlineLvl'), 'w:val');
		if (outline !== undefined && Number(outline) < 6)
			return `h${Number(outline) + 1}` as BlockStyle;
		return 'normal';
	}

	#linkOf(h: XElement): string | undefined {
		const id = h.attrs['r:id'];
		if (id !== undefined) return this.#p.rels.get(id)?.target;
		const anchor = h.attrs['w:anchor'];
		return anchor === undefined ? undefined : `#${anchor}`;
	}

	#marksOf(rPr: XElement | undefined, link: string | undefined): Marks {
		const m: Marks = {};
		if (link !== undefined) m.link = link;
		if (rPr === undefined) return m;
		const rStyle = attr(child(rPr, 'w:rStyle'), 'w:val');
		if (rStyle !== undefined) {
			const name = this.#p.styles.get(rStyle)?.name ?? rStyle.toLowerCase();
			if (CODE_CHAR_NAMES.has(name) || /verbatim|code/i.test(rStyle)) m.code = true;
		}
		if (on(child(rPr, 'w:b'))) m.bold = true;
		if (on(child(rPr, 'w:i'))) m.italic = true;
		const u = attr(child(rPr, 'w:u'), 'w:val');
		if (child(rPr, 'w:u') && u !== 'none') m.underline = true;
		if (on(child(rPr, 'w:strike')) || on(child(rPr, 'w:dstrike'))) m.strike = true;
		const fonts = child(rPr, 'w:rFonts');
		const font = fonts && (fonts.attrs['w:ascii'] ?? fonts.attrs['w:hAnsi']);
		if (font) m.font = font;
		const sz = Number(attr(child(rPr, 'w:sz'), 'w:val'));
		if (sz > 0 && sz < 3200) m.size = sz / 2;
		const color = hexColor(attr(child(rPr, 'w:color'), 'w:val'));
		if (color) m.color = color;
		const hl = attr(child(rPr, 'w:highlight'), 'w:val');
		if (hl !== undefined && HIGHLIGHTS[hl]) m.highlight = HIGHLIGHTS[hl];
		else {
			const fill = hexColor(attr(child(rPr, 'w:shd'), 'w:fill'));
			if (fill && fill !== '#ffffff') m.highlight = fill;
		}
		return cleanMarks(m);
	}

	async #run(
		r: XElement,
		link: string | undefined,
		runProps: Map<string, string>
	): Promise<Inline[]> {
		const rPr = child(r, 'w:rPr');
		const marks = this.#marksOf(rPr, link);
		const key = propsKey(marks);
		if (rPr && !runProps.has(key)) runProps.set(key, this.#p.xml.slice(rPr.start, rPr.end));
		const out: Inline[] = [];
		let buf = '';
		const flush = () => {
			if (buf !== '') out.push({ type: 'text', text: buf, marks });
			buf = '';
		};
		for (const c of r.children) {
			if (!isElement(c)) continue;
			switch (c.name) {
				case 'w:t':
					buf += c.children.map((t) => (isElement(t) ? '' : t.text)).join('');
					break;
				case 'w:tab':
					buf += '\t';
					break;
				case 'w:noBreakHyphen':
					buf += '‑';
					break;
				case 'w:softHyphen':
					buf += '­';
					break;
				case 'w:br':
				case 'w:cr':
					flush();
					out.push(
						c.attrs['w:type'] === 'page' ? { type: 'break', page: true } : { type: 'break' }
					);
					break;
				case 'w:drawing':
					flush();
					out.push(await this.#image(r, c, link));
					break;
				default:
					break;
			}
		}
		flush();
		return out;
	}

	async #image(run: XElement, drawing: XElement, link: string | undefined): Promise<Inline> {
		const ref = this.#next();
		const blip = find(drawing, 'a:blip');
		const docPr = find(drawing, 'wp:docPr');
		const extent = find(drawing, 'wp:extent');
		const embed = blip?.attrs['r:embed'];
		const rel = embed === undefined ? undefined : this.#p.rels.get(embed);
		let key = `remote:${ref}`;
		if (rel && !rel.external) {
			key = resolveTarget(this.#p.docPath, rel.target);
			await this.#load(key);
		} else this.#p.tally.add('Linked image, not loaded', 'kept');
		const image: Inline = {
			type: 'image',
			image: key,
			alt: docPr?.attrs.descr ?? docPr?.attrs.title ?? '',
			ref
		};
		const cx = Number(extent?.attrs.cx);
		const cy = Number(extent?.attrs.cy);
		if (cx > 0 && cy > 0) {
			image.width = Math.round(cx / 9525);
			image.height = Math.round(cy / 9525);
		}
		if (link !== undefined) image.link = link;
		this.#p.sources.set(ref, {
			kind: 'image',
			item: this.#item(run, ref),
			run: this.#p.xml.slice(run.start, run.end),
			key
		});
		return image;
	}

	async #load(key: string): Promise<void> {
		const images = this.#p.model.images;
		if (images[key] !== undefined) return;
		const entry = this.#p.zip.get(key);
		if (entry === undefined) return;
		const bytes = await entryData(entry);
		const mime = sniffImage(bytes);
		if (mime === 'application/octet-stream')
			this.#p.tally.add('Image in a format not shown here', 'kept');
		images[key] = { mime, bytes };
	}

	async table(el: XElement): Promise<Table | Locked> {
		const reason = tableLockReason(el);
		if (reason) return this.locked(el, reason);
		const cellReasons: string[] = [];
		for (const p of descendants(el)) {
			if (p.name === 'w:p') {
				const r = this.#lockReason(p);
				if (r) cellReasons.push(r);
			}
		}
		if (cellReasons.length > 0) return this.locked(el, cellReasons[0]);
		const src = this.#p.xml;
		const ref = this.#next();
		const rows: Row[] = [];
		const trs = kids(el, 'w:tr');
		let columns = 0;
		for (const tr of trs) {
			const rowRef = this.#next();
			const header = (() => {
				const trPr = child(tr, 'w:trPr');
				return trPr !== undefined && on(child(trPr, 'w:tblHeader'));
			})();
			const cells: Cell[] = [];
			const tcs = kids(tr, 'w:tc');
			for (const tc of tcs) {
				const cellRef = this.#next();
				const content: Paragraph[] = [];
				for (const p of kids(tc, 'w:p')) content.push((await this.paragraph(p)) as Paragraph);
				const cell: Cell = { content, ref: cellRef };
				if (header) cell.header = true;
				const firstP = kids(tc, 'w:p')[0];
				this.#p.sources.set(cellRef, {
					kind: 'cell',
					item: this.#item(tc, cellRef),
					model: cell,
					head: src.slice(tc.start, firstP?.start ?? tc.innerEnd)
				});
				cells.push(cell);
			}
			columns = Math.max(columns, cells.length);
			const row: Row = { cells, ref: rowRef };
			this.#p.sources.set(rowRef, {
				kind: 'row',
				item: this.#item(tr, rowRef),
				model: row,
				head: src.slice(tr.start, tcs[0]?.start ?? tr.innerEnd)
			});
			rows.push(row);
		}
		const table: Table = { type: 'table', rows, ref };
		const grid = child(el, 'w:tblGrid');
		const gridWidth = grid
			? kids(grid, 'w:gridCol').reduce((n, g) => n + (Number(g.attrs['w:w']) || 0), 0)
			: 0;
		this.#p.sources.set(ref, {
			kind: 'table',
			item: this.#item(el, ref),
			model: table,
			head: src.slice(el.start, trs[0]?.start ?? el.innerEnd),
			columns,
			gridWidth
		});
		return table;
	}
}

function drawingKind(uri: string): string {
	if (uri.includes('/chart')) return 'Chart';
	if (uri.includes('wordprocessingShape')) return 'Shape';
	if (uri.includes('wordprocessingGroup')) return 'Drawing';
	if (uri.includes('diagram')) return 'Diagram';
	return 'Drawing';
}

function tableLockReason(el: XElement): string | null {
	for (const d of descendants(el)) {
		if (d.name === 'w:tbl') return 'Nested table';
		if (d.name === 'w:vMerge' || d.name === 'w:hMerge') return 'Table with merged cells';
		if (d.name === 'w:gridSpan' && Number(d.attrs['w:val']) > 1) return 'Table with merged cells';
		if (d.name === 'w:gridBefore' || d.name === 'w:gridAfter') return 'Table with an uneven grid';
		if (/Change$|^w:cellIns$|^w:cellDel$|^w:ins$|^w:del$/.test(d.name)) return 'Tracked change';
	}
	for (const c of kids(el)) {
		if (!['w:tblPr', 'w:tblGrid', 'w:tr', 'w:bookmarkStart', 'w:bookmarkEnd'].includes(c.name)) {
			return 'Table with content controls';
		}
		if (c.name === 'w:tr') {
			for (const tc of kids(c)) {
				if (!['w:trPr', 'w:tblPrEx', 'w:tc'].includes(tc.name))
					return 'Table with content controls';
				if (tc.name === 'w:tc') {
					for (const x of kids(tc)) {
						if (x.name !== 'w:tcPr' && x.name !== 'w:p') return 'Table with content controls';
					}
					if (kids(tc, 'w:p').length === 0) return 'Unrecognised content';
				}
			}
		}
	}
	return null;
}

function alignOf(jc: string | undefined): Align | undefined {
	switch (jc) {
		case 'left':
		case 'start':
			return 'left';
		case 'center':
			return 'center';
		case 'right':
		case 'end':
			return 'right';
		case 'both':
		case 'distribute':
			return 'justify';
		default:
			return undefined;
	}
}

type NumKind = 'bullet' | 'number' | 'box-off' | 'box-on' | 'none';
const BOX_OFF = '☐';
const BOX_ON = ['☒', '☑'];
const CHECK_OFF = '☐ ';
const CHECK_ON = ['☒ ', '☑ '];

/** The numbering a list item needs. */
const numKindOf = (list: ListInfo): NumKind =>
	list.kind === 'check' ? (list.checked ? 'box-on' : 'box-off') : list.kind;

/** A bulleted item that starts with a ballot box is a check item. */
function takeCheck(p: Paragraph): boolean {
	const first = p.content[0];
	if (first?.type !== 'text') return false;
	let checked: boolean | null = null;
	if (first.text.startsWith(CHECK_OFF)) checked = false;
	else {
		const on = CHECK_ON.find((c) => first.text.startsWith(c));
		if (on) checked = true;
	}
	if (checked === null) return false;
	p.list = { kind: 'check', level: p.list?.level ?? 0, checked };
	const rest = first.text.slice(2);
	p.content = normalizeInlines([{ ...first, text: rest }, ...p.content.slice(1)]);
	return true;
}

/** The text of something locked, as well as it can be shown. */
function preview(el: XElement): string {
	let out = '';
	const walk = (e: XElement) => {
		for (const c of e.children) {
			if (!isElement(c)) continue;
			if (c.name === 'w:t' || c.name === 'm:t' || c.name === 'w:delText') {
				out += c.children.map((t) => (isElement(t) ? '' : t.text)).join('');
			} else if (c.name === 'w:tab') out += '\t';
			else if (c.name === 'w:br' || c.name === 'w:cr') out += '\n';
			else if (c.name === 'w:instrText' || c.name === 'w:delInstrText') continue;
			else {
				walk(c);
				if (c.name === 'w:p' || c.name === 'w:tr') out += '\n';
				else if (c.name === 'w:tc') out += '\t';
			}
		}
	};
	walk(el);
	return out.replace(/\n{3,}/g, '\n\n').trim();
}

const propsKey = (marks: Marks) => {
	const { link, ...rest } = cleanMarks(marks);
	return marksKey(rest) + (link === undefined ? '' : '|link');
};

async function censusOfPackage(p: Parsed): Promise<void> {
	let headers = 0;
	for (const e of p.zip.entries) {
		const n = e.name;
		if (/vbaProject\.bin$/i.test(n)) p.tally.add('Macros', 'kept');
		else if (/^word\/comments\.xml$/.test(n)) p.tally.add('Comments', 'kept');
		else if (/^word\/(header|footer)\d*\.xml$/.test(n)) headers++;
		else if (/^word\/charts\/chart\d*\.xml$/.test(n)) p.tally.add('Chart data', 'kept');
		else if (/^word\/embeddings\//.test(n)) p.tally.add('Embedded file', 'kept');
		else if (/^word\/glossary\//.test(n) && n.endsWith('document.xml'))
			p.tally.add('Building blocks', 'kept');
	}
	if (headers > 0) p.tally.add('Headers and footers', 'kept', headers);
	for (const [name, label] of [
		['word/footnotes.xml', 'Footnotes'],
		['word/endnotes.xml', 'Endnotes']
	] as const) {
		const text = await partText(p.zip, name);
		if (text === null) continue;
		const count = kids(parseXml(text)).filter(
			(n) => n.attrs['w:type'] === undefined || n.attrs['w:type'] === 'normal'
		).length;
		if (count > 0) p.tally.add(label, 'kept', count);
	}
	const settings = await partText(p.zip, 'word/settings.xml');
	if (settings !== null && /<w:trackRevisions(?:\s[^>]*)?\/?>/.test(settings)) {
		p.tally.add('Track changes is on in this file, but edits made here are not tracked', 'changed');
	}
}

// Writing.

const STYLE_DEFS: Record<string, { id: string; name: string; xml: string }> = {
	title: {
		id: 'Title',
		name: 'title',
		xml: '<w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="56"/></w:rPr>'
	},
	quote: {
		id: 'Quote',
		name: 'quote',
		xml: '<w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/></w:rPr>'
	},
	code: {
		id: 'SourceCode',
		name: 'source code',
		xml: '<w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr>'
	}
};
for (let i = 1; i <= 6; i++) {
	STYLE_DEFS[`h${i}`] = {
		id: `Heading${i}`,
		name: `heading ${i}`,
		xml: `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${i - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[40, 32, 28, 26, 24, 22][i - 1]}"/></w:rPr>`
	};
}
const CHAR_DEFS: Record<string, { id: string; name: string; xml: string }> = {
	code: {
		id: 'VerbatimChar',
		name: 'verbatim char',
		xml: '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr>'
	},
	link: {
		id: 'Hyperlink',
		name: 'hyperlink',
		xml: '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>'
	}
};

/** The parts that change on a save, and the numbering and styles added to them. */
class Writer {
	readonly p: Parsed;
	readonly model: DocModel;
	readonly contentTypes: ContentTypes;
	readonly media: { name: string; data: Uint8Array }[] = [];
	readonly used = new Set<number>();
	readonly #styleAdds: string[] = [];
	readonly #styleIds = new Map<string, string>();
	readonly #absAdds: string[] = [];
	readonly #numAdds: string[] = [];
	readonly #imagesByKey = new Map<string, string>();
	#nextAbs = 0;
	#nextNum = 0;
	#abstractFor = new Map<string, string>();
	#docPr = 7000;
	/** The list being written: kind and numId, while consecutive items continue it. */
	#run = new Map<NumKind, string>();

	constructor(p: Parsed, model: DocModel, contentTypes: ContentTypes) {
		this.p = p;
		this.model = model;
		this.contentTypes = contentTypes;
		const ids = (re: RegExp) =>
			[...(p.numberingXml ?? '').matchAll(re)].map((m) => Number(m[1])).filter(Number.isFinite);
		this.#nextAbs = Math.max(0, ...ids(/w:abstractNumId="(\d+)"/g)) + 1;
		this.#nextNum = Math.max(0, ...ids(/w:numId="(\d+)"/g)) + 1;
	}

	styleId(kind: string, char = false): string | undefined {
		const defs = char ? CHAR_DEFS : STYLE_DEFS;
		const def = defs[kind];
		if (def === undefined) return undefined;
		const cacheKey = `${char ? 'c' : 'p'}:${kind}`;
		const cached = this.#styleIds.get(cacheKey);
		if (cached) return cached;
		const type = char ? 'character' : 'paragraph';
		const names = char
			? kind === 'code'
				? CODE_CHAR_NAMES
				: new Set([def.name])
			: new Set(
					Object.entries(STYLE_NAMES)
						.filter(([, v]) => v === kind)
						.map(([k]) => k)
				);
		for (const s of this.p.styles.values()) {
			if (s.type === type && names.has(s.name)) {
				this.#styleIds.set(cacheKey, s.id);
				return s.id;
			}
		}
		if (this.p.stylesXml === null) return undefined;
		let id = def.id;
		while (this.p.styles.has(id)) id = `Yd${id}`;
		this.p.styles.set(id, { id, name: def.name, type });
		this.#styleAdds.push(
			`<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${def.name}"/><w:qFormat/>${def.xml}</w:style>`
		);
		this.#styleIds.set(cacheKey, id);
		return id;
	}

	/** The numbering of a list item: the item's own, the list it continues, or a new one. */
	numId(kind: NumKind, own: { numId?: string; numKind?: NumKind } | undefined): string {
		if (own?.numId !== undefined && own.numKind === kind) {
			this.#run.set(kind, own.numId);
			return own.numId;
		}
		const going = this.#run.get(kind);
		if (going !== undefined) return going;
		let abs = this.#abstractFor.get(kind);
		if (abs === undefined) {
			abs = String(this.#nextAbs++);
			this.#abstractFor.set(kind, abs);
			this.#absAdds.push(abstractNum(abs, kind));
		}
		const numId = String(this.#nextNum++);
		this.#numAdds.push(
			kind === 'number'
				? `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abs}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`
				: `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abs}"/></w:num>`
		);
		this.#run.set(kind, numId);
		return numId;
	}

	/** Called for every block written, so that a list ends where its items end. */
	notList(): void {
		this.#run.clear();
	}

	imageRel(key: string): string | null {
		const known = this.#imagesByKey.get(key);
		if (known) return known;
		const data: ImageData | undefined = this.model.images[key];
		let target: string;
		if (this.p.zip.get(key) !== undefined) {
			target = relativeTo(this.p.docPath, key);
		} else {
			if (data === undefined) return null;
			const ext = extensionOfImage(data.mime);
			if (IMAGE_TYPES[ext] === undefined) return null;
			const name = `${dirOf(this.p.docPath)}media/yd-image-${this.media.length + 1}.${ext}`;
			this.media.push({ name, data: data.bytes });
			this.contentTypes.ensureDefault(ext, IMAGE_TYPES[ext]);
			target = relativeTo(this.p.docPath, name);
		}
		const id = this.p.rels.ensure(REL.image, target);
		this.#imagesByKey.set(key, id);
		return id;
	}

	docPrId(): number {
		return this.#docPr++;
	}

	stylesText(): string | null {
		if (this.#styleAdds.length === 0 || this.p.stylesXml === null) return null;
		return spliceBeforeClose(this.p.stylesXml, 'styles', this.#styleAdds.join(''));
	}

	numberingText(): string | null {
		if (this.#absAdds.length === 0 && this.#numAdds.length === 0) return null;
		const abs = this.#absAdds.join('');
		const nums = this.#numAdds.join('');
		const src = this.p.numberingXml;
		if (src === null) {
			return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${W}">${abs}${nums}</w:numbering>`;
		}
		// Abstract definitions come before the first <w:num>, instances after the last.
		const firstNum = /<w:num\s/.exec(src);
		let out = firstNum ? src.slice(0, firstNum.index) + abs + src.slice(firstNum.index) : null;
		if (out === null) return spliceBeforeClose(src, 'numbering', abs + nums);
		const lastNum = [...out.matchAll(/<\/w:num>|<w:num\s[^>]*\/>/g)].at(-1);
		if (lastNum === undefined) return spliceBeforeClose(out, 'numbering', nums);
		const at = (lastNum.index ?? 0) + lastNum[0].length;
		out = out.slice(0, at) + nums + out.slice(at);
		return out;
	}
}

function abstractNum(id: string, kind: string): string {
	let lvls = '';
	for (let i = 0; i < 9; i++) {
		const fmt = kind === 'number' ? ['decimal', 'lowerLetter', 'lowerRoman'][i % 3] : 'bullet';
		const text =
			kind === 'number'
				? `%${i + 1}.`
				: kind === 'box-off'
					? BOX_OFF
					: kind === 'box-on'
						? BOX_ON[0]
						: ['•', '◦', '▪'][i % 3];
		lvls += `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
	}
	return `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${lvls}</w:abstractNum>`;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

function relativeTo(fromPart: string, target: string): string {
	const dir = dirOf(fromPart);
	return target.startsWith(dir) ? target.slice(dir.length) : `/${target}`;
}

/** Child elements of a properties element, with their source, so some can be replaced. */
function propChildren(raw: string): { name: string; xml: string }[] {
	if (raw === '') return [];
	const el = parseXml(raw);
	return kids(el).map((k) => ({ name: k.name, xml: raw.slice(k.start, k.end) }));
}

function buildPPr(raw: string, replace: Map<string, string | null>): string {
	const items = propChildren(raw);
	const rank = (name: string) => PPR_ORDER.indexOf(name);
	const ranked: { name: string; xml: string; rank: number }[] = [];
	let prev = -1;
	for (const it of items) {
		if (replace.has(it.name)) continue;
		const r = rank(it.name);
		prev = r >= 0 ? r : prev + 0.01;
		ranked.push({ ...it, rank: prev });
	}
	for (const [name, xml] of replace) if (xml !== null) ranked.push({ name, xml, rank: rank(name) });
	ranked.sort((a, b) => a.rank - b.rank);
	if (ranked.length === 0) return '';
	const open = raw === '' ? '<w:pPr>' : raw.slice(0, raw.indexOf('>') + 1).replace(/\/>$/, '>');
	return `${open}${ranked.map((r) => r.xml).join('')}</w:pPr>`;
}

const JC: Record<Align, string> = {
	left: 'left',
	center: 'center',
	right: 'right',
	justify: 'both'
};

function genRPr(marks: Marks, w: Writer): string {
	let out = '';
	const rStyle = marks.code
		? w.styleId('code', true)
		: marks.link !== undefined
			? w.styleId('link', true)
			: undefined;
	if (rStyle) out += `<w:rStyle w:val="${escapeAttr(rStyle)}"/>`;
	if (marks.font) {
		const f = escapeAttr(marks.font);
		out += `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/>`;
	}
	if (marks.bold) out += '<w:b/><w:bCs/>';
	if (marks.italic) out += '<w:i/><w:iCs/>';
	if (marks.strike) out += '<w:strike/>';
	if (marks.color) out += `<w:color w:val="${marks.color.slice(1).toUpperCase()}"/>`;
	if (marks.size) {
		const hp = Math.round(marks.size * 2);
		out += `<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`;
	}
	let shd = '';
	if (marks.highlight) {
		const named = Object.entries(HIGHLIGHTS).find(([, hex]) => hex === marks.highlight);
		if (named) out += `<w:highlight w:val="${named[0]}"/>`;
		else
			shd = `<w:shd w:val="clear" w:color="auto" w:fill="${marks.highlight.slice(1).toUpperCase()}"/>`;
	}
	if (marks.underline) out += '<w:u w:val="single"/>';
	out += shd;
	return out === '' ? '' : `<w:rPr>${out}</w:rPr>`;
}

function genText(text: string): string {
	let out = '';
	for (const piece of text.split(/(\t)/)) {
		if (piece === '\t') out += '<w:tab/>';
		else if (piece !== '')
			out += `<w:t xml:space="preserve">${escapeXml(stripInvalid(piece))}</w:t>`;
	}
	return out;
}

/** Characters XML 1.0 cannot carry. */
const stripInvalid = (s: string) =>
	// eslint-disable-next-line no-control-regex
	s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

function genImage(img: Extract<Inline, { type: 'image' }>, w: Writer): string {
	const src = img.ref === undefined ? undefined : w.p.sources.get(img.ref);
	if (src?.kind === 'image' && src.key === img.image && !w.used.has(img.ref as number)) {
		w.used.add(img.ref as number);
		return src.run;
	}
	const rId = w.imageRel(img.image);
	if (rId === null) return '';
	const data = w.model.images[img.image];
	const natural = data ? imageSize(data.bytes) : null;
	let width = img.width ?? natural?.width ?? 400;
	let height = img.height ?? natural?.height ?? 300;
	if (width > 624) {
		height = Math.round((height * 624) / width);
		width = 624;
	}
	const cx = Math.round(width * 9525);
	const cy = Math.round(height * 9525);
	const id = w.docPrId();
	const alt = escapeAttr(img.alt);
	return `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="${PIC_URI}"><pic:pic xmlns:pic="${PIC_URI}"><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

/** Width and height in pixels from a PNG, GIF or JPEG header. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	try {
		if (b[0] === 0x89 && b[1] === 0x50) return { width: v.getUint32(16), height: v.getUint32(20) };
		if (b[0] === 0x47 && b[1] === 0x49) {
			return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
		}
		if (b[0] === 0xff && b[1] === 0xd8) {
			let i = 2;
			while (i + 9 < b.length) {
				if (b[i] !== 0xff) return null;
				const marker = b[i + 1];
				const len = v.getUint16(i + 2);
				if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
					return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) };
				}
				i += 2 + len;
			}
		}
	} catch {
		return null;
	}
	return null;
}

function genRuns(content: readonly Inline[], w: Writer, runProps?: Map<string, string>): string {
	let out = '';
	let i = 0;
	while (i < content.length) {
		const it = content[i];
		const link = it.type === 'text' ? it.marks.link : it.type === 'image' ? it.link : undefined;
		if (link !== undefined) {
			let j = i;
			let inner = '';
			while (j < content.length) {
				const c = content[j];
				const l = c.type === 'text' ? c.marks.link : c.type === 'image' ? c.link : undefined;
				if (l !== link) break;
				inner += genInline(c, w, runProps);
				j++;
			}
			const target = link.startsWith('#')
				? `w:anchor="${escapeAttr(link.slice(1))}"`
				: `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${w.p.rels.ensure(REL.hyperlink, link, true)}"`;
			out += `<w:hyperlink ${target} w:history="1">${inner}</w:hyperlink>`;
			i = j;
		} else {
			out += genInline(it, w, runProps);
			i++;
		}
	}
	return out;
}

function genInline(it: Inline, w: Writer, runProps?: Map<string, string>): string {
	if (it.type === 'break')
		return it.page ? '<w:r><w:br w:type="page"/></w:r>' : '<w:r><w:br/></w:r>';
	if (it.type === 'image') return genImage(it, w);
	const rPr = runProps?.get(propsKey(it.marks)) ?? genRPr(it.marks, w);
	return `<w:r>${rPr}${genText(it.text)}</w:r>`;
}

function genParagraph(p: Paragraph, w: Writer, ref?: number): string {
	let src = ref === undefined ? undefined : w.p.sources.get(ref);
	if (src?.kind !== 'paragraph' || w.used.has(ref as number)) src = undefined;
	else w.used.add(ref as number);
	const orig = src?.kind === 'paragraph' ? src : undefined;
	const replace = new Map<string, string | null>();
	if (orig === undefined || orig.model.style !== p.style) {
		const id = p.style === 'normal' ? undefined : w.styleId(p.style);
		replace.set('w:pStyle', id === undefined ? null : `<w:pStyle w:val="${escapeAttr(id)}"/>`);
	}
	if (orig === undefined || orig.model.align !== p.align) {
		replace.set('w:jc', p.align ? `<w:jc w:val="${JC[p.align]}"/>` : null);
	}
	const byText = orig?.checkByText === true && p.list?.kind === 'check';
	const want = p.list === undefined ? undefined : byText ? 'bullet' : numKindOf(p.list);
	const listSame =
		orig !== undefined &&
		orig.model.list?.level === p.list?.level &&
		(orig.model.list === undefined) === (p.list === undefined) &&
		(want === undefined || orig.numKind === want);
	if (p.list && want) {
		const numId = w.numId(want, orig);
		if (!listSame) {
			replace.set(
				'w:numPr',
				`<w:numPr><w:ilvl w:val="${p.list.level}"/><w:numId w:val="${numId}"/></w:numPr>`
			);
		}
	} else {
		w.notList();
		if (!listSame && orig?.model.list !== undefined) {
			// The item's own list or its style's: an explicit 0 takes it out of either.
			replace.set('w:numPr', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>');
		}
	}
	const pPr = buildPPr(orig?.pPr ?? '', replace);
	let content = p.content;
	if (p.list?.kind === 'check' && byText) {
		const box = p.list.checked ? CHECK_ON[0] : CHECK_OFF;
		content = normalizeInlines([
			{ type: 'text', text: box, marks: p.content[0]?.type === 'text' ? p.content[0].marks : {} },
			...p.content
		]);
	}
	return `${orig?.startTag ?? '<w:p>'}${pPr}${orig?.anchors ?? ''}${genRuns(content, w, orig?.runProps)}</w:p>`;
}

function genCellParagraphs(content: readonly Paragraph[], w: Writer): string {
	const paras =
		content.length === 0
			? [{ type: 'paragraph', style: 'normal', content: [] } as Paragraph]
			: content;
	let out = '';
	for (const p of paras) out += writeBlock(p, w);
	return out;
}

function genTable(t: Table, w: Writer, orig?: Extract<Source, { kind: 'table' }>): string {
	const columns = Math.max(1, ...t.rows.map((r) => r.cells.length));
	let head: string;
	if (orig) {
		head = orig.head;
		if (orig.columns !== columns) {
			const width = Math.floor((orig.gridWidth || 9360) / columns);
			head = head.replace(
				/<w:tblGrid\b[\s\S]*?(<\/w:tblGrid>|\/>)/,
				`<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(columns)}</w:tblGrid>`
			);
		}
	} else {
		const width = Math.floor(9360 / columns);
		const border = (side: string) =>
			`<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
		head = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(columns)}</w:tblGrid>`;
	}
	let rows = '';
	for (const row of t.rows) {
		const rs = row.ref === undefined ? undefined : w.p.sources.get(row.ref);
		const rowSrc = rs?.kind === 'row' && !w.used.has(row.ref as number) ? rs : undefined;
		if (rowSrc) {
			w.used.add(row.ref as number);
			if (sameRow(row, rowSrc.model)) {
				rows += w.p.xml.slice(rowSrc.item.start, rowSrc.item.end);
				markUsed(row, w);
				continue;
			}
		}
		let cells = '';
		for (const cell of row.cells) {
			const cs = cell.ref === undefined ? undefined : w.p.sources.get(cell.ref);
			const cellSrc = cs?.kind === 'cell' && !w.used.has(cell.ref as number) ? cs : undefined;
			if (cellSrc) w.used.add(cell.ref as number);
			const cellHead =
				cellSrc?.head ??
				`<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9360 / columns)}" w:type="dxa"/></w:tcPr>`;
			w.notList();
			cells += `${cellHead}${genCellParagraphs(cell.content, w)}</w:tc>`;
		}
		const rowHead =
			rowSrc?.head ??
			(row.cells.some((c) => c.header) ? '<w:tr><w:trPr><w:tblHeader/></w:trPr>' : '<w:tr>');
		rows += `${rowHead}${cells}</w:tr>`;
	}
	w.notList();
	return `${head}${rows}</w:tbl>`;
}

const sameRow = (a: Row, b: Row) => JSON.stringify(stripRefs(a)) === JSON.stringify(stripRefs(b));
const stripRefs = (v: unknown) =>
	JSON.parse(JSON.stringify(v, (k, x) => (k === 'ref' ? undefined : x)));

function markUsed(row: Row, w: Writer): void {
	for (const c of row.cells) {
		if (c.ref !== undefined) w.used.add(c.ref);
		for (const p of c.content) if (p.ref !== undefined) w.used.add(p.ref);
	}
}

/** One block as XML: copied if it is unchanged and its own, generated otherwise. */
function writeBlock(b: Block | Paragraph, w: Writer): string {
	const src = b.ref === undefined ? undefined : w.p.sources.get(b.ref);
	if (b.type === 'locked') {
		w.notList();
		return src ? w.p.xml.slice(src.item.start, src.item.end) : '';
	}
	if (src && !w.used.has(b.ref as number) && 'model' in src && sameBlock(b, src.model as Block)) {
		if (b.type === 'paragraph') {
			const orig = src as Extract<Source, { kind: 'paragraph' }>;
			if (b.list) w.numId(orig.checkByText ? 'bullet' : numKindOf(b.list), orig);
			else w.notList();
		} else w.notList();
		w.used.add(b.ref as number);
		if (b.type === 'table')
			for (const r of b.rows) {
				if (r.ref !== undefined) w.used.add(r.ref);
				markUsed(r, w);
			}
		return w.p.xml.slice(src.item.start, src.item.end);
	}
	if (b.type === 'paragraph') return genParagraph(b, w, b.ref);
	const orig = src?.kind === 'table' && !w.used.has(b.ref as number) ? src : undefined;
	if (orig) w.used.add(b.ref as number);
	return genTable(b, w, orig);
}

/**
 * Writes a model as `.docx`. With the original, everything it can keep is kept;
 * without, it starts from a minimal document.
 */
export async function writeDocx(
	model: DocModel,
	original?: Uint8Array,
	limits: ZipLimits = ZIP_LIMITS
): Promise<Uint8Array> {
	const p = await parse(original ?? (await docxTemplate()), limits);
	const ctPath = '[Content_Types].xml';
	const ct = new ContentTypes((await partText(p.zip, ctPath)) ?? '');
	const w = new Writer(p, model, ct);
	const body = p.body;
	const atoms = plan(
		p.xml,
		{ start: body.innerStart, end: body.innerEnd },
		p.items,
		model.blocks,
		(b) => b.ref
	);
	let inner = '';
	for (const a of atoms) {
		if (a.kind === 'gap') inner += a.text;
		else inner += writeBlock(a.block, w);
	}
	const xml = p.xml.slice(0, body.innerStart) + inner + p.xml.slice(body.innerEnd);
	const enc = new TextEncoder();
	const changes: { name: string; data: Uint8Array }[] = [];
	if (xml !== p.xml) changes.push({ name: p.docPath, data: enc.encode(xml) });
	const styles = w.stylesText();
	if (styles !== null && p.stylesPath !== null)
		changes.push({ name: p.stylesPath, data: enc.encode(styles) });
	const numbering = w.numberingText();
	if (numbering !== null) {
		const path = p.numberingPath ?? `${dirOf(p.docPath)}numbering.xml`;
		if (p.numberingPath === null) {
			p.rels.ensure(REL.numbering, relativeTo(p.docPath, path));
			ct.ensureOverride(
				path,
				'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'
			);
		}
		changes.push({ name: path, data: enc.encode(numbering) });
	}
	changes.push(...w.media);
	if (p.rels.changed) changes.push({ name: p.rels.path, data: enc.encode(p.rels.text()) });
	if (ct.changed) changes.push({ name: ctPath, data: enc.encode(ct.text()) });
	return writeZip(p.zip, changes);
}

let template: Promise<Uint8Array> | null = null;

/** A minimal valid document with the styles the editor writes. */
export function docxTemplate(): Promise<Uint8Array> {
	template ??= (async () => {
		const enc = new TextEncoder();
		const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
		const styleXml = (type: string, d: { id: string; name: string; xml: string }) =>
			`<w:style w:type="${type}" w:styleId="${d.id}"><w:name w:val="${d.name}"/><w:qFormat/>${d.xml}</w:style>`;
		const styles =
			`${head}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
			`<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
			Object.values(STYLE_DEFS)
				.map((d) => styleXml('paragraph', d))
				.join('') +
			Object.values(CHAR_DEFS)
				.map((d) => styleXml('character', d))
				.join('') +
			'</w:styles>';
		const parts = [
			{
				name: '[Content_Types].xml',
				data: `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`
			},
			{
				name: '_rels/.rels',
				data: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL.officeDocument}" Target="word/document.xml"/></Relationships>`
			},
			{
				name: 'word/document.xml',
				data: `${head}<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`
			},
			{
				name: 'word/_rels/document.xml.rels',
				data: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL.styles}" Target="styles.xml"/></Relationships>`
			},
			{ name: 'word/styles.xml', data: styles }
		];
		return writeZip(
			null,
			parts.map((x) => ({ name: x.name, data: enc.encode(x.data) }))
		);
	})();
	return template;
}
