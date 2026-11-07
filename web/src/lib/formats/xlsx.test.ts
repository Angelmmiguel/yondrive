import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { err } from '$lib/formula/values';
import { readXlsx, writeXlsx } from './xlsx';
import { xlsxOf } from '../../../tests/fixtures/sheet-samples';
import { entryData, readZip } from './zip';

const fixture = (n: string) =>
	new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/${n}`, import.meta.url)));

const dec = new TextDecoder();

async function part(bytes: Uint8Array, name: string): Promise<string | null> {
	const e = readZip(bytes).get(name);
	return e ? dec.decode(await entryData(e)) : null;
}

/** Entries whose stored bytes are the same in both packages. */
function sameEntries(a: Uint8Array, b: Uint8Array): string[] {
	const za = readZip(a);
	const zb = readZip(b);
	return za.entries
		.filter((e) => {
			const o = zb.get(e.name);
			return o !== undefined && Buffer.from(o.local).equals(Buffer.from(e.local));
		})
		.map((e) => e.name);
}

describe('reading .xlsx', () => {
	it('reads values, formulas, styles, merges, widths and names', async () => {
		const { book, census, fixedRanges } = await readXlsx(fixture('book.xlsx'));
		const e = book.engine;
		expect(e.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Notes']);
		const s = e.sheets[0].id;
		const at = (r: number, c: number) => e.cell(s, r, c);
		expect(at(0, 0)!.value).toBe('Item');
		expect(at(1, 1)!.value).toBe(20);
		expect(at(1, 2)!.formula!.text).toBe('B2*2');
		expect(at(4, 2)!.formula!.status).toBe('unsupported');
		expect(at(4, 3)!.value).toBe(true);
		expect(at(4, 4)!.value).toEqual(err('#DIV/0!'));
		expect(at(4, 5)!.value).toBe('inline');
		expect(book.display(at(1, 1))).toBe('20.00 EUR');
		expect(book.sheet(s).merges).toEqual([{ top: 0, left: 3, bottom: 0, right: 4 }]);
		expect(book.colWidth(s, 0)).toBe(18);
		expect(e.names).toEqual([
			{ name: 'Amounts', text: 'Sheet1!$B$2:$B$4', key: 0, sheet: undefined }
		]);
		const labels = Object.fromEntries(census.items.map((i) => [i.label, [i.count, i.handling]]));
		expect(labels).toMatchObject({
			Chart: [1, 'kept'],
			Comments: [1, 'kept'],
			'Conditional formatting': [1, 'kept'],
			'Defined name': [1, 'kept'],
			'Formula not calculated here': [1, 'locked']
		});
		expect(fixedRanges).toEqual(['Chart']);
	});

	it('expands shared formulas and calculates what has no cached value', async () => {
		const bytes = await xlsxOf([
			'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*10</f><v>10</v></c></row>' +
				'<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>20</v></c></row>' +
				'<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/></c></row>' +
				'<row r="4"><c r="A4"><f>SUM(B1:B3)</f></c></row></sheetData>'
		]);
		const { book } = await readXlsx(bytes);
		const s = book.engine.sheets[0].id;
		expect(book.engine.cell(s, 2, 1)!.formula!.text).toBe('A3*10');
		expect(book.engine.cell(s, 2, 1)!.value).toBe(30);
		expect(book.engine.cell(s, 3, 0)!.value).toBe(60);
	});

	it('reads rows and cells that leave out their addresses', async () => {
		const bytes = await xlsxOf([
			'<sheetData><row><c><v>1</v></c><c><v>2</v></c></row><row><c t="inlineStr"><is><t>x</t></is></c></row></sheetData>'
		]);
		const { book } = await readXlsx(bytes);
		const s = book.engine.sheets[0].id;
		expect(book.engine.cell(s, 0, 1)!.value).toBe(2);
		expect(book.engine.cell(s, 1, 0)!.value).toBe('x');
	});
});

describe('writing .xlsx back', () => {
	it('writes an untouched workbook back as it was', async () => {
		const original = fixture('book.xlsx');
		const { book } = await readXlsx(original);
		const out = await writeXlsx(book, original);
		expect(Buffer.from(out).equals(Buffer.from(original))).toBe(true);
	});

	it('rewrites the edited cell and its dependents, and nothing else', async () => {
		const original = fixture('book.xlsx');
		const { book } = await readXlsx(original);
		const s = book.engine.sheets[0].id;
		book.engine.set(s, 1, 1, { value: 25 });
		const out = await writeXlsx(book, original);
		const kept = sameEntries(original, out);
		for (const n of [
			'xl/worksheets/sheet2.xml',
			'xl/sharedStrings.xml',
			'xl/styles.xml',
			'xl/charts/chart1.xml',
			'xl/drawings/drawing1.xml',
			'xl/comments1.xml',
			'xl/calcChain.xml',
			'[Content_Types].xml'
		]) {
			expect(kept, n).toContain(n);
		}
		const before = (await part(original, 'xl/worksheets/sheet1.xml'))!;
		const after = (await part(out, 'xl/worksheets/sheet1.xml'))!;
		expect(after).toContain('<c r="B2" s="1"><v>25</v></c>');
		expect(after).toContain('<c r="C2" s="2"><f>B2*2</f><v>50</v></c>');
		expect(after).toContain('<c r="B5" s="1"><f>SUM(B2:B4)</f><v>95</v></c>');
		// Everything else is the original text.
		const strip = (x: string) =>
			x
				.replace(/<c r="B2"[^]*?<\/c>/, '')
				.replace(/<c r="C2"[^]*?<\/c>/, '')
				.replace(/<c r="B5"[^]*?<\/c>/, '');
		expect(strip(after)).toBe(strip(before));
		// XLOOKUP reads B2:B4 and cannot be calculated here: Excel is asked to.
		expect(await part(out, 'xl/workbook.xml')).toContain('<calcPr fullCalcOnLoad="1"/>');
		const again = await readXlsx(out);
		expect(again.book.engine.cell(s, 4, 1)!.value).toBe(95);
	});

	it('appends new text to the shared strings and never changes the old', async () => {
		const original = fixture('book.xlsx');
		const { book } = await readXlsx(original);
		const s = book.engine.sheets[0].id;
		book.engine.set(s, 1, 0, { value: 'Alpha prime' });
		book.engine.set(s, 6, 0, { value: 'Gamma' });
		const out = await writeXlsx(book, original);
		const before = (await part(original, 'xl/sharedStrings.xml'))!;
		const after = (await part(out, 'xl/sharedStrings.xml'))!;
		expect(
			after.startsWith(
				before
					.slice(0, before.indexOf('</sst>'))
					.replace('count="7" uniqueCount="7"', 'count="8" uniqueCount="8"')
			)
		).toBe(true);
		expect(after).toContain('<si><t>Alpha prime</t></si></sst>');
		const sheet = (await part(out, 'xl/worksheets/sheet1.xml'))!;
		expect(sheet).toContain('<c r="A2" t="s"><v>7</v></c>');
		expect(sheet).toContain('<row r="7"><c r="A7" t="s"><v>5</v></c></row>');
	});

	it('appends a new style and keeps the existing ones', async () => {
		const original = fixture('book.xlsx');
		const { book } = await readXlsx(original);
		const s = book.engine.sheets[0].id;
		const bold = book.styleId({ ...book.styles[0], font: { ...book.styles[0].font, bold: true } });
		book.engine.setStyle(s, 0, 0, bold);
		const out = await writeXlsx(book, original);
		const styles = (await part(out, 'xl/styles.xml'))!;
		expect(styles).toContain('<fonts count="2">');
		expect(styles).toContain(
			'<cellXfs count="4"><xf/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="2" applyNumberFormat="1"/><xf numFmtId="0" fontId="1"'
		);
		expect(await part(out, 'xl/worksheets/sheet1.xml')).toContain(
			'<c r="A1" s="3" t="s"><v>0</v></c>'
		);
		const again = await readXlsx(out);
		expect(again.book.styles[3].font.bold).toBe(true);
	});

	it('moves cells, references, merges and formats when a row is inserted', async () => {
		const original = fixture('book.xlsx');
		const { book } = await readXlsx(original);
		const s = book.engine.sheets[0].id;
		book.insertRows(s, 1, 1);
		const out = await writeXlsx(book, original);
		const sheet = (await part(out, 'xl/worksheets/sheet1.xml'))!;
		expect(sheet).toContain(
			'<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" s="1"><v>20</v></c><c r="C3" s="2"><f>B3*2</f><v>40</v></c></row>'
		);
		expect(sheet).toContain('<f>SUM(B3:B5)</f>');
		expect(sheet).toContain('<f>XLOOKUP(10,B3:B5,C3:C5)</f>');
		expect(sheet).toContain('<dimension ref="A1:F6"/>');
		expect(sheet).toContain('<conditionalFormatting sqref="B3:B5">');
		expect(sheet).toContain('<mergeCell ref="D1:E1"/>');
		const wb = (await part(out, 'xl/workbook.xml'))!;
		expect(wb).toContain('<definedName name="Amounts">Sheet1!$B$3:$B$5</definedName>');
		expect(wb).toContain('fullCalcOnLoad="1"');
		// Formula cells moved, so the calculation chain goes, with its references.
		expect(readZip(out).get('xl/calcChain.xml')).toBeUndefined();
		expect(await part(out, '[Content_Types].xml')).not.toContain('calcChain');
		expect(await part(out, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain');
		expect(sameEntries(original, out)).toContain('xl/worksheets/sheet2.xml');
		const again = await readXlsx(out);
		expect(again.book.engine.cell(s, 5, 1)!.value).toBe(90);
	});

	it('deletes columns and turns lost references into #REF!', async () => {
		const original = fixture('book.xlsx');
		const { book } = await readXlsx(original);
		const s = book.engine.sheets[0].id;
		book.deleteCols(s, 1, 1);
		const out = await writeXlsx(book, original);
		const sheet = (await part(out, 'xl/worksheets/sheet1.xml'))!;
		expect(sheet).toContain('<c r="B2" s="2" t="e"><f>#REF!*2</f><v>#REF!</v></c>');
		expect(sheet).not.toContain('<conditionalFormatting');
		expect(sheet).toContain('<mergeCell ref="C1:D1"/>');
	});

	it('adds, renames and removes sheets', async () => {
		const original = fixture('book.xlsx');
		const { book } = await readXlsx(original);
		const [first, notes] = book.engine.sheets;
		book.removeSheet(notes.id);
		book.engine.renameSheet(first.id, 'Data');
		const added = book.addSheet('Extra');
		book.engine.set(added.id, 0, 0, { formula: 'Data!B2+1' });
		book.engine.set(added.id, 1, 0, { value: 'new text' });
		const out = await writeXlsx(book, original);
		const wb = (await part(out, 'xl/workbook.xml'))!;
		expect(wb).toContain(
			'<sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Extra" sheetId="3" r:id="rIdYd6"/>'
		);
		expect(readZip(out).get('xl/worksheets/sheet2.xml')).toBeUndefined();
		expect(readZip(out).get('xl/worksheets/sheet3.xml')).toBeDefined();
		const ct = (await part(out, '[Content_Types].xml'))!;
		expect(ct).toContain('/xl/worksheets/sheet3.xml');
		expect(ct).not.toContain('/xl/worksheets/sheet2.xml');
		const again = await readXlsx(out);
		expect(again.book.engine.sheets.map((x) => x.name)).toEqual(['Data', 'Extra']);
		const ex = again.book.engine.sheets[1].id;
		expect(again.book.engine.cell(ex, 0, 0)!.value).toBe(21);
		expect(again.book.engine.cell(ex, 1, 0)!.value).toBe('new text');
	});

	it('unshares a shared formula when one of its cells changes', async () => {
		const bytes = await xlsxOf([
			'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B2" si="0">A1*10</f><v>10</v></c></row>' +
				'<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>20</v></c></row></sheetData>'
		]);
		const { book } = await readXlsx(bytes);
		const s = book.engine.sheets[0].id;
		book.engine.set(s, 0, 0, { value: 5 });
		let sheet = (await part(await writeXlsx(book, bytes), 'xl/worksheets/sheet1.xml'))!;
		expect(sheet).toContain('<c r="B1"><f t="shared" ref="B1:B2" si="0">A1*10</f><v>50</v></c>');
		expect(sheet).toContain('<c r="B2"><f t="shared" si="0"/><v>20</v></c>');
		book.engine.set(s, 1, 1, { formula: 'A2*100' });
		sheet = (await part(await writeXlsx(book, bytes), 'xl/worksheets/sheet1.xml'))!;
		expect(sheet).toContain('<c r="B1"><f>A1*10</f><v>50</v></c>');
		expect(sheet).toContain('<c r="B2"><f>A2*100</f><v>200</v></c>');
	});

	it('never writes characters XML cannot carry', async () => {
		const bytes = await xlsxOf([
			'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a&#1;b</t></is></c></row></sheetData>'
		]);
		const { book } = await readXlsx(bytes);
		const s = book.engine.sheets[0].id;
		expect(book.engine.cell(s, 0, 0)!.value).toBe('ab');
		book.engine.set(s, 1, 0, { value: 'c\u0002d\ud800' });
		book.engine.renameSheet(s, 'S\u0003');
		const out = await writeXlsx(book, bytes);
		// eslint-disable-next-line no-control-regex
		const bad = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]|\ud800/;
		for (const name of ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml', 'xl/workbook.xml'])
			expect(await part(out, name)).not.toMatch(bad);
		const again = (await readXlsx(out)).book.engine;
		expect(again.cell(s, 1, 0)!.value).toBe('cd');
	});

	it('keeps new rows in order after a deleted row', async () => {
		const bytes = await xlsxOf([
			'<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>' +
				'<row r="3"><c r="A3"><v>3</v></c></row></sheetData>'
		]);
		const { book } = await readXlsx(bytes);
		const s = book.engine.sheets[0].id;
		book.deleteRows(s, 1, 1);
		book.engine.set(s, 5, 0, { value: 6 });
		const out = await writeXlsx(book, bytes);
		const sheet = (await part(out, 'xl/worksheets/sheet1.xml'))!;
		expect([...sheet.matchAll(/<row r="(\d+)"/g)].map((m) => m[1])).toEqual(['1', '2', '6']);
		const again = (await readXlsx(out)).book.engine;
		expect([0, 1, 5].map((r) => again.cell(s, r, 0)!.value)).toEqual([1, 3, 6]);
	});

	it('writes a workbook from nothing that reads back the same', async () => {
		const { book } = await readXlsx(fixture('book.xlsx'));
		book.source = { format: 'csv', styles: 0, sheets: 0 };
		const out = await writeXlsx(book);
		const again = await readXlsx(out);
		const a = book.engine;
		const b = again.book.engine;
		expect(b.sheets.map((s) => s.name)).toEqual(a.sheets.map((s) => s.name));
		for (const [i, sh] of a.sheets.entries()) {
			for (const c of a.cells(sh.id)) {
				const d = b.cell(b.sheets[i].id, c.row, c.col);
				expect(d?.value, `${sh.name} ${c.row},${c.col}`).toEqual(c.value);
				expect(d?.formula?.text).toBe(c.formula?.text);
			}
		}
		expect(again.book.display(b.cell(b.sheets[0].id, 1, 1))).toBe('20.00 EUR');
		expect(again.book.sheet(b.sheets[0].id).merges).toEqual(book.sheet(a.sheets[0].id).merges);
		expect(again.book.colWidth(b.sheets[0].id, 0)).toBe(18);
	});
});
