// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { DOMParser as PMParser, DOMSerializer, Slice } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { CAPS, readDocument, writeDocument } from '$lib/formats/document';
import { plainText, sameBlock, type Paragraph } from '$lib/formats/model';
import {
	enter,
	insertTable,
	setAlign,
	setMarkValue,
	setStyle,
	shiftLevel,
	toggleList,
	toggleMark
} from './commands';
import { fromDoc, toDoc } from './convert';
import { placeCursor } from './editor';
import { findAll, replaceMatches } from './find';
import { cleanPastedHtml, lockedGuard } from './plugins';
import { schema } from './schema';

const fixture = (n: string) =>
	new Uint8Array(readFileSync(resolve(process.cwd(), 'tests/fixtures', n)));

function stateOf(text: string) {
	const doc = toDoc({
		blocks: [
			{ type: 'paragraph', style: 'normal', content: [{ type: 'text', text, marks: {} }], ref: 0 }
		]
	});
	const state = EditorState.create({ doc });
	return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 1 + text.length)));
}

const run = (
	state: EditorState,
	cmd: (s: EditorState, d?: (tr: import('prosemirror-state').Transaction) => void) => boolean
) => {
	let next = state;
	cmd(state, (tr) => (next = state.apply(tr)));
	return next;
};

describe('the editor model', () => {
	it('gives back every block of a file unchanged, so a save copies them all', async () => {
		for (const [name, format] of [
			['docs/sample.docx', 'docx'],
			['report.docx', 'docx'],
			['docs/sample.odt', 'odt'],
			['docs/sample.md', 'md']
		] as const) {
			const { model } = await readDocument(fixture(name), format);
			const back = fromDoc(toDoc(model));
			expect(back.length, name).toBe(model.blocks.length);
			back.forEach((b, i) =>
				expect(sameBlock(b, model.blocks[i]), `${name} block ${i}`).toBe(true)
			);
		}
	});

	it('edits each kind of mark and style, and the file holds them', async () => {
		let s = stateOf('formatted');
		for (const m of ['bold', 'italic', 'underline', 'strike', 'code'] as const)
			s = run(s, toggleMark(schema.marks[m]));
		s = run(s, setMarkValue(schema.marks.font, { family: 'Georgia' }));
		s = run(s, setMarkValue(schema.marks.size, { pt: 14 }));
		s = run(s, setMarkValue(schema.marks.color, { value: '#c00000' }));
		s = run(s, setMarkValue(schema.marks.highlight, { value: '#ffff00' }));
		s = run(s, setMarkValue(schema.marks.link, { href: 'https://example.org/' }));
		s = run(s, setAlign('center'));
		s = run(s, toggleList('number'));
		s = run(s, shiftLevel(1));
		const blocks = fromDoc(s.doc);
		const expected = {
			type: 'paragraph',
			style: 'normal',
			align: 'center',
			list: { kind: 'number', level: 1 },
			content: [
				{
					type: 'text',
					text: 'formatted',
					marks: {
						bold: true,
						italic: true,
						underline: true,
						strike: true,
						code: true,
						font: 'Georgia',
						size: 14,
						color: '#c00000',
						highlight: '#ffff00',
						link: 'https://example.org/'
					}
				}
			]
		};
		expect(blocks[0]).toMatchObject(expected);
		for (const f of ['docx', 'odt', 'rtf'] as const) {
			const bytes = await writeDocument(f, { blocks, images: {} });
			expect((await readDocument(bytes, f)).model.blocks[0], f).toMatchObject(expected);
		}
		s = run(stateOf('heading'), setStyle('h2'));
		expect(fromDoc(s.doc)[0]).toMatchObject({ style: 'h2' });
		s = run(stateOf('task'), toggleList('check'));
		expect(fromDoc(s.doc)[0]).toMatchObject({ list: { kind: 'check', level: 0, checked: false } });
	});

	it('keeps superscript and subscript apart, through every format that holds them', async () => {
		let s = run(stateOf('x2'), toggleMark(schema.marks.sup));
		expect(fromDoc(s.doc)[0]).toMatchObject({ content: [{ marks: { script: 'super' } }] });
		s = run(s, toggleMark(schema.marks.sub));
		const marks = fromDoc(s.doc)[0] as Paragraph;
		expect(marks.content).toMatchObject([{ marks: { script: 'sub' } }]);
		expect(s.doc.firstChild!.firstChild!.marks.map((m) => m.type.name)).toEqual(['sub']);
		const blocks = fromDoc(s.doc);
		for (const f of ['docx', 'odt', 'rtf'] as const) {
			expect(CAPS[f].marks.has('script')).toBe(true);
			const bytes = await writeDocument(f, { blocks, images: {} });
			expect((await readDocument(bytes, f)).model.blocks[0], f).toMatchObject({
				content: [{ marks: { script: 'sub' } }]
			});
		}
		expect(CAPS.md.marks.has('script')).toBe(false);
	});

	it('writes a font, size, colour or alignment into CSS only when it is one', () => {
		const html = (marks: Record<string, unknown>, align?: string) => {
			const doc = toDoc({
				blocks: [
					{
						type: 'paragraph',
						style: 'normal',
						align,
						content: [{ type: 'text', text: 'x', marks }]
					}
				]
			} as Parameters<typeof toDoc>[0]);
			const div = document.createElement('div');
			div.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
			return div.innerHTML;
		};
		const evil = html(
			{
				font: 'Evil\n;position:fixed;inset:0;x:',
				size: '12;position:fixed',
				color: 'red;position:fixed',
				highlight: '#fff;position:fixed'
			},
			'left;position:fixed'
		);
		expect(evil).not.toContain('position');
		expect(evil).not.toContain('Evil');
		expect(html({ font: 'Source Serif 4', size: 13, color: '#336699' }, 'center')).toBe(
			'<p style="text-align: center;"><span style="font-family: &quot;Source Serif 4&quot;;"><span style="font-size: 13pt;"><span style="color: rgb(51, 102, 153);">x</span></span></span></p>'
		);
	});

	it('carries a list on with Enter, and ends it on an empty item', () => {
		let s = run(stateOf('item'), toggleList('bullet'));
		s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 5)));
		s = run(s, enter);
		const blocks = fromDoc(s.doc) as Paragraph[];
		expect(blocks.map((b) => b.list?.kind)).toEqual(['bullet', 'bullet']);
		expect(blocks[1].ref).toBeUndefined();
		s = run(s, enter);
		expect((fromDoc(s.doc) as Paragraph[]).map((b) => b.list?.kind)).toEqual(['bullet', undefined]);
	});

	it('inserts a table that writes and reads back', async () => {
		const s = run(stateOf('x'), insertTable(2, 2));
		const table = fromDoc(s.doc).find((b) => b.type === 'table');
		expect(table && table.type === 'table' && table.rows.length).toBe(2);
	});

	it('does not let an edit remove or change a locked block', async () => {
		const { model } = await readDocument(fixture('report.docx'), 'docx');
		let blocked = 0;
		const state = EditorState.create({
			doc: toDoc(model),
			plugins: [lockedGuard(() => blocked++)]
		});
		let at = -1;
		state.doc.forEach((n, pos) => {
			if (at < 0 && n.type.name === 'locked') at = pos;
		});
		const del = state.tr.setSelection(NodeSelection.create(state.doc, at)).deleteSelection();
		expect(state.applyTransaction(del).state.doc.eq(state.doc)).toBe(true);
		const all = state.tr.replace(0, state.doc.content.size, Slice.empty);
		expect(state.applyTransaction(all).state.doc.eq(state.doc)).toBe(true);
		expect(blocked).toBe(2);
		const typing = state.tr.insertText('ok', 1);
		expect(state.applyTransaction(typing).state.doc.eq(state.doc)).toBe(false);
	});

	it('finds and replaces text, but not inside locked blocks', () => {
		const s = stateOf('one two one');
		const found = findAll(s.doc, 'ONE');
		expect(found).toEqual([
			{ from: 1, to: 4 },
			{ from: 9, to: 12 }
		]);
		const next = s.apply(replaceMatches(s, found, '1'));
		expect(plainText({ blocks: fromDoc(next.doc) })).toBe('1 two 1');
		const locked = EditorState.create({
			doc: toDoc({ blocks: [{ type: 'locked', label: 'x', text: 'one', ref: 0 }] })
		});
		expect(findAll(locked.doc, 'one')).toEqual([]);
	});

	it('keeps from a paste only what is safe and what the format holds', () => {
		const html = cleanPastedHtml(
			'<p><img src="https://example.org/track.png"><img src="data:image/png;base64,iVBORw0KGgo="><a href="javascript:alert(1)">bad</a> <a href="https://ok.example/">good</a><script>x()</script></p><ul><li><p>item</p></li></ul>'
		);
		expect(html).not.toContain('example.org/track');
		expect(html).toContain('data:image/png');
		expect(html).not.toContain('<script');
		expect(html).toContain('<li>item</li>');
		// The schema's parse rules drop the unsafe link and keep the safe one.
		const dom = new DOMParser().parseFromString(html, 'text/html').body;
		const doc = PMParser.fromSchema(schema).parse(dom);
		const links: string[] = [];
		doc.descendants((n) => {
			for (const m of n.marks) if (m.type.name === 'link') links.push(m.attrs.href as string);
		});
		expect(links).toEqual(['https://ok.example/']);
		expect(CAPS.md.marks.has('color')).toBe(false);
	});
});

describe('placeCursor', () => {
	function viewOf(texts: string[]) {
		const doc = toDoc({
			blocks: texts.map((text, ref) => ({
				type: 'paragraph' as const,
				style: 'normal' as const,
				content: [{ type: 'text' as const, text, marks: {} }],
				ref
			}))
		});
		const view = new EditorView(document.createElement('div'), {
			state: EditorState.create({ doc })
		});
		view.dom.getBoundingClientRect = () => new DOMRect(100, 100, 600, 200);
		return view;
	}

	it('puts the cursor at the end for a click below the text', () => {
		const view = viewOf(['first', 'last']);
		placeCursor(view, 50, 900);
		expect(view.state.selection.from).toBe(view.state.doc.content.size - 1);
		expect(view.state.selection.empty).toBe(true);
	});

	it('puts the cursor on the line of a click beside the text', () => {
		const view = viewOf(['first', 'last']);
		const asked: { left: number; top: number }[] = [];
		view.posAtCoords = (c) => (asked.push(c), { pos: 3, inside: -1 });
		placeCursor(view, 20, 150);
		expect(asked).toEqual([{ left: 101, top: 150 }]);
		expect(view.state.selection.from).toBe(3);
	});
});
