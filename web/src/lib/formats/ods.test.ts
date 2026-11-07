import { describe, expect, it } from 'vitest';
import { err } from '$lib/formula/values';
import { readCsv } from './csv';
import { odfToExcel, ODS_LIMITS, OdsError, readOds, writeOds } from './ods';
import { odsOf, ROW2, ROWS34, sampleOds, TAIL } from '../../../tests/fixtures/sheet-samples';
import { entryData, readZip } from './zip';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function content(bytes: Uint8Array) {
	return dec.decode(await entryData(readZip(bytes).get('content.xml')!));
}

describe('OpenFormula', () => {
	it('converts references, separators and prefixed names', () => {
		expect(odfToExcel('of:=SUM([.A1:.B2];[$Other.C3])')).toBe('SUM(A1:B2,Other!C3)');
		expect(odfToExcel("of:=['My sheet'.A1]+[.$B$2]")).toBe("'My sheet'!A1+$B$2");
		expect(odfToExcel('of:="a;[b]"&[.A1]')).toBe('"a;[b]"&A1');
		expect(odfToExcel('of:=COM.MICROSOFT.CONCAT([.A:.A])')).toBe('CONCAT(A:A)');
		expect(odfToExcel('of:=[.#REF!]')).toBe('#REF!');
		expect(odfToExcel('msoxl:=A1+1')).toBe('A1+1');
		expect(odfToExcel('oooc:=[.A1]')).toBe('oooc:=[.A1]');
	});
});

describe('reading .ods', () => {
	it('reads values, formulas, runs, merges, styles and widths', async () => {
		const { book, census, fixedRanges } = await readOds(await sampleOds());
		const e = book.engine;
		expect(e.sheets.map((s) => s.name)).toEqual(['Data', 'Other Sheet']);
		const [d, o] = e.sheets.map((s) => s.id);
		expect(e.cell(d, 0, 0)!.value).toBe('Item');
		expect(book.styles[e.cell(d, 0, 0)!.style].font.bold).toBe(true);
		expect(e.cell(d, 0, 1)!.value).toBe('Qty  x');
		expect(book.display(e.cell(d, 1, 1))).toBe('2.00');
		expect(e.cell(d, 1, 2)!.formula!.text).toBe('B2*10');
		expect(e.cell(d, 3, 0)!.value).toBe(1);
		expect(e.cell(d, 4, 0)!.value).toBe('Merged');
		expect(e.cell(d, 4, 2)!.formula!.text).toBe('SUM(B2:B4)');
		expect(e.cell(o, 0, 0)!.formula!.text).toBe('Data!C2&CONCAT("a","b")');
		expect(book.sheet(d).merges).toEqual([{ top: 4, left: 0, bottom: 4, right: 1 }]);
		expect(book.colWidth(d, 2)).toBeCloseTo(12.18, 1);
		const labels = Object.fromEntries(census.items.map((i) => [i.label, i.count]));
		expect(labels).toMatchObject({ Comment: 1, 'Named range': 1 });
		expect(fixedRanges).toContain('Named range');
	});
});

describe('writing .ods back', () => {
	it('writes an untouched spreadsheet back as it was', async () => {
		const original = await sampleOds();
		const { book } = await readOds(original);
		expect(Buffer.from(await writeOds(book, original)).equals(Buffer.from(original))).toBe(true);
	});

	it('rewrites the changed row only, and its dependents', async () => {
		const original = await sampleOds();
		const { book } = await readOds(original);
		const d = book.engine.sheets[0].id;
		book.engine.set(d, 1, 1, { value: 3 });
		const out = await writeOds(book, original);
		const before = await content(original);
		const after = await content(out);
		expect(after).toContain(
			'<table:table-cell table:style-name="ce1" office:value-type="float" office:value="3"><text:p>3.00</text:p></table:table-cell><table:table-cell table:formula="of:=[.B2]*10" office:value-type="float" office:value="30"><text:p>30</text:p></table:table-cell>'
		);
		expect(after).toContain(ROWS34);
		expect(after).toContain(TAIL);
		expect(after).toContain('of:=SUM([.B2:.B4])" office:value-type="float" office:value="3"');
		expect(after.slice(0, before.indexOf(ROW2))).toBe(before.slice(0, before.indexOf(ROW2)));
		const again = await readOds(out);
		expect(again.book.engine.cell(again.book.engine.sheets[1].id, 0, 0)!.value).toBe('30ab');
		const z = readZip(out);
		expect(
			Buffer.from(z.get('styles.xml')!.local).equals(
				Buffer.from(readZip(original).get('styles.xml')!.local)
			)
		).toBe(true);
	});

	it('splits a run of rows where one of them changes', async () => {
		const original = await sampleOds();
		const { book } = await readOds(original);
		const d = book.engine.sheets[0].id;
		book.engine.set(d, 3, 0, { value: 5 });
		const after = await content(await writeOds(book, original));
		expect(after).toContain(
			'<table:table-row table:style-name="ro1"><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/></table:table-row><table:table-row table:style-name="ro1"><table:table-cell office:value-type="float" office:value="5"><text:p>5</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/></table:table-row>'
		);
		const again = await readOds(await writeOds(book, original));
		expect(again.book.engine.cell(d, 4, 2)!.value).toBe(2);
		expect(again.book.engine.cell(again.book.engine.sheets[0].id, 3, 0)!.value).toBe(5);
	});

	it('inserts rows, moving formulas on every sheet', async () => {
		const original = await sampleOds();
		const { book } = await readOds(original);
		const d = book.engine.sheets[0].id;
		book.insertRows(d, 1, 2);
		const out = await writeOds(book, original);
		const after = await content(out);
		expect(after).toContain('of:=[.B4]*10');
		expect(after).toContain('of:=SUM([.B4:.B6])');
		expect(after).toContain('of:=[$Data.C4]&amp;COM.MICROSOFT.CONCAT(&quot;a&quot;;&quot;b&quot;)');
		const again = await readOds(out);
		const e = again.book.engine;
		const [nd, no] = e.sheets.map((s) => s.id);
		expect(e.cell(nd, 0, 0)!.value).toBe('Item');
		expect(e.cell(nd, 1, 0)).toBeUndefined();
		expect(e.cell(nd, 3, 2)!.value).toBe(20);
		expect(e.cell(nd, 6, 0)!.value).toBe('Merged');
		expect(again.book.sheet(nd).merges).toEqual([{ top: 6, left: 0, bottom: 6, right: 1 }]);
		expect(e.cell(no, 0, 0)!.value).toBe('20ab');
	});

	it('adds styles and sheets, renames, and keeps errors', async () => {
		const original = await sampleOds();
		const { book } = await readOds(original);
		const [d, o] = book.engine.sheets.map((s) => s.id);
		const red = book.styleId({ ...book.styles[0], fill: '#ff0000', font: { bold: true } });
		book.engine.setStyle(d, 1, 0, red);
		book.engine.renameSheet(o, 'Renamed');
		const added = book.addSheet('New');
		book.engine.set(added.id, 0, 0, { formula: '1/0' });
		book.engine.set(added.id, 1, 1, { value: 'x' });
		const out = await writeOds(book, original);
		const after = await content(out);
		expect(after).toContain('<style:style style:name="ydce1" style:family="table-cell"');
		expect(after).toContain('table:name="Renamed"');
		const again = await readOds(out);
		const e = again.book.engine;
		expect(e.sheets.map((s) => s.name)).toEqual(['Data', 'Renamed', 'New']);
		const n = e.sheets[2].id;
		expect(e.cell(n, 0, 0)!.value).toEqual(err('#DIV/0!'));
		expect(e.cell(n, 1, 1)!.value).toBe('x');
		const st = again.book.styles[e.cell(e.sheets[0].id, 1, 0)!.style];
		expect(st.fill).toBe('#ff0000');
		expect(st.font.bold).toBe(true);
	});

	it('writes a spreadsheet from another format', async () => {
		const { book } = readCsv(enc.encode('a,1\nb,2\n'));
		const s = book.engine.sheets[0].id;
		book.engine.set(s, 2, 1, { formula: 'SUM(B1:B2)' });
		const pct = book.styleId({ ...book.styles[0], numFmt: '0.0%' });
		book.engine.setStyle(s, 0, 1, pct);
		const out = await writeOds(book);
		expect(dec.decode(readZip(out).entries[0].compressed)).toBe(
			'application/vnd.oasis.opendocument.spreadsheet'
		);
		const again = await readOds(out);
		const e = again.book.engine;
		const id = e.sheets[0].id;
		expect(e.cell(id, 2, 1)!.value).toBe(3);
		expect(e.cell(id, 2, 1)!.formula!.text).toBe('SUM(B1:B2)');
		expect(again.book.display(e.cell(id, 0, 1))).toBe('100.0%');
	});
});

describe('hostile .ods', () => {
	const cell = (v: number) =>
		`<table:table-cell office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`;

	it('counts a cell once for every row its row repeats over', async () => {
		const cells = ODS_LIMITS.cells;
		ODS_LIMITS.cells = 1000;
		try {
			const bytes = await odsOf(
				`<table:table table:name="T"><table:table-row table:number-rows-repeated="600">${cell(1)}${cell(2)}</table:table-row></table:table>`
			);
			await expect(readOds(bytes)).rejects.toThrow(OdsError);
		} finally {
			ODS_LIMITS.cells = cells;
		}
	});

	it('counts styled empty cells against the cap', async () => {
		const cells = ODS_LIMITS.cells;
		ODS_LIMITS.cells = 1000;
		try {
			const styled = '<table:table-cell table:style-name="ce1" table:number-columns-repeated="10"/>';
			const bytes = await odsOf(
				`<table:table table:name="T"><table:table-row table:number-rows-repeated="60">${styled}${styled}</table:table-row></table:table>`,
				'<style:style style:name="ce1" style:family="table-cell"><style:text-properties fo:font-weight="bold"/></style:style>'
			);
			await expect(readOds(bytes)).rejects.toThrow(OdsError);
		} finally {
			ODS_LIMITS.cells = cells;
		}
	});
});

describe('hostile .ods styles', () => {
	it('bounds the digits a data style asks for', async () => {
		const styles =
			'<number:number-style style:name="N9"><number:number number:decimal-places="400000000" number:min-integer-digits="-3"/></number:number-style>' +
			'<style:style style:name="ce9" style:family="table-cell" style:data-style-name="N9"/>';
		const bytes = await odsOf(
			'<table:table table:name="T"><table:table-row><table:table-cell table:style-name="ce9" office:value-type="float" office:value="1.5"><text:p>1.5</text:p></table:table-cell></table:table-row></table:table>',
			styles
		);
		const t = performance.now();
		const { book } = await readOds(bytes);
		expect(performance.now() - t).toBeLessThan(2000);
		const c = book.engine.cell(book.engine.sheets[0].id, 0, 0)!;
		expect(book.styles[c.style].numFmt).toBe(`#.${'0'.repeat(30)}`);
	});
});

describe('long .ods text', () => {
	it('caps a cell built of spaces and paragraphs', async () => {
		const spaces = '<text:s text:c="1000"/>'.repeat(40);
		const paras = '<text:p>x</text:p>'.repeat(20000);
		for (const inner of [`<text:p>${spaces}</text:p>`, paras]) {
			const bytes = await odsOf(
				`<table:table table:name="T"><table:table-row><table:table-cell office:value-type="string">${inner}</table:table-cell></table:table-row></table:table>`
			);
			await expect(readOds(bytes)).rejects.toThrow(OdsError);
		}
	});

	it('reads a negative space count as one space', async () => {
		const bytes = await odsOf(
			'<table:table table:name="T"><table:table-row><table:table-cell office:value-type="string"><text:p>a<text:s text:c="-4"/>b</text:p></table:table-cell></table:table-row></table:table>'
		);
		const { book } = await readOds(bytes);
		expect(book.engine.cell(book.engine.sheets[0].id, 0, 0)!.value).toBe('a b');
	});
});
