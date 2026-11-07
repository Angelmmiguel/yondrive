import { describe, expect, it } from 'vitest';
import { fieldValue, parseCsv, readCsv, sniffDelimiter, writeCsv } from './csv';
import { readSpreadsheet, writeSpreadsheet } from './spreadsheet';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('csv', () => {
	it('parses quoted fields with delimiters, quotes and line breaks', () => {
		const recs = parseCsv('a,"b,c","say ""hi""","two\r\nlines"\r\n1,2\n\nlast', ',');
		expect(recs.map((r) => r.fields)).toEqual([
			['a', 'b,c', 'say "hi"', 'two\r\nlines'],
			['1', '2'],
			[''],
			['last']
		]);
	});

	it('tells numbers from text that only looks like them', () => {
		expect(fieldValue('42')).toBe(42);
		expect(fieldValue('-1.5')).toBe(-1.5);
		expect(fieldValue('1e3')).toBe('1e3');
		expect(fieldValue('007')).toBe('007');
		expect(fieldValue('1,5')).toBe('1,5');
		expect(fieldValue('=1+1')).toBe('=1+1');
		expect(fieldValue('')).toBeNull();
	});

	it('finds semicolons and tabs', () => {
		expect(sniffDelimiter('a;b;c\n1;2;3\n')).toBe(';');
		expect(sniffDelimiter('a,b\n1,2\n')).toBe(',');
		expect(sniffDelimiter('a\tb\n1\t2\n')).toBe('\t');
		expect(sniffDelimiter('one\n')).toBe(',');
	});

	it('writes an untouched file back byte for byte, BOM and line endings included', async () => {
		const bytes = new Uint8Array([
			0xef,
			0xbb,
			0xbf,
			...enc.encode('name,qty\r\n"Smith, J",007\r\nx,1.50\r\n')
		]);
		const { book } = readCsv(bytes);
		const out = await writeSpreadsheet('csv', book, { original: { bytes, format: 'csv' } });
		expect(Buffer.from(out).equals(Buffer.from(bytes))).toBe(true);
	});

	it('rewrites only the records that changed', async () => {
		const bytes = enc.encode('a;b\n"x";007\n1;2\n');
		const { book } = readCsv(bytes);
		const s = book.engine.sheets[0].id;
		book.engine.set(s, 2, 1, { value: 'two; or more' });
		book.engine.set(s, 3, 0, { formula: 'A3*3' });
		const out = dec.decode(
			await writeSpreadsheet('csv', book, { original: { bytes, format: 'csv' } })
		);
		expect(out).toBe('a;b\n"x";007\n1;"two; or more"\n3\n');
	});

	it('reads tab-separated values and writes the current sheet only', async () => {
		const { book } = await readSpreadsheet(enc.encode('a\tb\n1\t2\n'), 'tsv');
		const other = book.addSheet('Other');
		book.engine.set(other.id, 0, 0, { value: 'elsewhere' });
		const s = book.engine.sheets[0].id;
		expect(dec.decode(writeCsv(book, s, '\t'))).toBe('a\tb\r\n1\t2\r\n');
		expect(dec.decode(writeCsv(book, other.id, ','))).toBe('elsewhere\r\n');
	});

	it('saves other encodings as UTF-8 and says so', () => {
		const latin = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
		const { book, census } = readCsv(latin);
		expect(book.engine.cell(book.engine.sheets[0].id, 0, 0)!.value).toBe('café');
		expect(census.items[0]).toMatchObject({ handling: 'changed' });
	});
});
