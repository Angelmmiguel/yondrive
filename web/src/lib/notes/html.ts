/**
 * A note as a page of HTML to save, and as a document for Drive. Everything from
 * the note is escaped; only web, mail and phone links stay links, and links to
 * notes and files keep their text, as no address outside the app reaches them.
 * Pictures kept as files stay out, by their description.
 */
import type { Block, DocModel, Inline, Paragraph } from '$lib/formats/model';
import { safeHref } from '$lib/formats/model';

const escape = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
	);

function inlines(content: readonly Inline[]): string {
	let out = '';
	for (const i of content) {
		if (i.type === 'break') out += '<br>';
		else if (i.type === 'image') out += escape(i.alt);
		else {
			let t = escape(i.text);
			if (i.marks.code) t = `<code>${t}</code>`;
			if (i.marks.bold) t = `<strong>${t}</strong>`;
			if (i.marks.italic) t = `<em>${t}</em>`;
			if (i.marks.strike) t = `<s>${t}</s>`;
			if (i.marks.link && safeHref(i.marks.link) && !i.marks.link.startsWith('#'))
				t = `<a href="${escape(i.marks.link.trim())}" rel="noopener noreferrer">${t}</a>`;
			out += t;
		}
	}
	return out;
}

function paragraph(p: Paragraph): string {
	const body = inlines(p.content);
	if (p.list) {
		const box =
			p.list.kind === 'check'
				? `<input type="checkbox" disabled${p.list.checked ? ' checked' : ''}> `
				: '';
		return `<li data-level="${p.list.level}">${box}${body}</li>`;
	}
	if (/^h[1-6]$/.test(p.style)) return `<${p.style}>${body}</${p.style}>`;
	if (p.style === 'title') return `<h1>${body}</h1>`;
	if (p.style === 'code') return `<pre><code>${body}</code></pre>`;
	if (p.style === 'quote')
		return `<blockquote${p.callout ? ` class="callout ${p.callout}"` : ''}>${body}</blockquote>`;
	return `<p>${body}</p>`;
}

function blocks(bs: readonly Block[]): string {
	const out: string[] = [];
	let list: 'ul' | 'ol' | null = null;
	for (const b of bs) {
		const kind = b.type === 'paragraph' && b.list ? (b.list.kind === 'number' ? 'ol' : 'ul') : null;
		if (list !== kind) {
			if (list) out.push(`</${list}>`);
			if (kind) out.push(`<${kind}>`);
			list = kind;
		}
		if (b.type === 'paragraph') out.push(paragraph(b));
		else if (b.type === 'locked') out.push(`<pre>${escape(b.text)}</pre>`);
		else
			out.push(
				`<table>${b.rows
					.map(
						(r) =>
							`<tr>${r.cells
								.map((c) => {
									const tag = c.header ? 'th' : 'td';
									return `<${tag}>${c.content.map((p) => inlines(p.content)).join('<br>')}</${tag}>`;
								})
								.join('')}</tr>`
					)
					.join('')}</table>`
			);
	}
	if (list) out.push(`</${list}>`);
	return out.join('\n');
}

/** A page that stands alone: no scripts, no outside resources. */
export function noteHtml(title: string, model: Pick<DocModel, 'blocks'>): string {
	return [
		'<!doctype html>',
		'<html><head><meta charset="utf-8">',
		`<title>${escape(title)}</title>`,
		'<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.6}',
		'pre{background:#f4f4f1;padding:.75rem;border-radius:6px;overflow:auto}blockquote{border-left:3px solid #ccc;margin:0;padding-left:1rem}',
		'.callout{background:#fff8e6;border-left-color:#c68a10;padding:.5rem 1rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.25rem .5rem}</style>',
		'</head><body>',
		`<h1>${escape(title)}</h1>`,
		blocks(model.blocks),
		'</body></html>',
		''
	].join('\n');
}

/** The blocks with pictures as their descriptions and links to notes as text, for another format. */
export function withoutNodes(model: Pick<DocModel, 'blocks'>): DocModel {
	const strip = (p: Paragraph): Paragraph => ({
		...p,
		content: p.content.map((i): Inline => {
			if (i.type === 'image') return { type: 'text', text: i.alt, marks: {} };
			if (i.type === 'text' && i.marks.link?.startsWith('yondrive:')) {
				const marks = { ...i.marks };
				delete marks.link;
				return { ...i, marks };
			}
			return i;
		})
	});
	return {
		blocks: model.blocks.map((b) =>
			b.type === 'paragraph'
				? strip(b)
				: b.type === 'table'
					? {
							...b,
							rows: b.rows.map((r) => ({
								...r,
								cells: r.cells.map((c) => ({ ...c, content: c.content.map(strip) }))
							}))
						}
					: b
		),
		images: {}
	};
}
