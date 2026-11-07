/**
 * The document model every reader produces and every writer takes. It is plain
 * data, so it crosses into and out of a worker, and it is never HTML: the editor
 * builds its own nodes from it. `ref` ties a block to where it came from in the
 * file, which is how a writer knows what it may copy back untouched.
 */

export type Align = 'left' | 'center' | 'right' | 'justify';

export type BlockStyle =
	'normal' | 'title' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'quote' | 'code';

export interface Marks {
	bold?: true;
	italic?: true;
	underline?: true;
	strike?: true;
	code?: true;
	/** A font family name. */
	font?: string;
	/** In points. */
	size?: number;
	/** `#rrggbb`. */
	color?: string;
	/** `#rrggbb`. */
	highlight?: string;
	/** The address as the file has it, safe or not: the editor decides what opens. */
	link?: string;
}

export type Inline =
	| { type: 'text'; text: string; marks: Marks }
	/** `image` names an entry of `DocModel.images`; `ref` the source it came from. */
	| {
			type: 'image';
			image: string;
			alt: string;
			width?: number;
			height?: number;
			link?: string;
			ref?: number;
	  }
	| { type: 'break'; page?: true };

export interface ListInfo {
	kind: 'bullet' | 'number' | 'check';
	/** From 0. */
	level: number;
	/** Only on a check item. */
	checked?: boolean;
}

export interface Paragraph {
	type: 'paragraph';
	style: BlockStyle;
	align?: Align;
	list?: ListInfo;
	content: Inline[];
	ref?: number;
}

export interface Cell {
	content: Paragraph[];
	colspan?: number;
	rowspan?: number;
	header?: true;
	ref?: number;
}

export interface Row {
	cells: Cell[];
	ref?: number;
}

export interface Table {
	type: 'table';
	rows: Row[];
	ref?: number;
}

/** Content the editor cannot represent: shown as text, kept as it was, never edited. */
export interface Locked {
	type: 'locked';
	/** What it is, for its label: "Tracked change", "Equation". */
	label: string;
	/** Its text, as well as it can be shown. */
	text: string;
	ref: number;
}

export type Block = Paragraph | Table | Locked;

export interface ImageData {
	mime: string;
	bytes: Uint8Array;
}

export interface DocModel {
	blocks: Block[];
	images: Record<string, ImageData>;
}

/** How something found in a file is treated. */
export type Handling =
	/** Shown, and saved back as it was, but not editable. */
	| 'locked'
	/** Not shown; saved back as it was. */
	| 'kept'
	/** Not shown, and not in what is saved. */
	| 'lost'
	/** Shown and editable, but saved differently from how it was. */
	| 'changed';

export interface CensusItem {
	label: string;
	count: number;
	handling: Handling;
}

/** What a file holds beyond what the editor edits, for the notice above it. */
export interface Census {
	items: CensusItem[];
}

export class Tally {
	readonly #items = new Map<string, CensusItem>();

	add(label: string, handling: Handling, count = 1): void {
		const key = `${handling}\u0000${label}`;
		const item = this.#items.get(key);
		if (item) item.count += count;
		else this.#items.set(key, { label, count, handling });
	}

	census(): Census {
		return { items: [...this.#items.values()] };
	}
}

const MARK_ORDER: (keyof Marks)[] = [
	'bold',
	'italic',
	'underline',
	'strike',
	'code',
	'font',
	'size',
	'color',
	'highlight',
	'link'
];

/** The same marks in a fixed order, without empty values. */
export function cleanMarks(marks: Marks): Marks {
	const out: Record<string, unknown> = {};
	for (const k of MARK_ORDER) {
		const v = marks[k];
		if (v === undefined || v === null || v === '' || (v as unknown) === false) continue;
		out[k] = v;
	}
	return out as Marks;
}

export const marksKey = (marks: Marks): string => JSON.stringify(cleanMarks(marks));

/** Merges neighbouring text with the same marks and drops empty text, as the editor does. */
export function normalizeInlines(content: readonly Inline[]): Inline[] {
	const out: Inline[] = [];
	for (const item of content) {
		if (item.type === 'text') {
			if (item.text === '') continue;
			const marks = cleanMarks(item.marks);
			const prev = out[out.length - 1];
			if (prev?.type === 'text' && marksKey(prev.marks) === marksKey(marks)) {
				out[out.length - 1] = { ...prev, text: prev.text + item.text };
			} else out.push({ type: 'text', text: item.text, marks });
		} else out.push(item);
	}
	return out;
}

export function paragraph(content: Inline[] = [], extra: Partial<Paragraph> = {}): Paragraph {
	return { type: 'paragraph', style: 'normal', content: normalizeInlines(content), ...extra };
}

export const text = (t: string, marks: Marks = {}): Inline => ({ type: 'text', text: t, marks });

/** A block as data to compare, with every `ref` left out. */
export function canonical(block: Block | Cell | Row | Inline): string {
	return JSON.stringify(block, (key, value) => {
		if (key === 'ref') return undefined;
		if (key === 'marks') return cleanMarks(value as Marks);
		return value as unknown;
	});
}

export const sameBlock = (a: Block, b: Block) => canonical(a) === canonical(b);

/** The text of a paragraph's content. */
export function inlineText(content: readonly Inline[]): string {
	let out = '';
	for (const i of content) {
		if (i.type === 'text') out += i.text;
		else if (i.type === 'break') out += '\n';
		else if (i.alt) out += i.alt;
	}
	return out;
}

/** Everything a person could read in a document, for search and word counts. */
export function plainText(model: Pick<DocModel, 'blocks'>): string {
	const lines: string[] = [];
	const walk = (blocks: readonly Block[]) => {
		for (const b of blocks) {
			if (b.type === 'paragraph') lines.push(inlineText(b.content));
			else if (b.type === 'locked') lines.push(b.text);
			else for (const r of b.rows) for (const c of r.cells) walk(c.content);
		}
	};
	walk(model.blocks);
	return lines.join('\n');
}

/** Whether an address is one the editor may open: web, mail, phone or a place in the document. */
export function safeHref(href: string): boolean {
	const h = href.trim();
	if (h.startsWith('#')) return true;
	return /^(https?:|mailto:|tel:)/i.test(h);
}

/** Image types the browser may draw. Anything else shows as a placeholder. */
export const DRAWABLE_IMAGES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/bmp'
]);

/** The type of image bytes, from their signature, never from a name. */
export function sniffImage(b: Uint8Array): string {
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
	if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
	if (
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57 &&
		b[9] === 0x45 &&
		b[10] === 0x42 &&
		b[11] === 0x50
	) {
		return 'image/webp';
	}
	return 'application/octet-stream';
}

export const extensionOfImage = (mime: string): string =>
	({
		'image/png': 'png',
		'image/jpeg': 'jpeg',
		'image/gif': 'gif',
		'image/bmp': 'bmp',
		'image/webp': 'webp'
	})[mime] ?? 'bin';

/** Named highlight colours of Word, as hex. */
export const HIGHLIGHTS: Record<string, string> = {
	yellow: '#ffff00',
	green: '#00ff00',
	cyan: '#00ffff',
	magenta: '#ff00ff',
	blue: '#0000ff',
	red: '#ff0000',
	darkBlue: '#000080',
	darkCyan: '#008080',
	darkGreen: '#008000',
	darkMagenta: '#800080',
	darkRed: '#800000',
	darkYellow: '#808000',
	darkGray: '#808080',
	lightGray: '#c0c0c0',
	black: '#000000',
	white: '#ffffff'
};

/** `#rrggbb` in lower case from what a file has, or undefined. */
export function hexColor(v: string | undefined): string | undefined {
	if (v === undefined) return undefined;
	const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
	return m ? `#${m[1].toLowerCase()}` : undefined;
}
