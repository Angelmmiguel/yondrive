/**
 * Markdown, CommonMark with GitHub's tables, task lists and strikethrough. Blocks
 * keep their place in the source, so a save writes back every block that did not
 * change exactly as it was, spacing and markers included, and regenerates only
 * the rest. What the model cannot hold (HTML, front matter, footnotes, dividers,
 * link definitions) is locked. Raw HTML inside text stays text: nothing here is
 * ever rendered as HTML.
 */
import {
	normalizeInlines,
	sameBlock,
	Tally,
	type Block,
	type Cell,
	type Census,
	type DocModel,
	type Inline,
	type Marks,
	type Paragraph,
	type Table
} from './model';
import { plan, type SourceItem } from './patch';

/** Bounds on input nobody has vouched for. */
export const MARKDOWN_LIMITS = { size: 8 * 1024 * 1024, depth: 32 };

export class MarkdownError extends Error {}

interface Line {
	text: string;
	start: number;
	end: number;
}

interface Unit {
	block: Block;
	start: number;
	end: number;
	/** The marker of a list item and its number, kept when the item is regenerated. */
	marker?: string;
	fence?: string;
	align?: string;
}

const BULLET = /^( *)([-+*])( +|$)(.*)$/;
const ORDERED = /^( *)(\d{1,9})([.)])( +|$)(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIM = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const HTML_BLOCK = /^ {0,3}<(\/?[a-zA-Z][\w-]*(\s|\/?>|$)|!--|\?|![A-Z])/;

function splitLines(src: string): Line[] {
	const out: Line[] = [];
	let start = 0;
	while (start <= src.length) {
		let end = src.indexOf('\n', start);
		if (end < 0) end = src.length;
		const textEnd = end > start && src[end - 1] === '\r' ? end - 1 : end;
		out.push({ text: src.slice(start, textEnd), start, end: textEnd });
		if (end >= src.length) break;
		start = end + 1;
	}
	if (out.length > 0 && out[out.length - 1].text === '' && src.endsWith('\n')) out.pop();
	return out;
}

const blank = (l: Line | undefined) => l === undefined || /^[ \t]*$/.test(l.text);

interface Parsed {
	src: string;
	units: Unit[];
	tally: Tally;
	eol: string;
}

/** Where a block of the source starts that would end a paragraph. */
function interrupts(text: string): boolean {
	return (
		ATX.test(text) ||
		FENCE.test(text) ||
		HR.test(text) ||
		/^ {0,3}>/.test(text) ||
		BULLET.test(text) ||
		/^( {0,3})1[.)]( |$)/.test(text) ||
		HTML_BLOCK.test(text)
	);
}

function parse(src: string): Parsed {
	if (src.length > MARKDOWN_LIMITS.size) throw new MarkdownError('too large');
	const lines = splitLines(src);
	const tally = new Tally();
	const units: Unit[] = [];
	const defs = new Map<string, string>();
	for (const l of lines) {
		const m = DEFINITION.exec(l.text);
		if (m) defs.set(m[1].toLowerCase(), m[2]);
	}
	const inline = new InlineParser(defs, tally);
	const push = (block: Block, from: Line, to: Line, extra: Partial<Unit> = {}) =>
		units.push({ block, start: from.start, end: to.end, ...extra });
	const lock = (label: string, from: number, to: number) => {
		tally.add(label, 'locked');
		const text = lines
			.slice(from, to + 1)
			.map((l) => l.text)
			.join('\n');
		push({ type: 'locked', label, text, ref: -1 }, lines[from], lines[to]);
	};

	let i = 0;
	if (lines[0]?.text === '---') {
		let j = 1;
		while (j < lines.length && lines[j].text !== '---' && lines[j].text !== '...') j++;
		if (j < lines.length) {
			lock('Front matter', 0, j);
			i = j + 1;
		}
	}
	// Each open list item: the column its content starts at.
	let listStack: number[] = [];
	while (i < lines.length) {
		const line = lines[i];
		const text = line.text;
		if (blank(line)) {
			i++;
			continue;
		}
		const fence = FENCE.exec(text);
		if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
			const marker = fence[1];
			let j = i + 1;
			const body: string[] = [];
			const indent = /^ */.exec(text)![0].length;
			while (j < lines.length) {
				const close = new RegExp(
					`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`
				);
				if (close.test(lines[j].text)) break;
				body.push(lines[j].text.replace(new RegExp(`^ {0,${indent}}`), ''));
				j++;
			}
			const end = Math.min(j, lines.length - 1);
			push(codeParagraph(body), line, lines[end], { fence: text.trim() });
			listStack = [];
			i = end + 1;
			continue;
		}
		const atx = ATX.exec(text);
		if (atx) {
			const level = atx[1].length;
			push(
				paragraphOf(inline.parse(atx[2] ?? ''), { style: `h${level}` as Paragraph['style'] }),
				line,
				line
			);
			listStack = [];
			i++;
			continue;
		}
		if (HR.test(text) && !(listStack.length > 0 && BULLET.test(text))) {
			lock('Divider', i, i);
			listStack = [];
			i++;
			continue;
		}
		if (HTML_BLOCK.test(text)) {
			let j = i;
			while (j + 1 < lines.length && !blank(lines[j + 1])) j++;
			tally.add('HTML block, shown as text', 'locked');
			push(
				{
					type: 'locked',
					label: 'HTML',
					text: lines
						.slice(i, j + 1)
						.map((l) => l.text)
						.join('\n'),
					ref: -1
				},
				line,
				lines[j]
			);
			listStack = [];
			i = j + 1;
			continue;
		}
		if (DEFINITION.test(text)) {
			let j = i;
			while (j + 1 < lines.length && DEFINITION.test(lines[j + 1].text)) j++;
			lock(/^\s*\[\^/.test(text) ? 'Footnote' : 'Link definitions', i, j);
			i = j + 1;
			continue;
		}
		if (/^ {0,3}\[\^[^\]]+\]:/.test(text)) {
			let j = i;
			while (j + 1 < lines.length && !blank(lines[j + 1]) && /^\s{2,}/.test(lines[j + 1].text)) j++;
			lock('Footnote', i, j);
			i = j + 1;
			continue;
		}
		if (/^ {0,3}>/.test(text)) {
			let j = i;
			while (j + 1 < lines.length && /^ {0,3}>/.test(lines[j + 1].text)) j++;
			const inner = lines.slice(i, j + 1).map((l) => l.text.replace(/^ {0,3}> ?/, ''));
			const nested = inner.some((t) => interrupts(t) || /^ {4}/.test(t) || /^\|/.test(t));
			if (nested) lock('Quote with other blocks inside', i, j);
			else {
				// Each paragraph of the quote is a block of its own.
				let k = 0;
				while (k < inner.length) {
					if (/^\s*$/.test(inner[k])) {
						k++;
						continue;
					}
					let e = k;
					while (e + 1 < inner.length && !/^\s*$/.test(inner[e + 1])) e++;
					const content = inline.parse(inner.slice(k, e + 1).join('\n'));
					push(paragraphOf(content, { style: 'quote' }), lines[i + k], lines[i + e]);
					k = e + 1;
				}
			}
			listStack = [];
			i = j + 1;
			continue;
		}
		const bullet = BULLET.exec(text);
		const ordered = bullet ? null : ORDERED.exec(text);
		if (bullet || ordered) {
			const indent = (bullet ?? ordered)![1].length;
			const markerText = bullet ? bullet[2] : `${ordered![2]}${ordered![3]}`;
			const spacing = bullet ? bullet[3] : ordered![4];
			let content = bullet ? bullet[4] : ordered![5];
			const contentCol = indent + markerText.length + Math.max(1, Math.min(spacing.length, 4));
			while (listStack.length > 0 && indent < listStack[listStack.length - 1]) listStack.pop();
			const level = Math.min(listStack.length, MARKDOWN_LIMITS.depth);
			listStack.push(contentCol);
			let j = i;
			while (j + 1 < lines.length) {
				const next = lines[j + 1];
				if (blank(next)) break;
				const n = next.text;
				if (BULLET.test(n) || ORDERED.test(n) || interrupts(n)) break;
				j++;
			}
			// An item that goes on after a blank line holds more than one paragraph.
			let k = j + 1;
			while (k < lines.length && blank(lines[k])) k++;
			if (k < lines.length && k > j + 1) {
				const ind = /^ */.exec(lines[k].text)![0].length;
				if (ind >= contentCol && !BULLET.test(lines[k].text) && !ORDERED.test(lines[k].text)) {
					let e = k;
					while (
						e + 1 < lines.length &&
						(blank(lines[e + 1]) || /^ */.exec(lines[e + 1].text)![0].length >= contentCol)
					)
						e++;
					while (blank(lines[e])) e--;
					lock('List item with several paragraphs', i, e);
					i = e + 1;
					continue;
				}
			}
			const rest = lines.slice(i + 1, j + 1).map((l) => l.text.trim());
			let check: boolean | undefined;
			const task = /^\[([ xX])\](?: +|$)(.*)$/.exec(content);
			if (task) {
				check = task[1] !== ' ';
				content = task[2];
			}
			const para = paragraphOf(inline.parse([content, ...rest].join('\n')), {
				list:
					check === undefined
						? { kind: bullet ? 'bullet' : 'number', level }
						: { kind: 'check', level, checked: check }
			});
			push(para, line, lines[j], { marker: `${' '.repeat(indent)}${markerText}` });
			i = j + 1;
			continue;
		}
		if (/^ {4,}/.test(text) || text.startsWith('\t')) {
			let j = i;
			while (j + 1 < lines.length && (blank(lines[j + 1]) || /^( {4,}|\t)/.test(lines[j + 1].text)))
				j++;
			while (blank(lines[j])) j--;
			const body = lines.slice(i, j + 1).map((l) => l.text.replace(/^( {4}|\t)/, ''));
			push(codeParagraph(body), line, lines[j], { fence: 'indent' });
			i = j + 1;
			continue;
		}
		listStack = [];
		if (
			text.includes('|') &&
			i + 1 < lines.length &&
			TABLE_DELIM.test(lines[i + 1].text) &&
			lines[i + 1].text.includes('-')
		) {
			const header = cellsOf(text);
			const delim = cellsOf(lines[i + 1].text);
			if (header.length === delim.length) {
				let j = i + 1;
				while (j + 1 < lines.length && !blank(lines[j + 1]) && lines[j + 1].text.includes('|')) j++;
				const rows = [header, ...lines.slice(i + 2, j + 1).map((l) => cellsOf(l.text))];
				const table: Table = {
					type: 'table',
					rows: rows.map((cells, r) => ({
						cells: Array.from({ length: header.length }, (_, c) => {
							const cell: Cell = { content: [paragraphOf(inline.parse(cells[c] ?? ''))] };
							if (r === 0) cell.header = true;
							return cell;
						})
					}))
				};
				push(table, line, lines[j], { align: lines[i + 1].text });
				i = j + 1;
				continue;
			}
		}
		// A paragraph, which may end in a setext underline.
		let j = i;
		let style: Paragraph['style'] = 'normal';
		while (j + 1 < lines.length) {
			const n = lines[j + 1];
			if (blank(n)) break;
			if (SETEXT.test(n.text)) {
				style = n.text.trim()[0] === '=' ? 'h1' : 'h2';
				j++;
				break;
			}
			if (interrupts(n.text)) break;
			j++;
		}
		const bodyLines = lines
			.slice(i, style === 'normal' ? j + 1 : j)
			.map((l) => l.text.replace(/^ {0,3}/, ''));
		const joined = bodyLines.join('\n');
		if (/\[\^[^\]]+\]/.test(joined)) lock('Footnote', i, j);
		else push(paragraphOf(inline.parse(joined), { style }), line, lines[j]);
		i = j + 1;
	}
	return { src, units, tally, eol: src.includes('\r\n') ? '\r\n' : '\n' };
}

function cellsOf(line: string): string[] {
	let t = line.trim();
	if (t.startsWith('|')) t = t.slice(1);
	if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
	const out: string[] = [];
	let cur = '';
	for (let i = 0; i < t.length; i++) {
		if (t[i] === '\\' && t[i + 1] === '|') {
			cur += '|';
			i++;
		} else if (t[i] === '|') {
			out.push(cur.trim());
			cur = '';
		} else cur += t[i];
	}
	out.push(cur.trim());
	return out;
}

function paragraphOf(content: Inline[], extra: Partial<Paragraph> = {}): Paragraph {
	return { type: 'paragraph', style: 'normal', content: normalizeInlines(content), ...extra };
}

function codeParagraph(lines: string[]): Paragraph {
	const content: Inline[] = [];
	lines.forEach((l, i) => {
		if (i > 0) content.push({ type: 'break' });
		content.push({ type: 'text', text: l, marks: {} });
	});
	return paragraphOf(content, { style: 'code' });
}

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

interface Delim {
	char: string;
	count: number;
	open: boolean;
	close: boolean;
	/** Index in `items` of the text holding the run. */
	at: number;
}

type Item = { text: string; marks: Marks } | { image: Inline } | { brk: true };

class InlineParser {
	readonly #defs: Map<string, string>;
	readonly #tally: Tally;

	constructor(defs: Map<string, string>, tally: Tally) {
		this.#defs = defs;
		this.#tally = tally;
	}

	parse(src: string, base: Marks = {}, depth = 0): Inline[] {
		if (depth > MARKDOWN_LIMITS.depth) return [{ type: 'text', text: src, marks: base }];
		const items: Item[] = [];
		const delims: Delim[] = [];
		let buf = '';
		const flush = () => {
			if (buf !== '') items.push({ text: buf, marks: { ...base } });
			buf = '';
		};
		let i = 0;
		while (i < src.length) {
			const c = src[i];
			if (c === '\\' && i + 1 < src.length) {
				if (src[i + 1] === '\n') {
					flush();
					items.push({ brk: true });
					i += 2;
					continue;
				}
				if (PUNCT.test(src[i + 1])) {
					buf += src[i + 1];
					i += 2;
					continue;
				}
			}
			if (c === '\n') {
				if (/ {2,}$/.test(buf)) {
					buf = buf.replace(/ +$/, '');
					flush();
					items.push({ brk: true });
				} else buf = `${buf.replace(/ +$/, '')} `;
				i++;
				while (src[i] === ' ') i++;
				continue;
			}
			if (c === '`') {
				const run = /^`+/.exec(src.slice(i))![0];
				const close = src.indexOf(run, i + run.length);
				let j = close;
				while (j >= 0 && src[j + run.length] === '`') j = src.indexOf(run, j + run.length + 1);
				if (j >= 0) {
					flush();
					let code = src.slice(i + run.length, j).replace(/\n/g, ' ');
					if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
					items.push({ text: code, marks: { ...base, code: true } });
					i = j + run.length;
					continue;
				}
				buf += run;
				i += run.length;
				continue;
			}
			if (c === '<') {
				const auto = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(src.slice(i));
				const mail = /^<([^\s<>@]+@[^\s<>]+\.[^\s<>]+)>/.exec(src.slice(i));
				if (auto || mail) {
					flush();
					const url = auto ? auto[1] : `mailto:${mail![1]}`;
					items.push({ text: auto ? auto[1] : mail![1], marks: { ...base, link: url } });
					i += (auto ?? mail)![0].length;
					continue;
				}
				if (/^<\/?[a-zA-Z][\w-]*(\s[^>]*)?\/?>/.test(src.slice(i))) {
					this.#tally.add('Inline HTML, shown as text', 'changed');
				}
			}
			if (c === '!' && src[i + 1] === '[') {
				const link = this.#link(src, i + 1);
				if (link) {
					flush();
					items.push({
						image: {
							type: 'image',
							image: link.url,
							alt: link.text,
							...(base.link ? { link: base.link } : {})
						}
					});
					i = link.end;
					continue;
				}
			}
			if (c === '[') {
				const link = this.#link(src, i);
				if (link) {
					flush();
					for (const inl of this.parse(link.text, { ...base, link: link.url }, depth + 1)) {
						if (inl.type === 'text') items.push({ text: inl.text, marks: inl.marks });
						else if (inl.type === 'break') items.push({ brk: true });
						else items.push({ image: inl });
					}
					i = link.end;
					continue;
				}
			}
			if (c === '*' || c === '_' || c === '~') {
				let end = i + 1;
				while (src[end] === c) end++;
				const run = src.slice(i, end);
				const before = i === 0 ? ' ' : src[i - 1];
				const after = src[i + run.length] ?? ' ';
				const ws = (x: string) => /\s/.test(x);
				const pu = (x: string) => PUNCT.test(x);
				const left = !ws(after) && (!pu(after) || ws(before) || pu(before));
				const right = !ws(before) && (!pu(before) || ws(after) || pu(after));
				let open = left;
				let close = right;
				if (c === '_') {
					open = left && (!right || pu(before));
					close = right && (!left || pu(after));
				}
				if (c === '~' && run.length !== 2) {
					buf += run;
					i += run.length;
					continue;
				}
				flush();
				items.push({ text: run, marks: { ...base } });
				delims.push({ char: c, count: run.length, open, close, at: items.length - 1 });
				i += run.length;
				continue;
			}
			buf += c;
			i++;
		}
		flush();
		this.#emphasis(items, delims);
		const out: Inline[] = [];
		for (const it of items) {
			if ('brk' in it) out.push({ type: 'break' });
			else if ('image' in it) out.push(it.image);
			else if (it.text !== '') out.push({ type: 'text', text: it.text, marks: it.marks });
		}
		return normalizeInlines(out);
	}

	/** Pairs delimiter runs, as CommonMark does, and marks the text between them. */
	#emphasis(items: Item[], delims: Delim[]): void {
		// The delimiters still in play, as a linked list, so that those a pair
		// encloses are dropped once rather than walked again by every later closer.
		const prev = delims.map((_, i) => i - 1);
		const next = delims.map((_, i) => (i + 1 < delims.length ? i + 1 : -1));
		const drop = (i: number) => {
			if (prev[i] >= 0) next[prev[i]] = next[i];
			if (next[i] >= 0) prev[next[i]] = prev[i];
		};
		const length = delims.map((d) => d.count);
		// Each pair adds one to its mark over the items between, applied once at the end.
		const spans = new Map<keyof Marks, Int32Array>();
		// Where the search for an opener stopped finding one, for each kind of closer.
		const bottom = new Map<string, number>();
		for (let c = delims.length > 0 ? 0 : -1; c !== -1;) {
			const closer = delims[c];
			if (!closer.close || closer.count === 0) {
				c = next[c];
				continue;
			}
			const kind = `${closer.char}${closer.open ? 1 : 0}${length[c] % 3}`;
			const floor = bottom.get(kind) ?? -1;
			let o = prev[c];
			for (; o > floor; o = prev[o]) {
				const opener = delims[o];
				if (opener.char !== closer.char || !opener.open || opener.count === 0) continue;
				if (
					closer.char !== '~' &&
					(opener.close || closer.open) &&
					(length[o] + length[c]) % 3 === 0 &&
					(length[o] % 3 !== 0 || length[c] % 3 !== 0)
				) {
					continue;
				}
				break;
			}
			if (o <= floor) {
				bottom.set(kind, prev[c]);
				if (!closer.open) drop(c);
				c = next[c];
				continue;
			}
			const opener = delims[o];
			const use = closer.char === '~' ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
			const mark: keyof Marks = closer.char === '~' ? 'strike' : use === 2 ? 'bold' : 'italic';
			let span = spans.get(mark);
			if (span === undefined) spans.set(mark, (span = new Int32Array(items.length + 1)));
			span[opener.at + 1]++;
			span[closer.at]--;
			opener.count -= use;
			closer.count -= use;
			const oi = items[opener.at] as { text: string };
			const ci = items[closer.at] as { text: string };
			oi.text = oi.text.slice(use);
			ci.text = ci.text.slice(use);
			// Delimiters between the pair can no longer match.
			for (let k = next[o]; k !== c; k = next[k]) {
				delims[k].count = 0;
				drop(k);
			}
			if (opener.count === 0) drop(o);
			if (closer.count === 0) {
				drop(c);
				c = next[c];
			}
		}
		// What never matched is literal text, already in place, and takes the marks around it.
		for (const [mark, span] of spans) {
			let depth = 0;
			for (let k = 0; k < items.length; k++) {
				depth += span[k];
				const it = items[k];
				if (depth > 0 && 'text' in it) (it.marks as Record<string, unknown>)[mark] = true;
			}
		}
	}

	#link(src: string, at: number): { text: string; url: string; end: number } | null {
		let depth = 0;
		let j = at;
		for (; j < src.length; j++) {
			if (src[j] === '\\') {
				j++;
				continue;
			}
			if (src[j] === '[') depth++;
			else if (src[j] === ']' && --depth === 0) break;
		}
		if (j >= src.length) return null;
		const text = src.slice(at + 1, j);
		const rest = src.slice(j + 1);
		const inlineLink =
			/^\(\s*(?:<([^>\n]*)>|((?:[^\s()\\]|\\.|\([^\s()]*\))*))(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/.exec(
				rest
			);
		if (inlineLink) {
			return {
				text,
				url: (inlineLink[1] ?? inlineLink[2] ?? '').replace(/\\(.)/g, '$1'),
				end: j + 1 + inlineLink[0].length
			};
		}
		const ref = /^\[([^\]]*)\]/.exec(rest);
		const key = (ref && ref[1] !== '' ? ref[1] : text).toLowerCase();
		const url = this.#defs.get(key);
		if (url !== undefined) return { text, url, end: j + 1 + (ref ? ref[0].length : 0) };
		return null;
	}
}

// Writing.

const escapeText = (s: string) => s.replace(/[\\`*_[\]<>~|&]/g, (c) => `\\${c}`);

/** Escapes what would start a block at the beginning of a line. */
function escapeLineStart(s: string): string {
	return s
		.replace(/^(\s*)(#{1,6}(?:\s|$))/, '$1\\$2')
		.replace(/^(\s*)([-+]\s)/, '$1\\$2')
		.replace(/^(\s*)(\d+)([.)]\s)/, '$1$2\\$3')
		.replace(/^(\s*)(=+\s*$)/, '$1\\$2');
}

function serializeInlines(content: readonly Inline[]): string {
	const ORDER: (keyof Marks)[] = ['link', 'bold', 'italic', 'strike'];
	const open: { mark: keyof Marks; value?: string }[] = [];
	let out = '';
	let pendingTrail = '';
	const closeTo = (n: number) => {
		while (open.length > n) {
			const m = open.pop()!;
			out += m.mark === 'link' ? `](${linkUrl(m.value ?? '')})` : DELIM[m.mark as 'bold'];
		}
	};
	for (const it of content) {
		const marks: Marks =
			it.type === 'text' ? it.marks : it.type === 'image' && it.link ? { link: it.link } : {};
		let keep = 0;
		while (keep < open.length) {
			const m = open[keep];
			const v = marks[m.mark];
			if (v === undefined || (m.mark === 'link' && v !== m.value)) break;
			keep++;
		}
		const closing = keep < open.length;
		if (closing) closeTo(keep);
		out += pendingTrail;
		pendingTrail = '';
		if (it.type === 'break') {
			out += '\\\n';
			continue;
		}
		let text = it.type === 'text' ? it.text : '';
		let lead = '';
		const opening = ORDER.filter((k) => marks[k] !== undefined && !open.some((o) => o.mark === k));
		if (it.type === 'text' && opening.length > 0) {
			lead = /^\s*/.exec(text)![0];
			text = text.slice(lead.length);
		}
		out += lead;
		for (const k of opening) {
			open.push({ mark: k, value: k === 'link' ? marks.link : undefined });
			out += k === 'link' ? '[' : DELIM[k as 'bold'];
		}
		if (it.type === 'image') {
			out += `![${escapeText(it.alt)}](${linkUrl(it.image.startsWith('http') ? it.image : '')})`;
			continue;
		}
		const trail = open.length > 0 ? /\s*$/.exec(text)![0] : '';
		text = text.slice(0, text.length - trail.length);
		if (marks.code) {
			const ticks = '`'.repeat(
				Math.max(1, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1))
			);
			const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
			out += `${ticks}${pad}${text}${pad}${ticks}`;
		} else out += escapeText(text);
		pendingTrail = trail;
	}
	closeTo(0);
	out += pendingTrail;
	return out;
}

const DELIM = { bold: '**', italic: '*', strike: '~~' } as const;

const linkUrl = (url: string) => (/[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, '')}>` : url);

function serializeParagraph(p: Paragraph, unit: Unit | undefined, eol: string): string {
	const body = serializeInlines(p.content);
	switch (p.style) {
		case 'h1':
		case 'h2':
		case 'h3':
		case 'h4':
		case 'h5':
		case 'h6':
			return `${'#'.repeat(Number(p.style[1]))} ${body.replace(/\\\n/g, ' ')}`;
		case 'title':
			return `# ${body.replace(/\\\n/g, ' ')}`;
		case 'code': {
			const text = p.content
				.map((i) => (i.type === 'text' ? i.text : i.type === 'break' ? '\n' : ''))
				.join('');
			const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
			const fence =
				unit?.fence && unit.fence !== 'indent' && !text.includes(unit.fence.replace(/[^`~]/g, ''))
					? unit.fence
					: '`'.repeat(longest + 1);
			const close = /^[`~]+/.exec(fence)![0];
			return [fence, ...text.split('\n'), close].join(eol);
		}
		case 'quote':
			return body
				.split('\n')
				.map((l) => `> ${l}`)
				.join(eol);
	}
	if (p.list) {
		const level = p.list.level;
		let marker: string;
		if (
			unit?.marker !== undefined &&
			unit.block.type === 'paragraph' &&
			unit.block.list?.kind === p.list.kind &&
			unit.block.list.level === level
		) {
			marker = unit.marker;
		} else {
			marker = `${'    '.repeat(level)}${p.list.kind === 'number' ? '1.' : '-'}`;
		}
		const box = p.list.kind === 'check' ? (p.list.checked ? '[x] ' : '[ ] ') : '';
		const pad = ' '.repeat(marker.length + 1);
		const lines = body.split('\n');
		return [`${marker} ${box}${lines[0]}`, ...lines.slice(1).map((l) => pad + l)].join(eol);
	}
	return body
		.split('\n')
		.map((l, i) => (i === 0 ? escapeLineStart(l) : escapeLineStart(l)))
		.join(eol);
}

function serializeTable(t: Table, unit: Unit | undefined, eol: string): string {
	const width = Math.max(1, ...t.rows.map((r) => r.cells.length));
	const cell = (c: Cell | undefined) =>
		(c?.content ?? [])
			.map((p) => serializeInlines(p.content).replace(/\\\n/g, ' '))
			.join(' ')
			.replace(/\|/g, '\\|');
	const row = (cells: Cell[]) =>
		`| ${Array.from({ length: width }, (_, i) => cell(cells[i]) || ' ').join(' | ')} |`;
	const delim =
		unit?.align &&
		unit.block.type === 'table' &&
		Math.max(...unit.block.rows.map((r) => r.cells.length)) === width
			? unit.align
			: `|${' --- |'.repeat(width)}`;
	const [head, ...rest] = t.rows.length > 0 ? t.rows : [{ cells: [] }];
	return [row(head.cells), delim, ...rest.map((r) => row(r.cells))].join(eol);
}

function serializeBlock(b: Block, unit: Unit | undefined, eol: string): string {
	if (b.type === 'locked') return b.text.split('\n').join(eol);
	if (b.type === 'table') return serializeTable(b, unit, eol);
	return serializeParagraph(b, unit, eol);
}

export function readMarkdown(src: string): { model: DocModel; census: Census } {
	const p = parse(src);
	return {
		model: { blocks: p.units.map((u, i) => withRef(u.block, i)), images: {} },
		census: p.tally.census()
	};
}

function withRef(b: Block, ref: number): Block {
	return { ...b, ref } as Block;
}

/** The model as Markdown; with the original, unchanged blocks are copied from it. */
export function writeMarkdown(model: DocModel, original?: string): string {
	const p = parse(original ?? '');
	const items: SourceItem[] = p.units.map((u, i) => ({ ref: i, start: u.start, end: u.end }));
	const atoms = plan(p.src, { start: 0, end: p.src.length }, items, model.blocks, (b) => b.ref);
	const pieces: { text: string; block?: Block }[] = [];
	for (const a of atoms) {
		if (a.kind === 'gap') {
			pieces.push({ text: a.text });
			continue;
		}
		const b = a.block;
		const item = a.kind === 'kept' ? a.item : undefined;
		const unit = item ? p.units[item.ref] : undefined;
		if (item && unit && sameBlock(b, withRef(unit.block, item.ref))) {
			pieces.push({ text: p.src.slice(item.start, item.end), block: b });
		} else {
			const own = b.ref === undefined ? undefined : p.units[b.ref];
			pieces.push({ text: serializeBlock(b, unit ?? own, p.eol), block: b });
		}
	}
	let out = '';
	let prev: Block | undefined;
	let gapSince = true;
	for (const piece of pieces) {
		if (piece.block === undefined) {
			out += piece.text;
			if (/\n/.test(piece.text)) gapSince = true;
			continue;
		}
		if (!gapSince && prev !== undefined) {
			const tight = isItem(prev) && isItem(piece.block);
			out += tight ? p.eol : p.eol + p.eol;
		}
		out += piece.text;
		prev = piece.block;
		gapSince = false;
	}
	if (original === undefined && out !== '') out += p.eol;
	return out;
}

const isItem = (b: Block) => b.type === 'paragraph' && b.list !== undefined;
