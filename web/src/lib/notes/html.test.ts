import { describe, expect, it } from 'vitest';
import { readMarkdown } from '$lib/formats/markdown';
import { noteHtml, withoutNodes } from './html';
import { nodeHref } from './parse';

const A = 'a'.repeat(32);

describe('a note as HTML', () => {
	it('escapes everything from the note and keeps only safe links', () => {
		const { model } = readMarkdown(
			`<script>alert(1)</script>\n\nA [web](https://example.org) and [js](javascript:alert(1)) and [note](${nodeHref(A)}).\n\n- [x] done\n`
		);
		const html = noteHtml('<b>Title</b>', model);
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;b&gt;Title&lt;/b&gt;');
		expect(html).toContain('<a href="https://example.org" rel="noopener noreferrer">web</a>');
		expect(html).not.toContain('javascript:');
		expect(html).not.toContain('yondrive:');
		expect(html).toContain('<li data-level="0"><input type="checkbox" disabled checked> done</li>');
	});

	it('drops links to nodes and pictures for another format', () => {
		const { model } = readMarkdown(`[note](${nodeHref(A)}) ![pic](${nodeHref(A)})\n`);
		const out = withoutNodes(model);
		expect(JSON.stringify(out)).not.toContain('yondrive:');
		expect(out.images).toEqual({});
	});
});
