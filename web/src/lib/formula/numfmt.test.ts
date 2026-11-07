/**
 * Number formats against what Excel's documentation shows for each code. Rows
 * marked `unsure` are our reading where the documentation does not say.
 */
import { describe, expect, it } from 'vitest';
import { formatGeneral, formatValue, isDateFormat, roundDecimal } from './numfmt';
import { err, type Scalar } from './values';

const TABLE: [Scalar, string, string, ('unsure' | undefined)?][] = [
	[1234.5678, '0.00', '1234.57'],
	[1234.5678, '#,##0', '1,235'],
	[1234567.891, '#,##0.00', '1,234,567.89'],
	[0.5, '0%', '50%'],
	[1, '0.00%', '100.00%'],
	[-1234.5, '#,##0.00;(#,##0.00)', '(1,234.50)'],
	[0, '0.00;-0.00;"zero"', 'zero'],
	[1234567, '#,##0,', '1,235'],
	[1234567, '0.0,," M"', '1.2 M'],
	[12345.678, '0.00E+00', '1.23E+04'],
	[0.000123, '0.00E+00', '1.23E-04'],
	[12345, '##0.0E+0', '12.3E+3'],
	[1.5, '# ?/?', '1 1/2'],
	[0.75, '?/?', '3/4'],
	[2.25, '# ?/4', '2 1/4'],
	[45292, 'm/d/yyyy', '1/1/2024'],
	[45292.75, 'yyyy-mm-dd hh:mm', '2024-01-01 18:00'],
	[0.5, 'h:mm:ss AM/PM', '12:00:00 PM'],
	[0.25, 'h AM/PM', '6 AM'],
	[1.5, '[h]:mm', '36:00'],
	[45292, 'mmm d', 'Jan 1'],
	[45292, 'mmmmm', 'J'],
	[45292, 'd-mmm-yy', '1-Jan-24'],
	[45292.5, 'dddd', 'Monday'],
	[45292.5, 'ddd', 'Mon'],
	[60, 'yyyy-mm-dd', '1900-02-29'],
	[125 / 86400, 'mm:ss', '02:05'],
	[0.5 + 0.4 / 86400, 'h:mm:ss.0', '12:00:00.4'],
	[0.99999999, 'h:mm:ss', '0:00:00'],
	[5, '"$"#,##0.00', '$5.00'],
	[-5, '"$"#,##0.00', '-$5.00'],
	[5, '[$€-407] #,##0.00', '€ 5.00'],
	[1234, '#,##0.00 "EUR"', '1,234.00 EUR'],
	[1234.5, 'General', '1234.5'],
	[1 / 3, 'General', '0.333333333'],
	[123456789012, 'General', '1.23457E+11'],
	[-7, 'General', '-7'],
	[1e-10, 'General', '1E-10'],
	['abc', '0.00;-0.00;0;"["@"]"', '[abc]'],
	['abc', '0.00', 'abc'],
	['abc', '@', 'abc'],
	[true, '0', 'TRUE'],
	[err('#N/A'), '0.00', '#N/A'],
	[null, '0.00', ''],
	[0.1234, '0.0#', '0.12'],
	[0.1, '0.0#', '0.1'],
	[0.1, '0.0?', '0.1 '],
	[5, '00000', '00005'],
	[5551234, '000-0000', '555-1234'],
	[-0.001, '0.00', '-0.00', 'unsure'],
	[123, '[Red]0', '123'],
	[150, '[>100]"big";"small"', 'big'],
	[50, '[>100]"big";"small"', 'small'],
	[12.5, '0', '13'],
	[2.5, '0', '3'],
	[-2.5, '0', '-3'],
	[0, '#', ''],
	[0.5, '#.##', '.5'],
	[1234.5, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', ' 1,234.50 '],
	[-1234.5, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', ' (1,234.50)'],
	[0, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', ' -   '],
	[42, ';;;', ''],
	[-3, '0;-0;0;@', '-3']
];

describe('number formats', () => {
	for (const [value, code, expected, unsure] of TABLE) {
		it(`${String(value)} as ${code}${unsure ? ' (unsure)' : ''}`, () => {
			expect(formatValue(value, code)).toBe(expected);
		});
	}

	it('knows a date format from a number format', () => {
		expect(isDateFormat('yyyy-mm-dd')).toBe(true);
		expect(isDateFormat('[h]:mm')).toBe(true);
		expect(isDateFormat('0.00')).toBe(false);
		expect(isDateFormat('"d"0')).toBe(false);
	});

	it('shows dates in the 1904 system', () => {
		expect(formatValue(0, 'yyyy-mm-dd', { date1904: true })).toBe('1904-01-01');
	});

	it('shows hashes for a date out of range', () => {
		expect(formatValue(-1, 'yyyy-mm-dd')).toMatch(/^#+$/);
	});
});

describe('rounding', () => {
	it('rounds half away from zero on decimal digits', () => {
		expect(roundDecimal(2.675, 2)).toBe(2.68);
		expect(roundDecimal(1.005, 2)).toBe(1.01);
		expect(roundDecimal(-0.5, 0)).toBe(-1);
		expect(roundDecimal(1e300, 2)).toBe(1e300);
		expect(roundDecimal(123456, -3)).toBe(123000);
	});

	it('fits General in 11 characters', () => {
		expect(formatGeneral(12345678901)).toBe('12345678901');
		expect(formatGeneral(0.000123456789)).toBe('0.000123457');
		expect(formatGeneral(0.1 + 0.2)).toBe('0.3');
	});
});

describe('long formats', () => {
	it('shows more than 100 decimal placeholders without throwing', () => {
		const code = `0.${'0'.repeat(150)}`;
		const out = formatValue(1.5, code);
		expect(out).toBe(`1.5${'0'.repeat(149)}`);
		expect(formatValue(1.5, `${code}E+00`)).toBe(`1.5${'0'.repeat(149)}E+00`);
	});
});
