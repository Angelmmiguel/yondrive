/**
 * Malformed and hostile spreadsheets: every reader either returns a workbook or
 * throws an Error, and never hangs or runs away with memory. The generator is
 * seeded, so a failure reproduces.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sampleOds, sampleXls, xlsxOf } from '../../../tests/fixtures/sheet-samples';
import { CSV_LIMITS, readCsv } from './csv';
import { readOds } from './ods';
import { readSpreadsheet, type SheetFormat } from './spreadsheet';
import { readXls } from './xls';
import { readXlsx, SHEET_LIMITS } from './xlsx';
import { entryData, readZip, writeZip } from './zip';

const fixture = (n: string) =>
	new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/${n}`, import.meta.url)));

function rng(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

function mutate(src: Uint8Array, r: () => number): Uint8Array {
	const out = src.slice();
	const kind = Math.floor(r() * 4);
	if (kind === 0) {
		for (let i = 0; i < 1 + r() * 20; i++)
			out[Math.floor(r() * out.length)] = Math.floor(r() * 256);
		return out;
	}
	if (kind === 1) return out.subarray(0, Math.floor(r() * out.length));
	if (kind === 2) {
		const at = Math.floor(r() * out.length);
		out.copyWithin(
			at,
			Math.floor(r() * out.length),
			Math.floor(r() * out.length) + Math.floor(r() * 64)
		);
		return out;
	}
	const extra = new Uint8Array(Math.floor(r() * 256)).map(() => Math.floor(r() * 256));
	const at = Math.floor(r() * out.length);
	const joined = new Uint8Array(out.length + extra.length);
	joined.set(out.subarray(0, at));
	joined.set(extra, at);
	joined.set(out.subarray(at), at + extra.length);
	return joined;
}

/** XML parts damaged after decompression and recompressed honestly, so the parsers see them. */
async function mutateInside(src: Uint8Array, r: () => number): Promise<Uint8Array> {
	const zip = readZip(src);
	const changes = [];
	for (const e of zip.entries) {
		if (!e.name.endsWith('.xml') || r() > 0.5) continue;
		changes.push({ name: e.name, data: mutate(await entryData(e), r) });
	}
	return writeZip(zip, changes);
}

const cases: [SheetFormat, () => Promise<Uint8Array> | Uint8Array][] = [
	['xlsx', () => fixture('book.xlsx')],
	['ods', () => sampleOds()],
	['xls', () => sampleXls()],
	['csv', () => new TextEncoder().encode('a,"b\n""c""",1\r\n2,3.5,=A1\n')]
];

describe('damaged spreadsheets', () => {
	for (const [format, load] of cases) {
		it(`${format}: random damage gives a workbook or an error`, async () => {
			const base = await load();
			const r = rng(format.length * 7919 + base.length);
			for (let i = 0; i < 150; i++) {
				let input = mutate(base, r);
				if ((format === 'xlsx' || format === 'ods') && i % 2 === 0) {
					input = await mutateInside(base, r).catch(() => input);
				}
				try {
					const out = await readSpreadsheet(input, format);
					expect(out.book.engine.sheets.length).toBeGreaterThanOrEqual(0);
				} catch (e) {
					expect(e).toBeInstanceOf(Error);
				}
			}
		}, 60_000);
	}
});

describe('hostile spreadsheets', () => {
	it('stops at the cell limit', async () => {
		const row = (r: number) =>
			`<row r="${r}">${Array.from({ length: 10 }, (_, c) => `<c r="${String.fromCharCode(65 + c)}${r}"><v>1</v></c>`).join('')}</row>`;
		const bytes = await xlsxOf([
			`<sheetData>${Array.from({ length: 30 }, (_, i) => row(i + 1)).join('')}</sheetData>`
		]);
		const saved = SHEET_LIMITS.cells;
		SHEET_LIMITS.cells = 100;
		try {
			await expect(readXlsx(bytes)).rejects.toThrow(/too many cells/);
		} finally {
			SHEET_LIMITS.cells = saved;
		}
	});

	it('refuses rows and cells out of order or off the grid', async () => {
		for (const data of [
			'<row r="2"/><row r="1"/>',
			'<row r="1"><c r="B1"/><c r="A1"/></row>',
			'<row r="1048577"/>',
			'<row r="1"><c r="A2"/></row>',
			'<c r="A1"/>'
		]) {
			await expect(
				readXlsx(await xlsxOf([`<sheetData>${data}</sheetData>`])),
				data
			).rejects.toThrow();
		}
	});

	it('refuses nesting past the XML limit', async () => {
		const deep = '<sheetData>' + '<x>'.repeat(300) + '</x>'.repeat(300) + '</sheetData>';
		await expect(readXlsx(await xlsxOf([deep]))).rejects.toThrow(/deep/);
	});

	it('does not expand a run of a million rows with a value in them', async () => {
		const ods = await sampleOds();
		const zip = readZip(ods);
		const content = new TextDecoder().decode(await entryData(zip.get('content.xml')!));
		const hostile = content.replace(
			'table:number-rows-repeated="1048571"><table:table-cell table:number-columns-repeated="3"/>',
			'table:number-rows-repeated="1048571"><table:table-cell table:number-columns-repeated="16384" office:value-type="float" office:value="1"/>'
		);
		const bytes = await writeZip(zip, [
			{ name: 'content.xml', data: new TextEncoder().encode(hostile) }
		]);
		const t = Date.now();
		await expect(readOds(bytes)).rejects.toThrow(/too many cells/);
		expect(Date.now() - t).toBeLessThan(5000);
	});

	it('keeps formulas within Excel’s length and nesting', async () => {
		const long = `<sheetData><row r="1"><c r="A1"><f>${'1+'.repeat(5000)}1</f><v>1</v></c><c r="B1"><f>${'('.repeat(400)}1${')'.repeat(400)}</f><v>1</v></c></row></sheetData>`;
		const { book } = await readXlsx(await xlsxOf([long]));
		const s = book.engine.sheets[0].id;
		expect(book.engine.cell(s, 0, 0)!.formula!.status).toBe('invalid');
		expect(book.engine.cell(s, 0, 1)!.formula!.status).toBe('invalid');
		expect(book.engine.cell(s, 0, 0)!.value).toBe(1);
	});

	it('refuses an oversized text file and over-long fields', () => {
		expect(() => readCsv(new Uint8Array(CSV_LIMITS.size + 1))).toThrow(/too large/);
		expect(() => readCsv(new TextEncoder().encode('x'.repeat(40000)))).toThrow(/field too long/);
	});

	it('refuses an .xls whose records run past the stream', () => {
		const bytes = sampleXls();
		expect(() => readXls(bytes.subarray(0, 600))).toThrow(Error);
	});
});
