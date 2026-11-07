import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sampleOds, sampleXls } from '../../../tests/fixtures/sheet-samples';
import {
	lostOnSave,
	readSpreadsheet,
	renameSheetFile,
	sheetFormatOf,
	sheetNoticeOf,
	sheetSaveFormatOf,
	sniffSheetFormat,
	writeSpreadsheet
} from './spreadsheet';

const fixture = (n: string) =>
	new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/${n}`, import.meta.url)));

describe('spreadsheet formats', () => {
	it('knows formats by name and by their bytes', async () => {
		expect(sheetFormatOf('Budget.XLSX')).toBe('xlsx');
		expect(sheetFormatOf('a.tab')).toBe('tsv');
		expect(sheetFormatOf('notes.txt')).toBeNull();
		expect(sheetSaveFormatOf('xls')).toBe('xlsx');
		expect(renameSheetFile('old.xls', 'xlsx')).toBe('old.xlsx');
		expect(sniffSheetFormat(fixture('book.xlsx'))).toBe('xlsx');
		expect(sniffSheetFormat(await sampleOds())).toBe('ods');
		expect(sniffSheetFormat(sampleXls())).toBe('xls');
		expect(sniffSheetFormat(new TextEncoder().encode('a,b'))).toBeNull();
	});

	it('writes into the original only in the same format', async () => {
		const bytes = fixture('book.xlsx');
		const { book } = await readSpreadsheet(bytes, 'xlsx');
		const same = await writeSpreadsheet('xlsx', book, { original: { bytes, format: 'xlsx' } });
		expect(Buffer.from(same).equals(Buffer.from(bytes))).toBe(true);
		const csv = new TextDecoder().decode(
			await writeSpreadsheet('csv', book, { original: { bytes, format: 'xlsx' } })
		);
		expect(csv.split('\r\n')[1]).toBe('Alpha,20.00 EUR,40.00');
		const ods = await readSpreadsheet(await writeSpreadsheet('ods', book), 'ods');
		expect(ods.book.engine.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Notes']);
	});

	it('says what a file holds and what another format would drop', async () => {
		const { book, census } = await readSpreadsheet(fixture('book.xlsx'), 'xlsx');
		const notice = sheetNoticeOf('xlsx', census);
		expect(notice.summary).toMatch(/saved back as \.xlsx/);
		expect(notice.lines[0]).toMatch(
			/^Shown with the value the file had, not editable here, and kept as it was: formula not calculated here\.$/
		);
		expect(notice.lines[1]).toMatch(/^Kept in the file but not shown: chart, /);
		expect(lostOnSave(book, 'csv')).toEqual([
			'Every sheet but the current one',
			'Formulas, which are saved as their values',
			'Formatting, merged cells and column widths'
		]);
		const xls = await readSpreadsheet(sampleXls(), 'xls');
		expect(sheetNoticeOf('xls', xls.census).lines).toContain('Formula kept as its last value.');
	});
});
