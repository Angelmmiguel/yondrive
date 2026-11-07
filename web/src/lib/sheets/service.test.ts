import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractText } from '$lib/search/extract';
import { readXlsx } from '$lib/formats/xlsx';
import { sampleOds } from '../../../tests/fixtures/sheet-samples';
import { createSheets } from './client';
import { expose, wrap } from './rpc';
import { registerSheetText } from './search-text';
import { parseInput, SheetService } from './service';

const fixture = () =>
	new Uint8Array(readFileSync(new URL('../../../tests/fixtures/book.xlsx', import.meta.url)));

describe('parseInput', () => {
	it('reads what is typed as Excel does', () => {
		expect(parseInput('')).toEqual({ input: null });
		expect(parseInput('=a1+1')).toEqual({ input: { formula: 'a1+1' } });
		expect(parseInput("'=x")).toEqual({ input: { value: '=x' } });
		expect(parseInput('12.5')).toEqual({ input: { value: 12.5 } });
		expect(parseInput('50%')).toEqual({ input: { value: 0.5 }, numFmt: '0%' });
		expect(parseInput('$1,234.50')).toEqual({ input: { value: 1234.5 }, numFmt: '"$"#,##0.00' });
		expect(parseInput('1,234')).toEqual({ input: { value: 1234 }, numFmt: '#,##0' });
		expect(parseInput('1/31/2024')).toEqual({ input: { value: 45322 }, numFmt: 'm/d/yyyy' });
		expect(parseInput('12:30')).toEqual({ input: { value: 0.5208333333333334 }, numFmt: 'h:mm' });
		expect(parseInput('true')).toEqual({ input: { value: true } });
		expect(parseInput('#N/A')).toEqual({ input: { value: { error: '#N/A' } } });
		expect(parseInput('007 agents')).toEqual({ input: { value: '007 agents' } });
	});
});

describe('the sheet service', () => {
	it('opens a workbook and gives windows of formatted cells', async () => {
		const { api } = createSheets();
		const loaded = await api.load(fixture(), 'xlsx');
		expect(loaded.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Notes']);
		expect(loaded.notice.lines.length).toBeGreaterThan(0);
		const s = loaded.sheets[0].id;
		const win = await api.window(s, 0, 0, 4, 5);
		const at = (r: number, c: number) => win.find((v) => v.row === r && v.col === c);
		expect(at(1, 1)?.text).toBe('20.00 EUR');
		expect(at(1, 2)?.formula).toBe('=B2*2');
		expect(at(4, 2)).toMatchObject({ readOnly: true, unsupported: ['XLOOKUP'] });
		expect(await api.cell(s, 9, 9)).toBeNull();
	});

	it('edits, formats, moves, sorts and saves', async () => {
		const { api } = createSheets();
		const { sheets } = await api.load(fixture(), 'xlsx');
		const s = sheets[0].id;
		const r = await api.setCells([
			{ sheet: s, row: 1, col: 1, text: '25' },
			{ sheet: s, row: 6, col: 0, text: '50%' }
		]);
		expect(r.changed.length).toBeGreaterThanOrEqual(4);
		expect(r.newStyles?.styles[0].numFmt).toBe('0%');
		expect((await api.cell(s, 6, 0))?.text).toBe('50%');
		await expect(api.setCells([{ sheet: s, row: 0, col: 0, text: '=SUM(' }])).rejects.toMatchObject(
			{
				problem: 'syntax'
			}
		);
		await expect(api.setCells([{ sheet: s, row: 4, col: 2, text: '1' }])).rejects.toMatchObject({
			problem: 'readonly'
		});
		const bold = await api.setStyle(
			s,
			{ top: 0, left: 0, bottom: 0, right: 2 },
			{ font: { bold: true } }
		);
		expect(bold.newStyles?.styles.every((st) => st.font.bold)).toBe(true);
		await api.insertRows(s, 0, 1);
		expect((await api.cell(s, 2, 2))?.formula).toBe('=B3*2');
		await api.sort(s, { top: 2, left: 0, bottom: 4, right: 2 }, [{ col: 1, desc: true }]);
		expect((await api.cell(s, 2, 0))?.value).toBe('Gamma');
		expect((await api.cell(s, 2, 2))?.formula).toBe('=B3*2');
		expect((await api.cell(s, 2, 2))?.value).toBe(80);
		await api.merge(s, { top: 8, left: 0, bottom: 8, right: 1 });
		const saved = await api.save();
		expect(saved.format).toBe('xlsx');
		const again = await readXlsx(saved.bytes);
		const id = again.book.engine.sheets[0].id;
		expect(again.book.engine.cell(id, 2, 0)!.value).toBe('Gamma');
		expect(again.book.sheet(id).merges).toContainEqual({ top: 8, left: 0, bottom: 8, right: 1 });
		const csv = await api.save('csv', s);
		expect(csv.format).toBe('csv');
		expect(await api.lostOnSave('csv')).toContain('Every sheet but the current one');
	});

	it('adds, renames and removes sheets', async () => {
		const svc = new SheetService();
		await svc.load(fixture(), 'xlsx');
		const added = svc.addSheet();
		expect(added.name).toBe('Sheet3');
		expect(() => svc.renameSheet(added.id, 'a/b')).toThrow(/valid/);
		svc.renameSheet(added.id, 'Totals');
		svc.removeSheet(added.id);
		expect(svc.sheets().map((s) => s.name)).toEqual(['Sheet1', 'Notes']);
	});
});

describe('spreadsheet text for search', () => {
	it('gives sheet names and cells as shown', async () => {
		const text = await new SheetService().text(fixture(), 'xlsx');
		expect(text).toContain('Sheet1');
		expect(text).toContain('Alpha\t20.00 EUR\t40.00');
		expect(text).toContain('Notes sheet');
	});

	it('plugs into search for the binary formats only', async () => {
		const off = registerSheetText(() => ({ text: async () => 'from sheets' }));
		try {
			const bytes = fixture();
			const facts = { name: 'a.xlsx', type: '', size: bytes.length };
			expect(await extractText(facts, new Blob([bytes]))).toBe('from sheets');
			expect(
				await extractText({ name: 'a.csv', type: 'text/csv', size: 3 }, new Blob(['a,b']))
			).toBe('a,b');
		} finally {
			off();
		}
	});
});

/** The service behind a message channel, as the page reaches the worker. */
function overChannel() {
	const ch = new MessageChannel();
	expose(new SheetService(), ch.port1 as never);
	const worker = {
		postMessage: (m: unknown) => ch.port2.postMessage(m),
		set onmessage(f: ((e: MessageEvent) => void) | null) {
			ch.port2.onmessage = f;
		},
		onerror: null,
		terminate: () => {
			ch.port1.close();
			ch.port2.close();
		}
	} as unknown as Worker;
	return wrap<SheetService>(() => worker, { timeoutMs: 10_000 });
}

describe('saving through the worker', () => {
	it('saves an untouched file more than once', async () => {
		for (const [bytes, format] of [
			[await sampleOds(), 'ods'],
			[fixture(), 'xlsx']
		] as const) {
			const w = overChannel();
			await w.api.load(bytes, format);
			const first = await w.api.save();
			const second = await w.api.save();
			expect(second.bytes).toEqual(first.bytes);
			w.close();
		}
	});
});
