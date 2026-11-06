import { describe, expect, it } from 'vitest';
import { decodeXml, escapeXml, findSpans, splice, tokenize, unescapeXml, XmlError } from './xml';

describe('xml', () => {
	const src =
		'<?xml version="1.0"?>\n<w:body a="1" b=\'x&amp;y\'><w:p><w:r><w:t>Hi &lt;there&gt;</w:t></w:r></w:p><w:p/><!-- c --><![CDATA[<raw>]]><w:p w:x="a>b"><w:t>2</w:t></w:p></w:body>';

	it('yields tokens with offsets that slice back to the source', () => {
		const toks = [...tokenize(src)];
		expect(toks.map((t) => src.slice(t.start, t.end)).join('')).toBe(src);
		const body = toks.find((t) => t.type === 'start' && t.name === 'w:body');
		expect(body).toMatchObject({ attrs: { a: '1', b: 'x&y' }, selfClosing: false });
		expect(toks.find((t) => t.type === 'text' && t.text.startsWith('Hi'))).toMatchObject({
			text: 'Hi <there>'
		});
	});

	it('finds top-level spans so a block can be recovered or replaced', () => {
		const ps = findSpans(src, (n) => n === 'w:p');
		expect(ps.map((s) => src.slice(s.start, s.end))).toEqual([
			'<w:p><w:r><w:t>Hi &lt;there&gt;</w:t></w:r></w:p>',
			'<w:p/>',
			'<w:p w:x="a>b"><w:t>2</w:t></w:p>'
		]);
		const edited = splice(src, ps[2].start, ps[2].end, '<w:p/>');
		expect(edited.length).toBe(src.length - (ps[2].end - ps[2].start) + 6);
		expect(edited.slice(0, ps[2].start)).toBe(src.slice(0, ps[2].start));
		expect(edited.slice(ps[2].start + 6)).toBe(src.slice(ps[2].end));
	});

	it('does not nest matches', () => {
		const s = '<a><p><p>x</p></p><p>y</p></a>';
		expect(findSpans(s, (n) => n === 'p').map((x) => s.slice(x.start, x.end))).toEqual([
			'<p><p>x</p></p>',
			'<p>y</p>'
		]);
	});

	it('rejects malformed input', () => {
		for (const bad of ['<a>', '<a></b>', '<a x=1/>', '<!-- x', '<a']) {
			expect(() => [...tokenize(bad)], bad).toThrow(XmlError);
		}
	});

	it('escapes and unescapes', () => {
		expect(unescapeXml('&#65;&#x42;&amp;&unknown;')).toBe('AB&&unknown;');
		expect(unescapeXml(escapeXml('a<b>&c'))).toBe('a<b>&c');
	});

	it('round-trips a byte order mark and non-ascii text through decode and encode', () => {
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('<a>é€😀</a>')]);
		expect(new TextEncoder().encode(decodeXml(bytes))).toEqual(
			new Uint8Array([...new TextEncoder().encode('﻿<a>é€😀</a>')])
		);
	});
});
