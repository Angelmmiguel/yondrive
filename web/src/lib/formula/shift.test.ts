import { describe, expect, it } from 'vitest';
import { print } from './ast';
import { Engine } from './engine';
import { parseFormula } from './parse';
import { shiftFormula, translateFormula, type AxisEdit } from './shift';
import { err } from './values';

const shift = (f: string, e: Omit<AxisEdit, 'sheet'> & { sheet?: string }, home = 'Sheet1') =>
	print(shiftFormula(parseFormula(f), { sheet: 'Sheet1', ...e }, home));

describe('shifting references', () => {
	it('moves what is past inserted rows and grows ranges they land in', () => {
		const ins = { axis: 'row' as const, at: 2, count: 2 };
		expect(shift('A1+A3', ins)).toBe('A1+A5');
		expect(shift('SUM(A1:A5)', ins)).toBe('SUM(A1:A7)');
		expect(shift('SUM(A3:A5)', ins)).toBe('SUM(A5:A7)');
		expect(shift('SUM(A1:A2)', ins)).toBe('SUM(A1:A2)');
		expect(shift('$A$4', ins)).toBe('$A$6');
		expect(shift('A:A', ins)).toBe('A:A');
		expect(shift('3:4', ins)).toBe('5:6');
		expect(shift('Other!A3', ins)).toBe('Other!A3');
		expect(shift('Sheet1!A3', ins, 'Other')).toBe('Sheet1!A5');
		expect(shift('A3', ins, 'Other')).toBe('A3');
	});

	it('turns deleted references into #REF! and shrinks ranges', () => {
		const del = { axis: 'row' as const, at: 1, count: -2 };
		expect(shift('A2', del)).toBe('#REF!');
		expect(shift('A4', del)).toBe('A2');
		expect(shift('SUM(A1:A5)', del)).toBe('SUM(A1:A3)');
		expect(shift('SUM(A2:A3)', del)).toBe('SUM(#REF!)');
		expect(shift('SUM(A3:A6)', del)).toBe('SUM(A2:A4)');
		expect(shift('Sheet1!A2', del, 'X')).toBe('Sheet1!#REF!');
		expect(shift('2:3', del)).toBe('#REF!');
	});

	it('does the same for columns', () => {
		expect(shift('B1+C1', { axis: 'col', at: 1, count: 1 })).toBe('C1+D1');
		expect(shift('SUM(A1:C1)', { axis: 'col', at: 1, count: -1 })).toBe('SUM(A1:B1)');
		expect(shift('B:B', { axis: 'col', at: 1, count: -1 })).toBe('#REF!');
		expect(shift('1:1', { axis: 'col', at: 0, count: 3 })).toBe('1:1');
		expect(shift('XFD1', { axis: 'col', at: 0, count: 1 })).toBe('#REF!');
	});

	it('moves relative parts of a copied formula', () => {
		const t = (f: string, r: number, c: number) => print(translateFormula(parseFormula(f), r, c));
		expect(t('B2*2+$A$1+A$1+$A1', 1, 1)).toBe('C3*2+$A$1+B$1+$A2');
		expect(t('SUM(A:A)', 5, 1)).toBe('SUM(B:B)');
		expect(t('A1', -1, 0)).toBe('#REF!');
	});
});

describe('structural edits in the engine', () => {
	it('moves cells, rewrites formulas on every sheet and recalculates', () => {
		const e = new Engine();
		const s = e.addSheet('Sheet1');
		const o = e.addSheet('Other');
		for (let r = 0; r < 5; r++) e.set(s, r, 0, { value: r + 1 });
		e.set(s, 5, 0, { formula: 'SUM(A1:A5)' });
		e.set(s, 0, 1, { formula: 'A3*10' });
		e.set(o, 0, 0, { formula: 'Sheet1!A4+SUM(Sheet1!A:A)' });
		e.insertRows(s, 2, 1);
		expect(e.cell(s, 6, 0)!.formula!.text).toBe('SUM(A1:A6)');
		expect(e.cell(s, 0, 1)!.formula!.text).toBe('A4*10');
		expect(e.cell(o, 0, 0)!.formula!.text).toBe('Sheet1!A5+SUM(Sheet1!A:A)');
		expect(e.cell(s, 2, 0)).toBeUndefined();
		e.set(s, 2, 0, { value: 100 });
		expect(e.cell(s, 6, 0)!.value).toBe(115);
		e.deleteRows(s, 3, 1);
		expect(e.cell(s, 0, 1)!.formula!.text).toBe('#REF!*10');
		expect(e.cell(s, 0, 1)!.value).toEqual(err('#REF!'));
		expect(e.cell(s, 5, 0)!.formula!.text).toBe('SUM(A1:A5)');
		expect(e.cell(s, 5, 0)!.value).toBe(112);
		// The whole column lost a 3 without its text changing.
		expect(e.cell(o, 0, 0)!.value).toBe(4 + 112 + 112);
		e.deleteCols(s, 0, 1);
		expect(e.cell(o, 0, 0)!.formula!.text).toBe('Sheet1!#REF!+SUM(Sheet1!#REF!)');
	});

	it('shifts defined names', () => {
		const e = new Engine();
		const s = e.addSheet('Sheet1');
		e.names = [{ name: 'Amounts', text: 'Sheet1!$B$2:$B$4' }];
		e.insertRows(s, 0, 2);
		expect(e.names[0].text).toBe('Sheet1!$B$4:$B$6');
	});
});
