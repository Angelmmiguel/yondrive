// A small XML pull parser that works in workers. Every token carries its source
// offsets (UTF-16 code units of the decoded string), so the original text of an
// element can be recovered and an edit can splice into the source.

export type XmlToken =
	| {
			type: 'start';
			name: string;
			attrs: Record<string, string>;
			selfClosing: boolean;
			start: number;
			end: number;
	  }
	| { type: 'end'; name: string; start: number; end: number }
	| { type: 'text'; text: string; start: number; end: number }
	| { type: 'cdata' | 'comment' | 'pi' | 'doctype'; start: number; end: number };

export class XmlError extends Error {}

/** Decodes UTF-8 keeping a byte order mark, so re-encoding is lossless. */
export const decodeXml = (b: Uint8Array) =>
	new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);

const entities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|\w+);/g, (m, e: string) => {
		if (e[0] === '#') {
			const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
		}
		return entities[e] ?? m;
	});
}

export function escapeXml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

function parseAttrs(s: string, from: number, to: number) {
	const attrs: Record<string, string> = {};
	attrRe.lastIndex = from;
	for (;;) {
		while (from < to && /\s/.test(s[from])) from++;
		if (from >= to) break;
		attrRe.lastIndex = from;
		const m = attrRe.exec(s);
		if (!m || attrRe.lastIndex > to) throw new XmlError(`bad attribute at ${from}`);
		attrs[m[1]] = unescapeXml(m[2] ?? m[3]);
		from = attrRe.lastIndex;
	}
	return attrs;
}

/** How deep elements may nest before a document is refused as hostile. */
export const MAX_XML_DEPTH = 256;

export function* tokenize(s: string, maxDepth = MAX_XML_DEPTH): Generator<XmlToken> {
	let i = 0;
	const stack: string[] = [];
	while (i < s.length) {
		if (s[i] !== '<') {
			const j = s.indexOf('<', i);
			const end = j < 0 ? s.length : j;
			yield { type: 'text', text: unescapeXml(s.slice(i, end)), start: i, end };
			i = end;
			continue;
		}
		const skip = (open: string, close: string, type: 'cdata' | 'comment' | 'pi' | 'doctype') => {
			if (!s.startsWith(open, i)) return false;
			const j = s.indexOf(close, i + open.length);
			if (j < 0) throw new XmlError(`unterminated ${type} at ${i}`);
			return j + close.length;
		};
		const special: [string, string, 'cdata' | 'comment' | 'pi'][] = [
			['<![CDATA[', ']]>', 'cdata'],
			['<!--', '-->', 'comment'],
			['<?', '?>', 'pi']
		];
		let handled = false;
		for (const [o, c, t] of special) {
			const end = skip(o, c, t);
			if (end !== false) {
				yield { type: t, start: i, end };
				i = end;
				handled = true;
				break;
			}
		}
		if (handled) continue;
		if (s.startsWith('<!', i)) {
			// DOCTYPE, with an optional internal subset in brackets.
			let depth = 0;
			let j = i + 2;
			for (; j < s.length; j++) {
				if (s[j] === '[') depth++;
				else if (s[j] === ']') depth--;
				else if (s[j] === '>' && depth <= 0) break;
			}
			if (j >= s.length) throw new XmlError(`unterminated doctype at ${i}`);
			yield { type: 'doctype', start: i, end: j + 1 };
			i = j + 1;
			continue;
		}
		// A tag. Quotes may hold '>'.
		let j = i + 1;
		let q = '';
		for (; j < s.length; j++) {
			const c = s[j];
			if (q) {
				if (c === q) q = '';
			} else if (c === '"' || c === "'") q = c;
			else if (c === '>') break;
		}
		if (j >= s.length) throw new XmlError(`unterminated tag at ${i}`);
		const end = j + 1;
		if (s[i + 1] === '/') {
			const name = s.slice(i + 2, j).trim();
			if (stack.pop() !== name) throw new XmlError(`mismatched </${name}> at ${i}`);
			yield { type: 'end', name, start: i, end };
		} else {
			const selfClosing = s[j - 1] === '/';
			const bodyEnd = selfClosing ? j - 1 : j;
			const m = /^[^\s/>]+/.exec(s.slice(i + 1, bodyEnd));
			if (!m) throw new XmlError(`bad tag at ${i}`);
			const attrs = parseAttrs(s, i + 1 + m[0].length, bodyEnd);
			if (!selfClosing) {
				stack.push(m[0]);
				if (stack.length > maxDepth) throw new XmlError(`nested too deep at ${i}`);
			}
			yield { type: 'start', name: m[0], attrs, selfClosing, start: i, end };
		}
		i = end;
	}
	if (stack.length) throw new XmlError(`unclosed <${stack[stack.length - 1]}>`);
}

export interface XmlSpan {
	name: string;
	attrs: Record<string, string>;
	depth: number;
	/** Offsets of the whole element, from '<' to just after the closing '>'. */
	start: number;
	end: number;
}

/** Elements for which `pick` holds, outermost first; matches are not nested. */
export function findSpans(s: string, pick: (name: string, depth: number) => boolean): XmlSpan[] {
	const out: XmlSpan[] = [];
	let depth = 0;
	let open: XmlSpan | null = null;
	let openDepth = 0;
	for (const t of tokenize(s)) {
		if (t.type === 'start') {
			if (!open && pick(t.name, depth)) {
				const span = { name: t.name, attrs: t.attrs, depth, start: t.start, end: t.end };
				if (t.selfClosing) out.push(span);
				else {
					open = span;
					openDepth = depth;
				}
			}
			if (!t.selfClosing) depth++;
		} else if (t.type === 'end') {
			depth--;
			if (open && depth === openDepth) {
				open.end = t.end;
				out.push(open);
				open = null;
			}
		}
	}
	return out;
}

/** Replaces `[start, end)` of the source, leaving every other byte as it was. */
export const splice = (s: string, start: number, end: number, text: string) =>
	s.slice(0, start) + text + s.slice(end);

/** An element with the offsets of its whole source and of its content. */
export interface XElement {
	name: string;
	attrs: Record<string, string>;
	children: XNode[];
	start: number;
	end: number;
	/** Between the start and end tags; equal to `end` for a self-closing element. */
	innerStart: number;
	innerEnd: number;
}

export type XNode = XElement | { name: '#text'; text: string; start: number; end: number };

export const isElement = (n: XNode): n is XElement => n.name !== '#text';

/** Builds the element tree of a document, with offsets, and returns its root. */
export function parseXml(s: string, maxDepth = MAX_XML_DEPTH): XElement {
	const top: XElement = {
		name: '#document',
		attrs: {},
		children: [],
		start: 0,
		end: s.length,
		innerStart: 0,
		innerEnd: s.length
	};
	const stack: XElement[] = [top];
	for (const t of tokenize(s, maxDepth)) {
		const parent = stack[stack.length - 1];
		if (t.type === 'start') {
			const el: XElement = {
				name: t.name,
				attrs: t.attrs,
				children: [],
				start: t.start,
				end: t.end,
				innerStart: t.end,
				innerEnd: t.end
			};
			parent.children.push(el);
			if (!t.selfClosing) stack.push(el);
		} else if (t.type === 'end') {
			parent.innerEnd = t.start;
			parent.end = t.end;
			stack.pop();
		} else if (t.type === 'text') {
			parent.children.push({ name: '#text', text: t.text, start: t.start, end: t.end });
		} else if (t.type === 'cdata') {
			const text = s.slice(t.start + 9, t.end - 3);
			parent.children.push({ name: '#text', text, start: t.start, end: t.end });
		}
	}
	const root = top.children.find(isElement);
	if (root === undefined) throw new XmlError('no root element');
	return root;
}

/** Child elements, optionally of one name. */
export const kids = (el: XElement, name?: string): XElement[] =>
	el.children.filter((c): c is XElement => isElement(c) && (name === undefined || c.name === name));

export const child = (el: XElement, name: string): XElement | undefined =>
	el.children.find((c): c is XElement => isElement(c) && c.name === name);

/** Every element below, depth first, in document order. */
export function* descendants(el: XElement): Generator<XElement> {
	for (const c of el.children) {
		if (!isElement(c)) continue;
		yield c;
		yield* descendants(c);
	}
}

/** All the text below an element, in order. */
export function textOf(el: XElement): string {
	let out = '';
	for (const c of el.children) out += isElement(c) ? textOf(c) : c.text;
	return out;
}

/** Escapes text for an attribute value in double quotes. */
export const escapeAttr = (s: string) => escapeXml(s).replace(/"/g, '&quot;');
