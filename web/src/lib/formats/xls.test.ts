import { describe, expect, it } from 'vitest';
import { err } from '$lib/formula/values';
import {
	bof,
	cell,
	EOF,
	f64,
	rec,
	REL,
	sampleXls,
	str16,
	u16,
	u32,
	xlsOf
} from '../../../tests/fixtures/sheet-samples';
import { writeCfb } from './cfb';
import { readXls, XlsError } from './xls';
import { readXlsx, writeXlsx } from './xlsx';

describe('reading .xls', () => {
	it('reads values, strings, cached results, mapped formulas and formatting', async () => {
		const { book, census } = readXls(sampleXls());
		const e = book.engine;
		expect(e.sheets.map((s) => s.name)).toEqual(['Sheet1']);
		const s = e.sheets[0].id;
		const v = (r: number, c: number) => e.cell(s, r, c)?.value;
		expect(v(0, 0)).toBe('Hello');
		expect(v(0, 1)).toBe('ABCDEFGHIJ');
		expect(v(1, 0)).toBe(1.5);
		expect(v(1, 1)).toBe(100);
		expect(v(2, 0)).toBe(2);
		expect(v(2, 1)).toBe(3.14);
		expect(v(3, 0)).toBe(true);
		expect(v(3, 1)).toEqual(err('#DIV/0!'));
		expect(e.cell(s, 4, 0)!.formula!.text).toBe('A2+B2');
		expect(v(4, 0)).toBe(101.5);
		expect(e.cell(s, 4, 1)!.formula!.text).toBe('SUM(A2:B2)');
		expect(e.cell(s, 4, 2)!.formula!.text).toBe('A1&"!"');
		expect(v(4, 2)).toBe('Hello!');
		expect(e.cell(s, 4, 3)!.formula).toBeUndefined();
		expect(v(4, 3)).toBe(7);
		const a1 = book.styles[e.cell(s, 0, 0)!.style];
		expect(a1.font.bold).toBe(true);
		expect(a1.numFmt).toBe('0.00" EUR"');
		expect(a1.align.h).toBe('center');
		expect(book.styles[e.cell(s, 2, 1)!.style].fill).toBe('#ff0000');
		const info = book.sheet(s);
		expect(info.merges).toEqual([{ top: 5, left: 0, bottom: 5, right: 1 }]);
		expect(book.colWidth(s, 0)).toBe(20);
		expect(info.rows.get(1)?.height).toBe(30);
		const labels = Object.fromEntries(census.items.map((i) => [i.label, [i.count, i.handling]]));
		expect(labels).toMatchObject({
			'Chart sheet': [1, 'lost'],
			Comment: [1, 'lost'],
			'Formula kept as its last value': [1, 'changed']
		});
	});

	it('converts to .xlsx with the formulas and values it read', async () => {
		const { book } = readXls(sampleXls());
		const again = await readXlsx(await writeXlsx(book));
		const e = again.book.engine;
		const s = e.sheets[0].id;
		expect(e.cell(s, 4, 1)!.formula!.text).toBe('SUM(A2:B2)');
		expect(e.cell(s, 4, 2)!.value).toBe('Hello!');
		expect(again.book.styles[e.cell(s, 0, 0)!.style].font.bold).toBe(true);
		expect(again.book.display(e.cell(s, 0, 0))).toBe('Hello');
	});

	it('refuses what it cannot read', () => {
		expect(() => readXls(writeCfb([{ name: 'Book', data: new Uint8Array(600) }]))).toThrow(
			/Excel 5/
		);
		const encrypted = new Uint8Array([...bof(5), ...rec(0x002f, [0, 0]), ...EOF]);
		expect(() => readXls(writeCfb([{ name: 'Workbook', data: encrypted }]))).toThrow(XlsError);
	});
});

describe('damaged .xls', () => {
	it('skips a damaged cell and keeps the rest of the workbook', () => {
		const truncatedLabel = rec(0x0204, [...cell(0, 0, 15), ...u16(10), 0, 0x41, 0x42]);
		const truncatedString = rec(0x0006, [
			...cell(1, 0, 15),
			...f64(7),
			...u16(0),
			...u32(0),
			...u16(4),
			0x17,
			50,
			0,
			0x41
		]);
		const number = rec(0x0203, [...cell(2, 0, 15), ...f64(3)]);
		const { book } = readXls(
			xlsOf([{ name: 'S', body: [...truncatedLabel, ...truncatedString, ...number] }])
		);
		const e = book.engine;
		const s = e.sheets[0].id;
		expect(e.cell(s, 0, 0)).toBeUndefined();
		expect(e.cell(s, 1, 0)!.value).toBe(7);
		expect(e.cell(s, 1, 0)!.formula).toBeUndefined();
		expect(e.cell(s, 2, 0)!.value).toBe(3);
	});
});

describe('references to other sheets in .xls', () => {
	it('counts chart sheets when it reads which sheet a reference names', () => {
		const self = rec(0x01ae, [...u16(3), 0x01, 0x04]);
		// EXTERNSHEET: one entry, this workbook, BOUNDSHEET 1 (Data, after the chart).
		const extern = rec(0x0017, [...u16(1), ...u16(0), ...u16(1), ...u16(1)]);
		const ref3d = rec(0x0006, [
			...cell(0, 0, 15),
			...f64(5),
			...u16(0),
			...u32(0),
			...u16(7),
			0x3a,
			...u16(0),
			...u16(0),
			...u16(0 | REL)
		]);
		const { book } = readXls(
			xlsOf(
				[
					{ name: 'Chart1', type: 2 },
					{ name: 'Data', body: rec(0x0203, [...cell(0, 0, 15), ...f64(5)]) },
					{ name: 'Other', body: ref3d }
				],
				[...self, ...extern]
			)
		);
		const e = book.engine;
		expect(e.sheets.map((s) => s.name)).toEqual(['Data', 'Other']);
		expect(e.cell(e.sheets[1].id, 0, 0)!.formula!.text).toBe('Data!A1');
	});
});

describe('string results of shared formulas in .xls', () => {
	it('keeps the STRING that follows the SHRFMLA record', () => {
		const stringValue = [0, 0, 0, 0, 0, 0, 0xff, 0xff];
		const master = rec(0x0006, [
			...cell(0, 0, 15),
			...stringValue,
			...u16(0),
			...u32(0),
			...u16(5),
			0x01,
			...u16(0),
			...u16(0)
		]);
		// A token not read here, so the cached string is all there is.
		const shrfmla = rec(0x04bc, [...u16(0), ...u16(1), 0, 0, 0, 0, ...u16(1), 0x18]);
		const { book } = readXls(
			xlsOf([{ name: 'S', body: [...master, ...shrfmla, ...rec(0x0207, str16('x'))] }])
		);
		const e = book.engine;
		const c = e.cell(e.sheets[0].id, 0, 0)!;
		expect(c.value).toBe('x');
	});
});
