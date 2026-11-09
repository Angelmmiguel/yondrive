import { describe, expect, it } from 'vitest';
import { createSheets } from '../client';
import { SheetEditor, sizeRuns } from './edits';
import { fullPatch, restoreOps, textOf } from './history';
import { DEFAULT_STYLE } from '$lib/formats/workbook';
import { err } from '$lib/formula/values';

async function open(csv: string) {
	const { api } = createSheets();
	const loaded = await api.load(new TextEncoder().encode(csv), 'csv');
	const sheet = loaded.sheets[0].id;
	const ed = new SheetEditor(api, loaded.styles, 5);
	const text = async (row: number, col: number) => (await api.cell(sheet, row, col))?.text ?? '';
	const column = async (col: number, rows: number) =>
		Promise.all(Array.from({ length: rows }, (_, r) => text(r, col)));
	return { api, sheet, ed, text, column };
}

describe('what to type to get a cell back', () => {
	it('keeps numbers exact, text as text, formulas, booleans and errors', () => {
		const v = { row: 0, col: 0, text: '', style: 0 };
		expect(textOf(null)).toBe('');
		expect(textOf({ ...v, value: 0.1 + 0.2 })).toBe('0.30000000000000004');
		expect(textOf({ ...v, value: '12' })).toBe("'12");
		expect(textOf({ ...v, value: 3, formula: '=A1+2' })).toBe('=A1+2');
		expect(textOf({ ...v, value: true })).toBe('TRUE');
		expect(textOf({ ...v, value: err('#N/A') })).toBe('#N/A');
	});

	it('restores styles in as few calls as the shape allows', () => {
		const bold = { ...structuredClone(DEFAULT_STYLE), font: { bold: true as const } };
		const ops = restoreOps(
			{
				sheet: 1,
				area: { top: 0, left: 0, bottom: 2, right: 2 },
				cells: [0, 1, 2].map((r) => ({ row: r, col: 1, text: '', value: null, style: 1 }))
			},
			[DEFAULT_STYLE, bold],
			{ text: false, style: true }
		);
		expect(ops.map((o) => (o.t === 'style' ? o.area : null))).toEqual([
			{ top: 0, left: 0, bottom: 2, right: 0 },
			{ top: 0, left: 1, bottom: 2, right: 1 },
			{ top: 0, left: 2, bottom: 2, right: 2 }
		]);
		expect(fullPatch(bold).font).toMatchObject({ bold: true, italic: null });
	});
});

describe('undo and redo through the worker', () => {
	it('takes back typing, including the format a value gave its cell', async () => {
		const { sheet, ed, text } = await open('1,2\n3,4\n');
		await ed.setCells(sheet, [
			{ row: 0, col: 0, text: '50%' },
			{ row: 2, col: 0, text: '=A1+A2' }
		]);
		expect(await text(0, 0)).toBe('50%');
		expect(await text(2, 0)).toBe('3.5');
		await ed.undo();
		expect(await text(0, 0)).toBe('1');
		expect(await text(2, 0)).toBe('');
		await ed.setCells(sheet, [{ row: 0, col: 0, text: '7' }]);
		expect(await text(0, 0)).toBe('7');
		await ed.undo();
		expect(await text(0, 0)).toBe('1');
		await ed.redo();
		expect(await text(0, 0)).toBe('7');
	});

	it('takes back a clear, a sort and formatting', async () => {
		const { api, sheet, ed, column } = await open('b,2\na,1\nc,3\n');
		await ed.sort(sheet, { top: 0, left: 0, bottom: 2, right: 1 }, [{ col: 0 }], false);
		expect(await column(0, 3)).toEqual(['a', 'b', 'c']);
		await ed.clear(sheet, { top: 0, left: 0, bottom: 0, right: 1 });
		expect(await column(0, 3)).toEqual(['', 'b', 'c']);
		await ed.undo();
		await ed.undo();
		expect(await column(0, 3)).toEqual(['b', 'a', 'c']);
		await ed.style(sheet, { top: 0, left: 1, bottom: 2, right: 1 }, [
			{ area: { top: 0, left: 1, bottom: 2, right: 1 }, patch: { font: { bold: true } } }
		]);
		const styles = await api.styles();
		expect(styles[(await api.cell(sheet, 1, 1))!.style].font.bold).toBe(true);
		await ed.undo();
		expect(styles[(await api.cell(sheet, 1, 1))!.style]?.font.bold).toBeUndefined();
	});

	it('takes back a deleted row with its cells and the formulas that pointed into it', async () => {
		const { sheet, ed, text, column } = await open('1\n2\n3\n');
		await ed.setCells(sheet, [
			{ row: 0, col: 1, text: '=A2*10' },
			{ row: 3, col: 0, text: '=SUM(A1:A3)' }
		]);
		await ed.remove(sheet, 'rows', 1, 1);
		expect(await column(0, 3)).toEqual(['1', '3', '4']);
		expect(await text(0, 1)).toBe('#REF!');
		await ed.undo();
		expect(await column(0, 4)).toEqual(['1', '2', '3', '6']);
		expect(await text(0, 1)).toBe('20');
		await ed.redo();
		expect(await column(0, 3)).toEqual(['1', '3', '4']);
	});

	it('takes back an inserted column and a merge', async () => {
		const { api, sheet, ed, text } = await open('a,b,c\n');
		await ed.insert(sheet, 'cols', 1, 1);
		expect(await text(0, 2)).toBe('b');
		await ed.undo();
		expect(await text(0, 1)).toBe('b');
		await ed.merge(sheet, { top: 0, left: 0, bottom: 0, right: 2 });
		expect(await text(0, 1)).toBe('');
		expect((await api.sheets())[0].merges).toHaveLength(1);
		await ed.undo();
		expect(await text(0, 1)).toBe('b');
		expect((await api.sheets())[0].merges).toHaveLength(0);
	});

	it('keeps a bounded history, and a refused edit records nothing', async () => {
		const { sheet, ed } = await open('1\n');
		for (let i = 0; i < 8; i++) await ed.setCells(sheet, [{ row: 0, col: 0, text: String(i) }]);
		let n = 0;
		while (await ed.undo()) n++;
		expect(n).toBe(5);
		await expect(ed.setCells(sheet, [{ row: 0, col: 0, text: '=SUM(' }])).rejects.toMatchObject({
			name: 'FormulaInputError',
			problem: 'syntax'
		});
		expect(ed.history.canUndo).toBe(false);
	});

	it('saves only between steps', async () => {
		const { sheet, ed } = await open('1\n');
		const step = ed.setCells(sheet, [{ row: 0, col: 0, text: '42' }]);
		const saved = ed.save('csv', sheet);
		await step;
		expect(new TextDecoder().decode((await saved).bytes).trim()).toBe('42');
	});
});

describe('the sizes a step puts back', () => {
	it('reads them in one pass, however many rows the file sizes', () => {
		const rowInfo: [number, { height?: number }][] = [];
		for (let r = 0; r < 1_000_000; r++) rowInfo.push([r, { height: r < 5 ? 30 : 15 }]);
		const colInfo = [
			{ min: 0, max: 1, width: 12 },
			{ min: 2, max: 16_383 }
		];
		const started = performance.now();
		expect(sizeRuns({ rowInfo, colInfo }, 'height', 0, 9_999)).toEqual([
			{ from: 0, to: 4, size: 30 },
			{ from: 5, to: 9_999, size: 15 }
		]);
		expect(sizeRuns({ rowInfo, colInfo }, 'width', 1, 10_000)).toEqual([
			{ from: 1, to: 1, size: 12 },
			{ from: 2, to: 10_000, size: undefined }
		]);
		expect(performance.now() - started).toBeLessThan(2_000);
	});
});

describe('the undo snapshot of typed cells', () => {
	it('reads the cells as one window, not one call per cell', async () => {
		const { api, sheet, text } = await open('1,2\n3,4\n');
		let cellCalls = 0;
		let windowCalls = 0;
		const counted = new Proxy(api, {
			get(target, key, receiver) {
				if (key === 'cell') cellCalls++;
				if (key === 'window') windowCalls++;
				return Reflect.get(target, key, receiver);
			}
		});
		const loaded = await api.styles();
		const ed = new SheetEditor(counted, loaded, 5);
		const edits = [];
		for (let r = 0; r < 100; r++)
			for (let c = 0; c < 20; c++) edits.push({ row: r, col: c, text: `${r}x${c}` });
		await ed.setCells(sheet, edits);
		expect(cellCalls).toBe(0);
		expect(windowCalls).toBe(1);
		expect(await text(1, 1)).toBe('1x1');
		await ed.undo();
		expect(await text(0, 0)).toBe('1');
		expect(await text(1, 1)).toBe('4');
		expect(await text(50, 5)).toBe('');
	});
});

describe('what moves with rows and columns', () => {
	it('hears of inserts and deletes, undo and redo included', async () => {
		const { sheet, ed } = await open('1\n2\n3\n');
		const heard: [string, number, number][] = [];
		ed.onshift = (s, axis, at, count) => {
			expect(s).toBe(sheet);
			heard.push([axis, at, count]);
		};
		await ed.insert(sheet, 'rows', 0, 2);
		await ed.remove(sheet, 'cols', 1, 1);
		await ed.undo();
		await ed.redo();
		expect(heard).toEqual([
			['rows', 0, 2],
			['cols', 1, -1],
			['cols', 1, 1],
			['cols', 1, -1]
		]);
	});
});
