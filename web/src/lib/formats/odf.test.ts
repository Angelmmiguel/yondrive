import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plainText, type Block, type DocModel, type Paragraph } from './model';
import { odtTemplate, readOdt, writeOdt } from './odf';
import { decodeXml } from './xml';
import { entryData, readZip, writeZip } from './zip';

const fixture = (n: string) =>
	new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/${n}`, import.meta.url)));
const enc = new TextEncoder();
const paras = (m: DocModel) => m.blocks.filter((b): b is Paragraph => b.type === 'paragraph');
const textOf = (b: Block) => plainText({ blocks: [b] });
const content = async (bytes: Uint8Array) =>
	decodeXml(await entryData(readZip(bytes).get('content.xml')!));

function expectUntouched(before: Uint8Array, after: Uint8Array, except: string[]) {
	const a = readZip(before);
	const b = readZip(after);
	expect(b.entries.map((e) => e.name).slice(0, a.entries.length)).toEqual(
		a.entries.map((e) => e.name)
	);
	for (const e of a.entries) {
		if (except.includes(e.name)) continue;
		expect(b.get(e.name)?.local, e.name).toEqual(e.local);
	}
}

function window(a: string, b: string) {
	let s = 0;
	while (s < a.length && s < b.length && a[s] === b[s]) s++;
	let e = 0;
	while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
	return { before: a.slice(s, a.length - e), after: b.slice(s, b.length - e) };
}

describe('odt', () => {
	it('reads the pandoc sample', async () => {
		const { model } = await readOdt(fixture('docs/sample.odt'));
		const ps = paras(model);
		expect(ps[0]).toMatchObject({ style: 'h1' });
		expect(textOf(ps[0])).toBe('Quarterly notes');
		expect(ps[1].content).toContainEqual({ type: 'text', text: 'trust', marks: { bold: true } });
		expect(ps[1].content).toContainEqual({ type: 'text', text: 'speed', marks: { italic: true } });
		expect(ps[1].content).toContainEqual({ type: 'text', text: 'noise', marks: { strike: true } });
		expect(ps.filter((p) => p.list?.kind === 'bullet').map((p) => p.list?.level)).toEqual([
			0, 0, 1, 0
		]);
		expect(ps.filter((p) => p.list?.kind === 'number').map(textOf)).toEqual([
			'First step',
			'Second step'
		]);
		expect(ps.filter((p) => p.list?.kind === 'check').map((p) => p.list?.checked)).toEqual([
			false,
			true
		]);
		expect(ps.some((p) => p.style === 'quote')).toBe(true);
		expect(ps.some((p) => p.style === 'code')).toBe(true);
		expect(model.blocks.some((b) => b.type === 'table')).toBe(true);
		const img = ps.flatMap((p) => p.content).find((i) => i.type === 'image') as { image: string };
		expect(model.images[img.image].mime).toBe('image/png');
		expect(ps.flatMap((p) => p.content).some((i) => i.type === 'text' && i.marks.code)).toBe(true);
	});

	it('writes an unedited document back untouched', async () => {
		const bytes = fixture('docs/sample.odt');
		const out = await writeOdt((await readOdt(bytes)).model, bytes);
		expectUntouched(bytes, out, []);
	});

	it('regenerates only an edited list item, keeping the list markup', async () => {
		const bytes = fixture('docs/sample.odt');
		const { model } = await readOdt(bytes);
		const item = paras(model).find((p) => textOf(p) === 'Share links that expire.')!;
		item.content = [{ type: 'text', text: 'Share links, edited', marks: { bold: true } }];
		const out = await writeOdt(model, bytes);
		expectUntouched(bytes, out, ['content.xml']);
		const body = (s: string) => s.slice(s.indexOf('<office:body'));
		const { before, after } = window(body(await content(bytes)), body(await content(out)));
		expect(before).toContain('Share links that expire');
		expect(after).toContain('Share links, edited');
		expect(before).not.toContain('text:list-item');
		const back = (await readOdt(out)).model;
		expect(paras(back).find((p) => textOf(p) === 'Share links, edited')).toMatchObject({
			list: { kind: 'bullet', level: 0 },
			content: [{ type: 'text', text: 'Share links, edited', marks: { bold: true } }]
		});
	});

	it('rebuilds a list around added items and keeps the others verbatim', async () => {
		const bytes = fixture('docs/sample.odt');
		const { model } = await readOdt(bytes);
		const at = model.blocks.findIndex((b) => b.type === 'paragraph' && textOf(b) === 'Second step');
		model.blocks.splice(at + 1, 0, {
			type: 'paragraph',
			style: 'normal',
			list: { kind: 'number', level: 0 },
			content: [{ type: 'text', text: 'Third step', marks: {} }]
		});
		const out = await writeOdt(model, bytes);
		const after = await content(out);
		expect(after).toContain('<text:p text:style-name="P3">First step</text:p>');
		const back = (await readOdt(out)).model;
		expect(
			paras(back)
				.filter((p) => p.list?.kind === 'number')
				.map(textOf)
		).toEqual(['First step', 'Second step', 'Third step']);
	});

	it('round-trips every kind of edit from scratch', async () => {
		const model: DocModel = {
			blocks: [
				{ type: 'paragraph', style: 'title', content: [{ type: 'text', text: 'T', marks: {} }] },
				{
					type: 'paragraph',
					style: 'h2',
					align: 'center',
					content: [{ type: 'text', text: 'H', marks: {} }]
				},
				{
					type: 'paragraph',
					style: 'normal',
					align: 'right',
					content: [
						{ type: 'text', text: 'b', marks: { bold: true } },
						{ type: 'text', text: 'i', marks: { italic: true } },
						{ type: 'text', text: 'u', marks: { underline: true } },
						{ type: 'text', text: 's', marks: { strike: true } },
						{ type: 'text', text: 'c', marks: { code: true } },
						{ type: 'text', text: 'f', marks: { font: 'Georgia', size: 14 } },
						{ type: 'text', text: 'k', marks: { color: '#c00000', highlight: '#ffff00' } },
						{ type: 'text', text: 'l', marks: { link: 'https://example.org/x' } },
						{ type: 'text', text: 'two  spaces\tand a tab', marks: {} },
						{ type: 'break' },
						{ type: 'text', text: 'after', marks: {} }
					]
				},
				{ type: 'paragraph', style: 'quote', content: [{ type: 'text', text: 'q', marks: {} }] },
				{ type: 'paragraph', style: 'code', content: [{ type: 'text', text: 'x = 1', marks: {} }] },
				{
					type: 'paragraph',
					style: 'normal',
					list: { kind: 'bullet', level: 0 },
					content: [{ type: 'text', text: 'a', marks: {} }]
				},
				{
					type: 'paragraph',
					style: 'normal',
					list: { kind: 'bullet', level: 1 },
					content: [{ type: 'text', text: 'b', marks: {} }]
				},
				{
					type: 'paragraph',
					style: 'normal',
					list: { kind: 'bullet', level: 0 },
					content: [{ type: 'text', text: 'c', marks: {} }]
				},
				{
					type: 'paragraph',
					style: 'normal',
					content: [{ type: 'text', text: 'between', marks: {} }]
				},
				{
					type: 'paragraph',
					style: 'normal',
					list: { kind: 'number', level: 0 },
					content: [{ type: 'text', text: 'one', marks: {} }]
				},
				{ type: 'paragraph', style: 'normal', content: [] },
				{
					type: 'paragraph',
					style: 'normal',
					list: { kind: 'check', level: 0, checked: true },
					content: [{ type: 'text', text: 'done', marks: {} }]
				},
				{
					type: 'table',
					rows: [
						{
							cells: [
								{
									content: [
										{
											type: 'paragraph',
											style: 'normal',
											content: [{ type: 'text', text: 'A1', marks: {} }]
										}
									],
									header: true
								},
								{ content: [{ type: 'paragraph', style: 'normal', content: [] }], header: true }
							]
						},
						{
							cells: [
								{
									content: [
										{
											type: 'paragraph',
											style: 'normal',
											content: [{ type: 'text', text: 'B1', marks: {} }]
										}
									]
								},
								{
									content: [
										{
											type: 'paragraph',
											style: 'normal',
											content: [{ type: 'text', text: 'B2', marks: {} }]
										}
									]
								}
							]
						}
					]
				},
				{
					type: 'paragraph',
					style: 'normal',
					content: [{ type: 'image', image: 'new:1', alt: 'dot', width: 24, height: 16 }]
				}
			],
			images: { 'new:1': { mime: 'image/png', bytes: fixture('docs/pixel.png') } }
		};
		const out = await writeOdt(model);
		expect(readZip(out).entries[0]).toMatchObject({ name: 'mimetype', method: 0 });
		const back = (await readOdt(out)).model;
		const strip = (v: unknown) =>
			JSON.parse(JSON.stringify(v, (k, x) => (k === 'ref' || k === 'image' ? undefined : x)));
		expect(strip(back.blocks)).toEqual(strip(model.blocks));
		const again = await writeOdt(back, out);
		expectUntouched(out, again, []);
	});

	it('locks what it cannot edit and keeps it', async () => {
		const xml = `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text><text:p>Plain</text:p><text:p>Note<text:note text:id="n1"><text:note-body><text:p>Body</text:p></text:note-body></text:note></text:p><text:p>Date <text:date>today</text:date></text:p></office:text></office:body></office:document-content>`;
		const bytes = await writeZip(null, [
			{
				name: 'mimetype',
				data: enc.encode('application/vnd.oasis.opendocument.text'),
				store: true
			},
			{ name: 'content.xml', data: enc.encode(xml) }
		]);
		const { model, census } = await readOdt(bytes);
		expect(model.blocks.map((b) => b.type)).toEqual(['paragraph', 'locked', 'locked']);
		expect(census.items.map((i) => i.label).sort()).toEqual(['Field', 'Footnote']);
		(model.blocks[0] as Paragraph).content = [{ type: 'text', text: 'Edited', marks: {} }];
		const out = await content(await writeOdt(model, bytes));
		expect(out).toContain('<text:p>Note<text:note text:id="n1">');
		expect(out).toContain('<text:p>Date <text:date>today</text:date></text:p>');
	});

	it('names a picture added to a saved file apart from those already there', async () => {
		const a = fixture('docs/pixel.png');
		const b = new Uint8Array([...a, 0]);
		const para = (image: string): Paragraph => ({
			type: 'paragraph',
			style: 'normal',
			content: [{ type: 'image', image, alt: image }]
		});
		const saved = await writeOdt({
			blocks: [para('new:1')],
			images: { 'new:1': { mime: 'image/png', bytes: a } }
		});
		const back = (await readOdt(saved)).model;
		back.blocks.push(para('new:2'));
		back.images['new:2'] = { mime: 'image/png', bytes: b };
		const again = await writeOdt(back, saved);
		const read = (await readOdt(again)).model;
		const keys = paras(read).flatMap((p) =>
			p.content.flatMap((i) => (i.type === 'image' ? [i.image] : []))
		);
		expect(new Set(keys).size).toBe(2);
		expect(keys.map((k) => read.images[k].bytes)).toEqual([a, b]);
		const manifest = decodeXml(await entryData(readZip(again).get('META-INF/manifest.xml')!));
		const paths = [...manifest.matchAll(/full-path="([^"]+)"/g)].map((m) => m[1]);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it('gives new text a span style of others only when it says no more than its marks', async () => {
		const saved = await writeOdt({
			blocks: [
				{ type: 'paragraph', style: 'normal', content: [{ type: 'text', text: 'x', marks: {} }] }
			],
			images: {}
		});
		const xml = (await content(saved))
			.replace(
				/<office:automatic-styles\/>|<office:automatic-styles>[\s\S]*?<\/office:automatic-styles>/,
				'<office:automatic-styles>' +
					'<style:style style:name="B" style:family="text"><style:text-properties fo:font-weight="bold" style:font-weight-asian="bold"/></style:style>' +
					'<style:style style:name="Sup" style:family="text"><style:text-properties fo:font-style="italic" style:text-position="super 58%"/></style:style>' +
					'</office:automatic-styles>'
			)
			.replace(
				/<text:p [^>]*>x<\/text:p>/,
				'<text:p text:style-name="Standard"><text:span text:style-name="B">bold </text:span><text:span text:style-name="Sup">sup</text:span></text:p>'
			);
		const bytes = await writeZip(readZip(saved), [{ name: 'content.xml', data: enc.encode(xml) }]);
		const { model } = await readOdt(bytes);
		paras(model)[0].content.push(
			{ type: 'text', text: ' more bold', marks: { bold: true } },
			{ type: 'text', text: ' more italic', marks: { italic: true } }
		);
		const out = await content(await writeOdt(model, bytes));
		expect(out.split('text:style-name="B"').length).toBe(3);
		expect(out.split('text:style-name="Sup"').length).toBeLessThanOrEqual(2);
		expect(textOf(paras((await readOdt(await writeOdt(model, bytes))).model)[0])).toBe(
			'bold sup more bold more italic'
		);
	});

	it('keeps a superscript and a subscript when its paragraph is edited', async () => {
		const saved = await writeOdt({
			blocks: [
				{ type: 'paragraph', style: 'normal', content: [{ type: 'text', text: 'x', marks: {} }] }
			],
			images: {}
		});
		const xml = (await content(saved))
			.replace(
				/<office:automatic-styles\/>|<office:automatic-styles>[\s\S]*?<\/office:automatic-styles>/,
				'<office:automatic-styles>' +
					'<style:style style:name="Up" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>' +
					'<style:style style:name="Dn" style:family="text"><style:text-properties style:text-position="-33% 58%"/></style:style>' +
					'</office:automatic-styles>'
			)
			.replace(
				/<text:p [^>]*>x<\/text:p>/,
				'<text:p text:style-name="Standard">m<text:span text:style-name="Up">2</text:span> H<text:span text:style-name="Dn">2</text:span>O</text:p>'
			);
		const bytes = await writeZip(readZip(saved), [{ name: 'content.xml', data: enc.encode(xml) }]);
		const { model } = await readOdt(bytes);
		const p = paras(model)[0];
		expect(p.content.map((i) => i.type === 'text' && i.marks.script)).toEqual([
			undefined,
			'super',
			undefined,
			'sub',
			undefined
		]);
		p.content.push({ type: 'text', text: '!', marks: {} });
		const out = await writeOdt(model, bytes);
		const back = paras((await readOdt(out)).model)[0];
		expect(back.content.map((i) => i.type === 'text' && i.marks.script)).toEqual([
			undefined,
			'super',
			undefined,
			'sub',
			undefined
		]);
		expect(await content(out)).toContain('style:text-position="super 58%"');
	});

	it('makes a template that reads back empty', async () => {
		expect((await readOdt(await odtTemplate())).model.blocks).toEqual([]);
	});

	it('rejects what is not a text document', async () => {
		await expect(readOdt(enc.encode('nope'))).rejects.toThrow();
		const sheet = await writeZip(null, [
			{
				name: 'content.xml',
				data: enc.encode(
					'<office:document-content><office:body><office:spreadsheet/></office:body></office:document-content>'
				)
			}
		]);
		await expect(readOdt(sheet)).rejects.toThrow();
	});
});
