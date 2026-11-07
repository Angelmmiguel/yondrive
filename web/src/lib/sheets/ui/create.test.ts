import { describe, expect, it } from 'vitest';
import { readSpreadsheet } from '$lib/formats/spreadsheet';
import { emptyWorkbook } from './create';

describe('a new spreadsheet', () => {
	it('is an .xlsx with one empty sheet', async () => {
		const bytes = await emptyWorkbook();
		expect(new TextDecoder().decode(bytes.subarray(0, 2))).toBe('PK');
		const { book } = await readSpreadsheet(bytes, 'xlsx');
		expect(book.engine.sheets.map((s) => s.name)).toEqual(['Sheet1']);
		expect([...book.engine.cells(book.engine.sheets[0].id)]).toEqual([]);
	});
});
