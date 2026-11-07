import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plainText, type DocModel, type Paragraph } from './model';
import { readRtf, writeRtf } from './rtf';

const fixture = (n: string) =>
	new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/${n}`, import.meta.url)));
const paras = (m: DocModel) => m.blocks.filter((b): b is Paragraph => b.type === 'paragraph');
const enc = new TextEncoder();

describe('rtf', () => {
	it('reads the pandoc sample', () => {
		const { model } = readRtf(fixture('docs/sample.rtf'));
		const ps = paras(model);
		const text = plainText(model);
		expect(text).toContain('Quarterly notes');
		expect(ps.find((p) => plainText({ blocks: [p] }) === 'Quarterly notes')?.style).toBe('h1');
		const all = ps.flatMap((p) => p.content);
		expect(all).toContainEqual({ type: 'text', text: 'trust', marks: { bold: true } });
		expect(all).toContainEqual({ type: 'text', text: 'speed', marks: { italic: true } });
		expect(all.find((i) => i.type === 'text' && i.marks.link)).toMatchObject({
			marks: { link: 'https://example.org/plan' }
		});
		expect(model.blocks.some((b) => b.type === 'table')).toBe(true);
		expect(text).toContain('Closing paragraph');
	});

	it('decodes code pages and unicode escapes', () => {
		const src = "{\\rtf1\\ansi\\ansicpg1252\\uc1 caf\\'e9 \\u8212? end\\par}";
		expect(plainText(readRtf(enc.encode(src)).model)).toBe('café — end');
	});

	it('round-trips every kind of edit', async () => {
		const model: DocModel = {
			blocks: [
				{ type: 'paragraph', style: 'h1', content: [{ type: 'text', text: 'Head', marks: {} }] },
				{
					type: 'paragraph',
					style: 'normal',
					align: 'center',
					content: [
						{ type: 'text', text: 'b', marks: { bold: true } },
						{ type: 'text', text: 'i', marks: { italic: true } },
						{ type: 'text', text: 'u', marks: { underline: true } },
						{ type: 'text', text: 's', marks: { strike: true } },
						{ type: 'text', text: 'c', marks: { code: true } },
						{ type: 'text', text: 'f', marks: { font: 'Georgia', size: 14 } },
						{ type: 'text', text: 'k', marks: { color: '#c00000', highlight: '#ffff00' } },
						{ type: 'text', text: 'l', marks: { link: 'https://example.org/' } },
						{ type: 'text', text: ' {braces} \\ é ✓', marks: {} },
						{ type: 'break' },
						{ type: 'text', text: 'after', marks: {} }
					]
				},
				{ type: 'paragraph', style: 'quote', content: [{ type: 'text', text: 'q', marks: {} }] },
				{
					type: 'paragraph',
					style: 'normal',
					list: { kind: 'bullet', level: 0 },
					content: [{ type: 'text', text: 'a', marks: {} }]
				},
				{
					type: 'paragraph',
					style: 'normal',
					list: { kind: 'number', level: 1 },
					content: [{ type: 'text', text: 'n', marks: {} }]
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
											content: [{ type: 'text', text: 'A1', marks: {} }]
										}
									]
								},
								{
									content: [
										{
											type: 'paragraph',
											style: 'normal',
											content: [{ type: 'text', text: 'A2', marks: {} }]
										}
									]
								}
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
								{ content: [{ type: 'paragraph', style: 'normal', content: [] }] }
							]
						}
					]
				},
				{
					type: 'paragraph',
					style: 'normal',
					content: [{ type: 'image', image: 'x', alt: '', width: 24, height: 16 }]
				},
				{ type: 'paragraph', style: 'normal', content: [{ type: 'text', text: 'end', marks: {} }] }
			],
			images: { x: { mime: 'image/png', bytes: fixture('docs/pixel.png') } }
		};
		const back = readRtf(await writeRtf(model)).model;
		const strip = (v: unknown) =>
			JSON.parse(JSON.stringify(v, (k, x) => (k === 'ref' || k === 'image' ? undefined : x)));
		expect(strip(back.blocks)).toEqual(strip(model.blocks));
		expect(Object.values(back.images)[0].bytes).toEqual(model.images.x.bytes);
	});

	it('rejects deep nesting and what is not RTF', () => {
		expect(() =>
			readRtf(enc.encode('{\\rtf1' + '{'.repeat(1000) + 'x' + '}'.repeat(1000) + '}'))
		).toThrow();
		expect(() => readRtf(enc.encode('plain'))).toThrow();
	});
});
