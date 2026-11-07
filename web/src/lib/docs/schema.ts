/**
 * The editor's schema: exactly what the document model holds. Paragraphs are
 * flat, with their style, alignment and list position as attributes, the way
 * Word stores them, so each one maps to one block of the file. A locked block is
 * an atom: it can be seen and selected, never edited. Parse rules are what a
 * paste is reduced to; anything they do not name is dropped.
 */
import { Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';
import { safeHref, type BlockStyle, type ListInfo } from '$lib/formats/model';

const STYLE_TAGS: Record<BlockStyle, string> = {
	normal: 'p',
	title: 'p',
	h1: 'h1',
	h2: 'h2',
	h3: 'h3',
	h4: 'h4',
	h5: 'h5',
	h6: 'h6',
	quote: 'blockquote',
	code: 'pre'
};

export interface ParagraphAttrs {
	style: BlockStyle;
	align: string | null;
	list: ListInfo | null;
	ref: number | null;
}

function listOf(el: HTMLElement): ListInfo | null {
	const li = el.closest('li');
	if (li === null) return null;
	let level = -1;
	for (let n: HTMLElement | null = li; n; n = n.parentElement)
		if (n.tagName === 'UL' || n.tagName === 'OL') level++;
	const box = li.querySelector('input[type=checkbox]') as HTMLInputElement | null;
	if (box)
		return {
			kind: 'check',
			level: Math.max(0, Math.min(level, 8)),
			checked: box.checked || box.hasAttribute('checked')
		};
	const ordered = li.parentElement?.tagName === 'OL';
	return { kind: ordered ? 'number' : 'bullet', level: Math.max(0, Math.min(level, 8)) };
}

const ALIGNS = ['left', 'center', 'right', 'justify'];

const alignOf = (el: HTMLElement) => {
	const a = el.style.textAlign;
	return ALIGNS.includes(a) ? a : null;
};

/**
 * A font name, if it is one, by the readers' rule (`fontName` in formats/docx,
 * not imported so that the editor does not load a writer): anything that could
 * end the CSS string it is drawn in, such as a quote or a newline, is refused.
 */
const fontName = (v: string): string | undefined => {
	const name = v.trim().replace(/^['"]|['"]$/g, '');
	return /^[\p{L}\p{N} _\-.,']{1,64}$/u.test(name) ? name : undefined;
};

/** A colour as `#rrggbb`, the only form written into a style attribute. */
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

const paragraph: NodeSpec = {
	attrs: {
		style: { default: 'normal' },
		align: { default: null },
		list: { default: null },
		ref: { default: null }
	},
	content: 'inline*',
	group: 'block',
	defining: true,
	parseDOM: [
		...(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const).map((tag) => ({
			tag,
			getAttrs: (el: HTMLElement) => ({ style: tag, align: alignOf(el), list: listOf(el) })
		})),
		{ tag: 'pre', preserveWhitespace: 'full' as const, getAttrs: () => ({ style: 'code' }) },
		{
			tag: 'blockquote p',
			getAttrs: (el: HTMLElement) => ({ style: 'quote', align: alignOf(el) })
		},
		{
			tag: 'blockquote',
			priority: 40,
			getAttrs: (el: HTMLElement) => ({ style: 'quote', align: alignOf(el) })
		},
		{ tag: 'li', getAttrs: (el: HTMLElement) => ({ list: listOf(el), align: alignOf(el) }) },
		{
			tag: 'p',
			getAttrs: (el: HTMLElement) => ({
				style: el.classList.contains('doc-title') ? 'title' : 'normal',
				align: alignOf(el),
				list: listOf(el)
			})
		}
	],
	toDOM(node): DOMOutputSpec {
		const a = node.attrs as ParagraphAttrs;
		const attrs: Record<string, string> = {};
		const classes: string[] = [];
		if (a.style === 'title') classes.push('doc-title');
		if (a.list) {
			classes.push('li', `li-${a.list.kind}`);
			attrs['data-level'] = String(a.list.level);
			if (a.list.kind === 'check') attrs['data-checked'] = String(a.list.checked === true);
		}
		if (classes.length > 0) attrs.class = classes.join(' ');
		if (a.align && ALIGNS.includes(a.align)) attrs.style = `text-align: ${a.align}`;
		if (a.style === 'code') return ['pre', attrs, ['code', 0]];
		return [STYLE_TAGS[a.style] ?? 'p', attrs, 0];
	}
};

const image: NodeSpec = {
	inline: true,
	group: 'inline',
	atom: true,
	draggable: true,
	marks: 'link',
	attrs: {
		key: {},
		alt: { default: '' },
		width: { default: null },
		height: { default: null },
		ref: { default: null },
		/** A pasted picture as a data URL, until it has been redrawn and stored. */
		pending: { default: null }
	},
	parseDOM: [
		{
			tag: 'img[src]',
			getAttrs(el: HTMLElement) {
				const src = el.getAttribute('src') ?? '';
				// Only pictures that come with the paste: nothing is fetched from elsewhere.
				if (
					!/^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(src) ||
					src.length > 20 * 1024 * 1024
				)
					return false;
				const w = Number(el.getAttribute('width'));
				const h = Number(el.getAttribute('height'));
				return {
					key: '',
					alt: el.getAttribute('alt') ?? '',
					width: w > 0 ? w : null,
					height: h > 0 ? h : null,
					pending: src
				};
			}
		}
	],
	toDOM(node): DOMOutputSpec {
		// The editor draws pictures through its node view; this is for copies, which carry no address.
		return ['img', { alt: node.attrs.alt as string, 'data-key': node.attrs.key as string }];
	}
};

const locked: NodeSpec = {
	group: 'block',
	atom: true,
	selectable: true,
	draggable: false,
	attrs: { label: {}, text: { default: '' }, ref: {} },
	toDOM(node): DOMOutputSpec {
		return [
			'div',
			{ class: 'locked', contenteditable: 'false', 'data-label': node.attrs.label as string },
			['span', { class: 'locked-label' }, node.attrs.label as string],
			['div', { class: 'locked-text' }, node.attrs.text as string]
		];
	}
};

const hardBreak: NodeSpec = {
	inline: true,
	group: 'inline',
	selectable: false,
	attrs: { page: { default: false } },
	parseDOM: [{ tag: 'br' }],
	toDOM: (node) => (node.attrs.page ? ['br', { class: 'page-break' }] : ['br'])
};

const tables = tableNodes({
	tableGroup: 'block',
	cellContent: 'paragraph+',
	cellAttributes: {
		ref: { default: null, getFromDOM: () => null, setDOMAttr: () => {} }
	}
});
tables.table = {
	...tables.table,
	attrs: { ref: { default: null } },
	parseDOM: [{ tag: 'table' }],
	toDOM: () => ['table', ['tbody', 0]]
};
tables.table_row = {
	...tables.table_row,
	attrs: { ref: { default: null } },
	parseDOM: [{ tag: 'tr' }],
	toDOM: () => ['tr', 0]
};

const hex = (v: string): string | null => {
	const s = v.trim();
	if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
	if (/^#[0-9a-f]{3}$/i.test(s))
		return `#${[...s.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
	const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(s);
	if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null;
	return `#${[m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('')}`;
};

const marks: Record<string, MarkSpec> = {
	link: {
		attrs: { href: {} },
		inclusive: false,
		parseDOM: [
			{
				tag: 'a[href]',
				getAttrs(el: HTMLElement) {
					const href = el.getAttribute('href') ?? '';
					return safeHref(href) ? { href } : false;
				}
			}
		],
		toDOM(mark): DOMOutputSpec {
			const href = mark.attrs.href as string;
			// An address the editor would not open is shown, never linked.
			return safeHref(href)
				? ['a', { href, rel: 'noopener noreferrer nofollow', target: '_blank' }, 0]
				: [
						'a',
						{
							class: 'unsafe-link',
							title: 'Not opened: this link is not a web, mail or phone address'
						},
						0
					];
		}
	},
	bold: {
		parseDOM: [
			{ tag: 'strong' },
			{ tag: 'b', getAttrs: (el: HTMLElement) => el.style.fontWeight !== 'normal' && null },
			{
				style: 'font-weight',
				getAttrs: (v: string) => (/^(bold(er)?|[6-9]\d\d)$/.test(v) ? null : false)
			}
		],
		toDOM: () => ['strong', 0]
	},
	italic: {
		parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
		toDOM: () => ['em', 0]
	},
	underline: {
		parseDOM: [
			{ tag: 'u' },
			{
				style: 'text-decoration',
				getAttrs: (v: string) => (v.includes('underline') ? null : false)
			}
		],
		toDOM: () => ['u', 0]
	},
	strike: {
		parseDOM: [
			{ tag: 's' },
			{ tag: 'del' },
			{ tag: 'strike' },
			{
				style: 'text-decoration',
				getAttrs: (v: string) => (v.includes('line-through') ? null : false)
			}
		],
		toDOM: () => ['s', 0]
	},
	sup: {
		excludes: 'sup sub',
		parseDOM: [
			{ tag: 'sup' },
			{
				style: 'vertical-align',
				getAttrs: (v: string) => (v === 'super' ? null : false)
			}
		],
		toDOM: () => ['sup', 0]
	},
	sub: {
		excludes: 'sup sub',
		parseDOM: [
			{ tag: 'sub' },
			{
				style: 'vertical-align',
				getAttrs: (v: string) => (v === 'sub' ? null : false)
			}
		],
		toDOM: () => ['sub', 0]
	},
	code: {
		parseDOM: [{ tag: 'code' }],
		toDOM: () => ['code', 0]
	},
	font: {
		attrs: { family: {} },
		parseDOM: [
			{
				style: 'font-family',
				getAttrs(v: string) {
					const family = fontName(v.split(',')[0]);
					return family && !/inherit|initial/i.test(family) ? { family } : false;
				}
			}
		],
		toDOM(mark): DOMOutputSpec {
			// A name that is not one is drawn in the default font, never written into the CSS.
			const family = fontName(String(mark.attrs.family));
			return family ? ['span', { style: `font-family: "${family}"` }, 0] : ['span', 0];
		}
	},
	size: {
		attrs: { pt: {} },
		parseDOM: [
			{
				style: 'font-size',
				getAttrs(v: string) {
					const m = /^([\d.]+)(pt|px)$/.exec(v.trim());
					if (!m) return false;
					const pt = m[2] === 'px' ? Number(m[1]) * 0.75 : Number(m[1]);
					return pt >= 4 && pt <= 200 ? { pt: Math.round(pt * 2) / 2 } : false;
				}
			}
		],
		toDOM(mark): DOMOutputSpec {
			const pt = Number(mark.attrs.pt);
			return pt > 0 && pt <= 1600 ? ['span', { style: `font-size: ${pt}pt` }, 0] : ['span', 0];
		}
	},
	color: {
		attrs: { value: {} },
		parseDOM: [{ style: 'color', getAttrs: (v: string) => (hex(v) ? { value: hex(v) } : false) }],
		toDOM: (mark) =>
			isHex(mark.attrs.value) ? ['span', { style: `color: ${mark.attrs.value}` }, 0] : ['span', 0]
	},
	highlight: {
		attrs: { value: {} },
		parseDOM: [
			{ tag: 'mark', getAttrs: () => ({ value: '#ffff00' }) },
			{
				style: 'background-color',
				getAttrs: (v: string) => (hex(v) && hex(v) !== '#ffffff' ? { value: hex(v) } : false)
			}
		],
		toDOM: (mark) =>
			isHex(mark.attrs.value)
				? ['mark', { style: `background-color: ${mark.attrs.value}` }, 0]
				: ['mark', 0]
	}
};

export const schema = new Schema({
	nodes: {
		doc: { content: 'block+' },
		paragraph,
		locked,
		...tables,
		text: { group: 'inline' },
		image,
		hard_break: hardBreak
	},
	marks
});
