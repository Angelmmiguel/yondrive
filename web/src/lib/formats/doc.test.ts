import { describe, expect, it } from 'vitest';
import { makeDoc, sampleDoc } from '../../../tests/fixtures/doc-sample';
import { readCfb, writeCfb } from './cfb';
import { readDoc } from './doc';
import { plainText, type Paragraph } from './model';

describe('cfb', () => {
	it('reads back what it writes, mini stream and regular sectors both', () => {
		const small = new Uint8Array(100).map((_, i) => i);
		const big = new Uint8Array(9000).map((_, i) => i % 251);
		const f = readCfb(
			writeCfb([
				{ name: 'Small', data: small },
				{ name: 'Big', data: big }
			])
		);
		expect(f.names().sort()).toEqual(['Big', 'Small']);
		expect(f.get('Small')).toEqual(small);
		expect(f.get('Big')).toEqual(big);
	});

	it('refuses loops and garbage', () => {
		const file = writeCfb([{ name: 'Big', data: new Uint8Array(9000) }]);
		// Point the first FAT entry of the stream at itself.
		const fatSector = new DataView(file.buffer).getUint32(0x4c, true);
		const fatAt = (fatSector + 1) * 512;
		const looped = file.slice();
		new DataView(looped.buffer).setUint32(fatAt + 4, 1, true);
		expect(() => readCfb(looped).get('Big')).toThrow();
		expect(() => readCfb(new Uint8Array(600))).toThrow();
	});
});

describe('doc', () => {
	it('reads text and basic formatting from the synthetic sample', () => {
		const { model, census } = readDoc(sampleDoc());
		const ps = model.blocks.filter((b): b is Paragraph => b.type === 'paragraph');
		expect(ps[0]).toMatchObject({
			style: 'h1',
			content: [{ type: 'text', text: 'Imported heading', marks: {} }]
		});
		expect(ps[1].align).toBe('center');
		expect(ps[1].content).toContainEqual({ type: 'text', text: 'bold', marks: { bold: true } });
		expect(ps[1].content).toContainEqual({ type: 'text', text: 'italic', marks: { italic: true } });
		expect(ps[2]).toMatchObject({ list: { kind: 'bullet', level: 0 } });
		const table = model.blocks.find((b) => b.type === 'table');
		expect(table && table.type === 'table' && table.rows.length).toBe(1);
		expect(plainText(model)).toContain('Wide characters: café ✓');
		expect(ps.at(-1)!.content).toContainEqual({ type: 'text', text: 'big', marks: { size: 18 } });
		expect(census.items.some((i) => i.label.startsWith('Converted to .docx'))).toBe(true);
	});

	it('links the result of a hyperlink field, and stays quick with fields nested deep', () => {
		const linked = readDoc(
			makeDoc([
				{
					runs: [
						{
							text: 'see \u0013 HYPERLINK "https://example.org" \u0014the \u0013 PAGE \u00141\u0015 page\u0015 now'
						}
					]
				}
			])
		).model.blocks[0] as Paragraph;
		expect(linked.content).toEqual([
			{ type: 'text', text: 'see ', marks: {} },
			{ type: 'text', text: 'the 1 page', marks: { link: 'https://example.org' } },
			{ type: 'text', text: ' now', marks: {} }
		]);
		const deep = makeDoc([{ runs: [{ text: '\u0013x\u0014y'.repeat(30000) }] }]);
		const started = performance.now();
		const { model } = readDoc(deep);
		expect(performance.now() - started).toBeLessThan(1000);
		// Past the depth kept, a field's instructions are read as text.
		expect(plainText(model)).toBe('y'.repeat(32) + 'xy'.repeat(30000 - 32));
	});

	it('refuses what it cannot read', () => {
		expect(() => readDoc(writeCfb([{ name: 'Other', data: new Uint8Array(10) }]))).toThrow();
		const doc = makeDoc([{ runs: [{ text: 'x' }] }], 1);
		const f = readCfb(doc);
		const word = f.get('WordDocument')!.slice();
		word[0x0a] |= 0x01;
		word[0x0b] |= 0x01;
		expect(() =>
			readDoc(
				writeCfb([
					{ name: 'WordDocument', data: word },
					{ name: '1Table', data: f.get('1Table')! }
				])
			)
		).toThrow(/password/);
	});
});
