/**
 * What a note's Markdown says beyond its text: links, tags, tasks and pictures.
 * Links to notes and files are written `[Title](yondrive:node/<id>)`, plain
 * Markdown that any other editor keeps, by the id of the node, so a rename on
 * either side never breaks them. A `[[Title]]` typed elsewhere is read too, by
 * title. Pure, on the same reader the editor uses.
 */
import { normalizeName } from '$lib/crypto/metadata';
import { readMarkdown, writeMarkdown } from '$lib/formats/markdown';
import {
	inlineText,
	type Block,
	type DocModel,
	type Inline,
	type Paragraph
} from '$lib/formats/model';
import { countWords } from '$lib/docs/words';
import { cleanTag } from './model';

/** A link to a node, as notes write one. */
export const NODE_HREF = /^yondrive:node\/([0-9a-f]{32})$/;
export const nodeHref = (id: string) => `yondrive:node/${id}`;

export interface NoteLink {
	/** By id, or by the title a `[[Title]]` names. */
	kind: 'node' | 'title';
	target: string;
	/** The paragraph the link is in, as text. */
	context: string;
}

export interface NoteTask {
	text: string;
	done: boolean;
	/** `YYYY-MM-DD`, from a trailing `@2026-11-20`. */
	due: string | null;
}

export interface NoteFacts {
	links: NoteLink[];
	tags: string[];
	tasks: NoteTask[];
	/** Ids of pictures shown in the note. */
	images: string[];
	/** The opening text, for a card. */
	preview: string;
	/** All of the text, for mentions and their context. */
	text: string;
	words: number;
}

const WIKI = /\[\[([^\]\n|]{1,200})(?:\|[^\]\n]*)?\]\]/g;
const TAG = /(^|[\s(])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;
const DUE = /\s@(\d{4}-\d{2}-\d{2})\s*$/;
const PREVIEW = 280;
const TEXT_LIMIT = 20_000;
const TASK_LIMIT = 500;
const CONTEXT = 160;
/**
 * The most links, tags, tasks and pictures read from one note. A note may come from
 * anyone who shares it, and every one of them is looked at again on each change.
 */
export const MAX_FACTS = 1000;

/** The paragraphs of a document, those in tables included, in order. */
export function paragraphs(blocks: readonly Block[]): Paragraph[] {
	const out: Paragraph[] = [];
	for (const b of blocks) {
		if (b.type === 'paragraph') out.push(b);
		else if (b.type === 'table')
			for (const r of b.rows) for (const c of r.cells) out.push(...paragraphs(c.content));
	}
	return out;
}

/** A line of text cut around a place in it, for showing a link or a mention in context. */
export function around(text: string, at = 0, length = 0): string {
	// A long text is cut near the place first, so the cost does not grow with it.
	const reach = CONTEXT * 4;
	if (text.length > reach * 2 + length) {
		const lo = Math.max(0, at - reach);
		const hi = Math.min(text.length, at + length + reach);
		const cut = around(text.slice(lo, hi), at - lo, length);
		const lead = lo > 0 && !cut.startsWith('…') ? '…' : '';
		const tail = hi < text.length && !cut.endsWith('…') ? '…' : '';
		return `${lead}${cut}${tail}`;
	}
	const flat = text.replace(/\s+/g, ' ').trim();
	if (flat.length <= CONTEXT) return flat;
	const start = Math.max(0, Math.min(at - CONTEXT / 2 + length / 2, flat.length - CONTEXT));
	const cut = flat.slice(Math.floor(start), Math.floor(start) + CONTEXT).trim();
	return `${start > 0 ? '…' : ''}${cut}${start + CONTEXT < flat.length ? '…' : ''}`;
}

/** A task's due date and its text without it. */
export function splitDue(text: string): { text: string; due: string | null } {
	const m = DUE.exec(text);
	return m ? { text: text.slice(0, m.index).trim(), due: m[1] } : { text: text.trim(), due: null };
}

/** `#tags` in text, without code. */
export function tagsIn(text: string, limit = Infinity): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(TAG)) {
		if (out.size >= limit) break;
		const tag = cleanTag(m[2]);
		// A number alone is an issue or a heading count, not a tag.
		if (tag !== '' && /\p{L}/u.test(tag)) out.add(tag);
	}
	return [...out];
}

/** The text of a paragraph with code left out, as tags and wiki links are read from it. */
const prose = (content: readonly Inline[]) =>
	content.map((i) => (i.type === 'text' && !i.marks.code ? i.text : ' ')).join('');

export function analyze(markdown: string): NoteFacts {
	const { model } = readMarkdown(markdown);
	return analyzeModel(model);
}

export function analyzeModel(model: Pick<DocModel, 'blocks'>): NoteFacts {
	const links: NoteLink[] = [];
	// Links to the same node, or the same title, count once: the first gives the context.
	const seen = new Set<string>();
	const link = (kind: NoteLink['kind'], target: string, context: () => string) => {
		const key = `${kind}:${kind === 'title' ? normalizeName(target) : target}`;
		if (links.length >= MAX_FACTS || seen.has(key)) return;
		seen.add(key);
		links.push({ kind, target, context: context() });
	};
	const tags = new Set<string>();
	const tasks: NoteTask[] = [];
	const images = new Set<string>();
	const lines: string[] = [];
	let preview = '';
	for (const b of model.blocks) {
		if (b.type === 'locked') lines.push(b.text);
	}
	for (const p of paragraphs(model.blocks)) {
		const text = inlineText(p.content);
		lines.push(text);
		if (p.style !== 'code') {
			let at = 0;
			for (const i of p.content) {
				const here = at;
				at += i.type === 'text' ? i.text.length : i.type === 'break' ? 1 : (i.alt?.length ?? 0);
				if (i.type === 'text' && i.marks.link) {
					const m = NODE_HREF.exec(i.marks.link);
					if (m) link('node', m[1], () => around(text, here));
				} else if (i.type === 'image') {
					const m = NODE_HREF.exec(i.image);
					if (m && images.size < MAX_FACTS) images.add(m[1]);
					const l = i.link === undefined ? null : NODE_HREF.exec(i.link);
					if (l) link('node', l[1], () => around(text));
				}
			}
			const plain = prose(p.content);
			if (links.length < MAX_FACTS) {
				for (const m of plain.matchAll(WIKI)) {
					link('title', m[1].trim(), () => around(text, m.index ?? 0));
					if (links.length >= MAX_FACTS) break;
				}
			}
			if (tags.size < MAX_FACTS) for (const t of tagsIn(plain, MAX_FACTS - tags.size)) tags.add(t);
		}
		if (p.list?.kind === 'check' && tasks.length < MAX_FACTS) {
			const { text: task, due } = splitDue(text);
			tasks.push({ text: task.slice(0, TASK_LIMIT), done: p.list.checked === true, due });
		}
		if (preview.length < PREVIEW && !/^h\d$|^title$/.test(p.style) && text.trim() !== '') {
			preview = `${preview}${preview === '' ? '' : '\n'}${text.slice(0, PREVIEW * 2).trim()}`;
		}
	}
	const all = lines.join('\n');
	return {
		links,
		tags: [...tags],
		tasks,
		images: [...images],
		preview: preview.length > PREVIEW ? `${preview.slice(0, PREVIEW).trimEnd()}…` : preview,
		text: all.slice(0, TEXT_LIMIT),
		words: countWords(model.blocks as Block[])
	};
}

/** Where a title is mentioned as a whole phrase, ignoring case; -1 if nowhere. */
export function mentionAt(text: string, title: string): number {
	const t = title.trim();
	if (t.length < 2) return -1;
	const hay = text.toLocaleLowerCase();
	const needle = t.toLocaleLowerCase();
	const word = /[\p{L}\p{N}]/u;
	for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
		const before = at === 0 ? '' : hay[at - 1];
		const after = hay[at + needle.length] ?? '';
		if (!word.test(before) && !word.test(after)) return at;
	}
	return -1;
}

/**
 * Turns the first plain mention of `title` in a note into a link to `id`, writing
 * back only the paragraph it is in. Null if there is no such mention.
 */
export function linkMention(markdown: string, title: string, id: string): string | null {
	const { model } = readMarkdown(markdown);
	for (const p of paragraphs(model.blocks)) {
		if (p.style === 'code') continue;
		for (let k = 0; k < p.content.length; k++) {
			const i = p.content[k];
			if (i.type !== 'text' || i.marks.link || i.marks.code) continue;
			const at = mentionAt(i.text, title);
			if (at < 0) continue;
			const end = at + title.trim().length;
			const parts: Inline[] = [];
			if (at > 0) parts.push({ type: 'text', text: i.text.slice(0, at), marks: i.marks });
			parts.push({
				type: 'text',
				text: i.text.slice(at, end),
				marks: { ...i.marks, link: nodeHref(id) }
			});
			if (end < i.text.length)
				parts.push({ type: 'text', text: i.text.slice(end), marks: i.marks });
			p.content.splice(k, 1, ...parts);
			return writeMarkdown(model as DocModel, markdown);
		}
	}
	return null;
}
