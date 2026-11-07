import { describe, expect, it } from 'vitest';
import type { CellView } from './service';
import { inputOf, parseInput } from './input';

const text = (value: string) => ({ row: 0, col: 0, value, text: value, style: 0 }) as CellView;

describe('the text a cell is typed as', () => {
	it('quotes text that typing would read as something else', () => {
		for (const x of [
			'12:30',
			'Jan 5 2024',
			'1/5',
			'1e5',
			'#N/A',
			'+A1',
			'@SUM(A1)',
			'TRUE',
			'50%',
			'$-5',
			'1,234',
			'=A1',
			"'quoted"
		]) {
			expect(inputOf(text(x)), x).toBe(`'${x}`);
			expect(parseInput(inputOf(text(x))).input, x).toEqual({ value: x });
		}
	});

	it('leaves text alone that typing gives back as it is', () => {
		for (const x of ['hello', 'Q3 plan', '+', 'A1 notes', '  spaced  ', 'Jan 5']) {
			expect(inputOf(text(x)), x).toBe(x);
			expect(parseInput(x).input).toEqual({ value: x });
		}
	});

	it('shows a percentage or a date as it is formatted', () => {
		const v = { row: 0, col: 0, value: 0.5, text: '50.0%', style: 1 } as CellView;
		expect(inputOf(v, '0.0%')).toBe('50.0%');
		expect(inputOf(v)).toBe('0.5');
	});
});
