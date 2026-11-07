import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	CAPS,
	formatOf,
	noticeOf,
	readDocument,
	renameTo,
	saveFormatOf,
	writeDocument
} from './document';
import { plainText } from './model';
import { sampleDoc } from '../../../tests/fixtures/doc-sample';

const fixture = (n: string) =>
	new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/${n}`, import.meta.url)));

describe('document', () => {
	it('knows formats by name, and where each is saved', () => {
		expect(formatOf('a.DOCX')).toBe('docx');
		expect(formatOf('notes.markdown')).toBe('md');
		expect(formatOf('x.pages')).toBeNull();
		expect(formatOf('x.numbers')).toBeNull();
		expect(formatOf('noext')).toBeNull();
		expect(saveFormatOf('doc')).toBe('docx');
		expect(renameTo('Report.final.doc', 'docx')).toBe('Report.final.docx');
		expect(CAPS.txt.marks.size).toBe(0);
		expect(CAPS.md.marks.has('underline')).toBe(false);
	});

	it('writes the same text into every format', async () => {
		const { model } = await readDocument(fixture('docs/sample.docx'), 'docx');
		const text = plainText(model);
		for (const f of ['docx', 'odt', 'rtf', 'md'] as const) {
			const out = await writeDocument(f, model);
			const back = plainText((await readDocument(out, f)).model);
			expect(back.replace(/\s+/g, ' ')).toContain('Sync large folders without stalls.');
			expect(back.length).toBeGreaterThan(text.length / 2);
		}
	});

	it('converts .doc to .docx', async () => {
		const { model } = await readDocument(sampleDoc(), 'doc');
		const out = await writeDocument('docx', model, { bytes: sampleDoc(), format: 'doc' });
		expect(plainText((await readDocument(out, 'docx')).model)).toContain('Imported heading');
	});

	it('generates the notice from what the file holds', async () => {
		const { census } = await readDocument(fixture('report.docx'), 'docx');
		const n = noticeOf('docx', census);
		expect(n.summary).toContain('.docx');
		expect(n.lines.join(' ')).toMatch(/not editable here.*tracked change/i);
		expect(noticeOf('docx', { items: [] }).lines).toEqual([]);
	});
});
