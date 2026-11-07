import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { docxTemplate, readDocx, writeDocx } from './docx';
import { normalizeInlines, plainText, type Block, type DocModel, type Paragraph } from './model';
import { decodeXml } from './xml';
import { entryData, readZip, writeZip } from './zip';

const fixture = (n: string) =>
	new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/${n}`, import.meta.url)));

async function part(bytes: Uint8Array, name: string): Promise<string> {
	return decodeXml(await entryData(readZip(bytes).get(name)!));
}

const paras = (m: DocModel) => m.blocks.filter((b): b is Paragraph => b.type === 'paragraph');
const normalize = (c: Paragraph['content']) => normalizeInlines(c);
const textOf = (b: Block) => plainText({ blocks: [b] });

/** Every entry but `except` has the same local record, compressed bytes included. */
function expectUntouched(before: Uint8Array, after: Uint8Array, except: string[]) {
	const a = readZip(before);
	const b = readZip(after);
	for (const e of a.entries) {
		if (except.includes(e.name)) continue;
		expect(b.get(e.name)?.local, e.name).toEqual(e.local);
	}
}

/** The longest common prefix and suffix of two strings: what changed lies between. */
function window(a: string, b: string) {
	let s = 0;
	while (s < a.length && s < b.length && a[s] === b[s]) s++;
	let e = 0;
	while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
	return { before: a.slice(s, a.length - e), after: b.slice(s, b.length - e) };
}

describe('docx', () => {
	it('reads the pandoc sample into the model', async () => {
		const { model, census } = await readDocx(fixture('docs/sample.docx'));
		const ps = paras(model);
		expect(ps[0]).toMatchObject({ style: 'h1' });
		expect(textOf(ps[0])).toBe('Quarterly notes');
		const first = ps[1].content;
		expect(first).toContainEqual({ type: 'text', text: 'trust', marks: { bold: true } });
		expect(first).toContainEqual({ type: 'text', text: 'speed', marks: { italic: true } });
		expect(first).toContainEqual({ type: 'text', text: 'noise', marks: { strike: true } });
		expect(first.find((i) => i.type === 'text' && i.marks.link)).toMatchObject({
			text: 'project page',
			marks: { link: 'https://example.org/plan' }
		});
		const bullets = ps.filter((p) => p.list?.kind === 'bullet');
		expect(bullets.map((p) => p.list?.level)).toEqual([0, 0, 1, 0]);
		expect(ps.filter((p) => p.list?.kind === 'number').map(textOf)).toEqual([
			'First step',
			'Second step'
		]);
		expect(ps.filter((p) => p.list?.kind === 'check').map((p) => p.list?.checked)).toEqual([
			false,
			true
		]);
		expect(ps.some((p) => p.style === 'quote')).toBe(true);
		expect(ps.filter((p) => p.style === 'code').length).toBeGreaterThan(0);
		const table = model.blocks.find((b) => b.type === 'table');
		expect(table && table.type === 'table' && table.rows.length).toBe(3);
		const image = ps.flatMap((p) => p.content).find((i) => i.type === 'image');
		expect(image).toMatchObject({ type: 'image', alt: expect.any(String) });
		expect(model.images[(image as { image: string }).image].mime).toBe('image/png');
		expect(ps.flatMap((p) => p.content).some((i) => i.type === 'text' && i.marks.code)).toBe(true);
		expect(census.items.filter((i) => i.handling === 'locked')).toEqual([]);
	});

	it('writes an unedited document back with every entry untouched', async () => {
		for (const name of ['docs/sample.docx', 'report.docx']) {
			const bytes = fixture(name);
			const { model } = await readDocx(bytes);
			const out = await writeDocx(model, bytes);
			expectUntouched(bytes, out, []);
		}
	});

	it('regenerates only the edited paragraph', async () => {
		const bytes = fixture('docs/sample.docx');
		const { model } = await readDocx(bytes);
		const target = paras(model)[1];
		target.content = [{ type: 'text', text: 'A rewritten paragraph.', marks: {} }];
		const out = await writeDocx(model, bytes);
		expectUntouched(bytes, out, ['word/document.xml']);
		const before = await part(bytes, 'word/document.xml');
		const after = await part(out, 'word/document.xml');
		const { before: was, after: now } = window(before, after);
		expect(now).toContain('A rewritten paragraph');
		expect(was).toContain('trust');
		expect(was).not.toContain('Goals');
		// What was outside the paragraph is exactly what it was.
		const reread = await readDocx(out);
		expect(textOf(paras(reread.model)[1])).toBe('A rewritten paragraph.');
		expect(reread.model.blocks.length).toBe(model.blocks.length);
	});

	it('keeps locked blocks of the hostile report and saves around them', async () => {
		const bytes = fixture('report.docx');
		const { model, census } = await readDocx(bytes);
		const locked = model.blocks.filter((b) => b.type === 'locked');
		expect(locked.length).toBeGreaterThan(0);
		const labels = census.items.filter((i) => i.handling === 'locked').map((i) => i.label);
		expect(labels).toEqual(expect.arrayContaining(['Tracked change', 'Equation']));
		const editable = paras(model).find((p) => textOf(p).length > 0)!;
		editable.content = [{ type: 'text', text: 'Changed next to locked content', marks: {} }];
		const out = await writeDocx(model, bytes);
		const before = await part(bytes, 'word/document.xml');
		const after = await part(out, 'word/document.xml');
		const doc = (await readDocx(out)).model;
		const lockedAfter = doc.blocks.filter((b) => b.type === 'locked');
		expect(lockedAfter.map((b) => b.type === 'locked' && b.text)).toEqual(
			locked.map((b) => b.type === 'locked' && b.text)
		);
		// Only the edited paragraph differs: nothing locked is inside the changed window.
		const { before: was } = window(before, after);
		expect(was).not.toMatch(
			/w:ins|w:del|m:oMath|w:fldChar|w:commentRange|w:footnoteReference|graphicData/
		);
		expectUntouched(bytes, out, ['word/document.xml']);
	});

	it('round-trips every kind of edit', async () => {
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
					align: 'justify',
					content: [
						{ type: 'text', text: 'b', marks: { bold: true } },
						{ type: 'text', text: 'i', marks: { italic: true } },
						{ type: 'text', text: 'u', marks: { underline: true } },
						{ type: 'text', text: 's', marks: { strike: true } },
						{ type: 'text', text: 'c', marks: { code: true } },
						{ type: 'text', text: 'f', marks: { font: 'Georgia', size: 14 } },
						{ type: 'text', text: 'k', marks: { color: '#c00000', highlight: '#ffff00' } },
						{ type: 'text', text: 'h', marks: { highlight: '#123456' } },
						{ type: 'text', text: 'l', marks: { link: 'https://example.org/x' } },
						{ type: 'text', text: 'tab\there', marks: {} },
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
					list: { kind: 'number', level: 0 },
					content: [{ type: 'text', text: 'one', marks: {} }]
				},
				{
					type: 'paragraph',
					style: 'normal',
					list: { kind: 'check', level: 0, checked: true },
					content: [{ type: 'text', text: 'done', marks: {} }]
				},
				{
					type: 'paragraph',
					style: 'normal',
					list: { kind: 'check', level: 0, checked: false },
					content: [{ type: 'text', text: 'todo', marks: {} }]
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
											content: [{ type: 'text', text: 'A1', marks: { bold: true } }]
										}
									]
								},
								{ content: [{ type: 'paragraph', style: 'normal', content: [] }] }
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
		const out = await writeDocx(model);
		const back = (await readDocx(out)).model;
		const strip = (v: unknown) =>
			JSON.parse(JSON.stringify(v, (k, x) => (k === 'ref' || k === 'image' ? undefined : x)));
		expect(strip(back.blocks)).toEqual(strip(model.blocks));
		const img = Object.values(back.images)[0];
		expect(img.bytes).toEqual(model.images['new:1'].bytes);
		// Written again from what was read: nothing changes.
		const again = await writeDocx(back, out);
		expectUntouched(out, again, []);
	});

	it('names a picture added to a saved file apart from those already there', async () => {
		const a = fixture('docs/pixel.png');
		const b = new Uint8Array([...a, 0]);
		const para = (image: string): Paragraph => ({
			type: 'paragraph',
			style: 'normal',
			content: [{ type: 'image', image, alt: image }]
		});
		const saved = await writeDocx({
			blocks: [para('new:1')],
			images: { 'new:1': { mime: 'image/png', bytes: a } }
		});
		const back = (await readDocx(saved)).model;
		back.blocks.push(para('new:2'));
		back.images['new:2'] = { mime: 'image/png', bytes: b };
		const again = await writeDocx(back, saved);
		const read = (await readDocx(again)).model;
		const keys = paras(read).flatMap((p) =>
			p.content.flatMap((i) => (i.type === 'image' ? [i.image] : []))
		);
		expect(new Set(keys).size).toBe(2);
		expect(keys.map((k) => read.images[k].bytes)).toEqual([a, b]);
	});

	it('writes a picture that shares a run with text once, and the text once', async () => {
		const bytes = fixture('docs/sample.docx');
		const xml = (await part(bytes, 'word/document.xml')).replace(
			'<w:r><w:drawing>',
			'<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Zebra </w:t><w:drawing>'
		);
		const mixed = await writeZip(readZip(bytes), [
			{ name: 'word/document.xml', data: new TextEncoder().encode(xml) }
		]);
		const { model } = await readDocx(mixed);
		const p = paras(model).find((x) => x.content.some((i) => i.type === 'image'))!;
		const before = textOf(p);
		expect(before.split('Zebra').length).toBe(2);
		p.content.push({ type: 'text', text: ' after', marks: {} });
		const out = await writeDocx(model, mixed);
		const written = await part(out, 'word/document.xml');
		expect(written.split('Zebra').length).toBe(2);
		expect(written.split('<w:drawing>').length).toBe(2);
		const back = paras((await readDocx(out)).model).find((x) =>
			x.content.some((i) => i.type === 'image')
		)!;
		expect(textOf(back)).toBe(`${before} after`);
		expect(back.content[0]).toEqual({ type: 'text', text: 'Zebra ', marks: { bold: true } });
	});

	it('drops a font whose name is not one', async () => {
		const saved = await writeDocx({
			blocks: [
				{
					type: 'paragraph',
					style: 'normal',
					content: [{ type: 'text', text: 'x', marks: { font: 'Arial' } }]
				}
			],
			images: {}
		});
		expect(paras((await readDocx(saved)).model)[0].content[0]).toMatchObject({
			marks: { font: 'Arial' }
		});
		const xml = (await part(saved, 'word/document.xml')).replaceAll(
			'"Arial"',
			'"Evil&#10;;position:fixed"'
		);
		const evil = await writeZip(readZip(saved), [
			{ name: 'word/document.xml', data: new TextEncoder().encode(xml) }
		]);
		expect(paras((await readDocx(evil)).model)[0].content[0]).toEqual({
			type: 'text',
			text: 'x',
			marks: {}
		});
	});

	/** A document whose one paragraph is `p`. */
	async function withParagraph(p: string): Promise<Uint8Array> {
		const saved = await writeDocx({
			blocks: [
				{ type: 'paragraph', style: 'normal', content: [{ type: 'text', text: 'x', marks: {} }] }
			],
			images: {}
		});
		const xml = (await part(saved, 'word/document.xml')).replace(/<w:p[ >][\s\S]*?<\/w:p>/, p);
		return writeZip(readZip(saved), [
			{ name: 'word/document.xml', data: new TextEncoder().encode(xml) }
		]);
	}

	it('gives new text the run properties of others only when they say no more than its marks', async () => {
		const bytes = await withParagraph(
			'<w:p><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t>bold </w:t></w:r>' +
				'<w:r><w:rPr><w:i/><w:vertAlign w:val="superscript"/></w:rPr><w:t>sup</w:t></w:r>' +
				'<w:r><w:rPr><w:u w:val="single"/><w:lang w:val="fr-FR"/></w:rPr><w:t> un</w:t></w:r>' +
				'<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>der</w:t></w:r></w:p>'
		);
		const { model } = await readDocx(bytes);
		const p = paras(model)[0];
		p.content.push(
			{ type: 'text', text: ' more bold', marks: { bold: true } },
			{ type: 'text', text: ' more italic', marks: { italic: true } }
		);
		const xml = await part(await writeDocx(model, bytes), 'word/document.xml');
		// The bold run's properties say only what the mark does, so new bold text takes them.
		expect(xml.split('<w:rPr><w:b/><w:bCs/></w:rPr>').length).toBe(3);
		// A superscript or a language is never carried to other text.
		expect(xml.split('superscript').length).toBeLessThanOrEqual(2);
		expect(xml.split('fr-FR').length).toBeLessThanOrEqual(2);
		const back = paras((await readDocx(await writeDocx(model, bytes))).model)[0];
		expect(textOf(back)).toBe('bold sup under more bold more italic');
	});

	it('keeps a superscript and a subscript when its paragraph is edited', async () => {
		const bytes = await withParagraph(
			'<w:p><w:r><w:t xml:space="preserve">E = mc</w:t></w:r>' +
				'<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r>' +
				'<w:r><w:t xml:space="preserve"> and H</w:t></w:r>' +
				'<w:r><w:rPr><w:b/><w:vertAlign w:val="subscript"/></w:rPr><w:t>2</w:t></w:r>' +
				'<w:r><w:rPr><w:vertAlign w:val="baseline"/></w:rPr><w:t>O</w:t></w:r></w:p>'
		);
		const { model } = await readDocx(bytes);
		const p = paras(model)[0];
		expect(p.content.map((i) => i.type === 'text' && i.marks)).toEqual([
			{},
			{ script: 'super' },
			{},
			{ bold: true, script: 'sub' },
			{}
		]);
		p.content.push({ type: 'text', text: '!', marks: {} });
		const saved = await writeDocx(model, bytes);
		const xml = await part(saved, 'word/document.xml');
		expect(xml).toContain('<w:vertAlign w:val="superscript"/>');
		expect(xml).toContain('<w:vertAlign w:val="subscript"/>');
		const back = paras((await readDocx(saved)).model)[0];
		expect(back.content).toEqual(normalize(p.content));
	});

	it('locks a paragraph whose runs hold what the editor would drop', async () => {
		for (const inner of ['<w:pgNum/>', '<w:footnoteRef/>', '<w:separator/>', '<w:dayLong/>']) {
			const bytes = await withParagraph(`<w:p><w:r><w:t>Page </w:t>${inner}</w:r></w:p>`);
			const { model } = await readDocx(bytes);
			expect(model.blocks[0], inner).toMatchObject({ type: 'locked' });
			expect(await writeDocx(model, bytes)).toEqual(bytes);
		}
	});

	it('makes a minimal document that reads back empty', async () => {
		const t = await docxTemplate();
		expect((await readDocx(t)).model.blocks).toEqual([]);
	});

	it('rejects what is not a Word document', async () => {
		await expect(readDocx(new TextEncoder().encode('nope'))).rejects.toThrow();
		const zip = await writeZip(null, [
			{ name: 'word/document.xml', data: new TextEncoder().encode('<x/>') }
		]);
		await expect(readDocx(zip)).rejects.toThrow();
		const deep =
			'<w:document><w:body>' +
			'<w:p>'.repeat(400) +
			'</w:p>'.repeat(400) +
			'</w:body></w:document>';
		const deepZip = await writeZip(null, [
			{ name: 'word/document.xml', data: new TextEncoder().encode(deep) }
		]);
		await expect(readDocx(deepZip)).rejects.toThrow();
	});
});
