/**
 * The formula test table: expected values from Excel's documented behaviour.
 * Rows marked `unsure` follow our reading of the documentation and have not
 * been checked against Excel itself, which is not available here.
 */
import { describe, expect, it } from 'vitest';
import { print } from './ast';
import { dateSerial, serialToYmd, weekday } from './dates';
import { Engine, FormulaInputError } from './engine';
import { parseFormula, FormulaSyntaxError } from './parse';
import { err, isError, numberToText, type Scalar } from './values';

type Row = [formula: string, expected: Scalar | number, unsure?: 'unsure'];

/** The sheet every row is calculated against. */
function workbook(now = new Date(2024, 5, 15, 13, 30)) {
	const e = new Engine({ now: () => now });
	const s = e.addSheet('Data');
	const o = e.addSheet('Other Sheet');
	const put = (a1: string, value: Scalar) => {
		const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
		const col = m[1].charCodeAt(0) - 65;
		e.load(s, Number(m[2]) - 1, col, { value });
	};
	[10, 20, 30, '40', true].forEach((v, i) => put(`A${i + 1}`, v));
	['apple', 'banana', 'cherry', 'apricot'].forEach((v, i) => put(`B${i + 1}`, v));
	[1, 2, 3, 4, 5].forEach((v, i) => put(`C${i + 1}`, v));
	put('D1', err('#DIV/0!'));
	[1, 3, 5, 7].forEach((v, i) => put(`E${i + 1}`, v));
	['one', 'three', 'five', 'seven'].forEach((v, i) => put(`F${i + 1}`, v));
	[1, 2, 3, 4].forEach((v, i) => e.load(s, 0, 6 + i, { value: v }));
	['a', 'b', 'c', 'd'].forEach((v, i) => e.load(s, 1, 6 + i, { value: v }));
	[40, 30, 20, 10].forEach((v, i) => put(`K${i + 1}`, v));
	e.load(o, 0, 0, { value: 100 });
	e.loaded();
	return { e, s };
}

function calc(formula: string, at = { row: 49, col: 25 }) {
	const { e, s } = workbook();
	e.set(s, at.row, at.col, { formula });
	return e.cell(s, at.row, at.col)!.value;
}

const E = (code: Parameters<typeof err>[0]) => err(code);

const TABLE: Row[] = [
	// Operators and precedence.
	['1+2*3', 7],
	['(1+2)*3', 9],
	['-2^2', 4],
	['2^3^2', 64],
	['2^-1', 0.5],
	['10/4', 2.5],
	['1/0', E('#DIV/0!')],
	['50%', 0.5],
	['200%*3', 6],
	['"3"+4', 7],
	['"a"+1', E('#VALUE!')],
	['TRUE+1', 2],
	['A1+B5', 10],
	['"x"&1.5', 'x1.5'],
	['1&2', '12'],
	['TRUE&""', 'TRUE'],
	['1/3&""', '0.333333333333333'],
	['0.1+0.2=0.3', true, 'unsure'],
	['1=1', true],
	['"a"="A"', true],
	['"a"<"b"', true],
	['1<"a"', true],
	['"z"<TRUE', true],
	['B5=0', true],
	['B5=""', true],
	['D1+1', E('#DIV/0!')],
	['-"2"', -2],
	['0^0', E('#NUM!')],
	['0^-1', E('#DIV/0!')],
	['(-8)^(1/3)', E('#NUM!')],
	['1E+308*10', E('#NUM!')],
	['#N/A', E('#N/A')],
	['"a""b"', 'a"b'],
	// Math.
	['SUM(A1:A5)', 60],
	['SUM(A1:A3,"5",TRUE)', 66],
	['SUM("a")', E('#VALUE!')],
	['SUM(A1:D1)', E('#DIV/0!')],
	['SUM(C:C)', 15],
	['sum(a1:a3)', 60],
	['AVERAGE(A1:A5)', 20],
	['AVERAGE(B1:B5)', E('#DIV/0!')],
	['MIN(A1:A5)', 10],
	['MAX(A1:A5)', 30],
	['MIN(B1:B3)', 0],
	['COUNT(A1:A5)', 3],
	['COUNT(1,"2","x",TRUE)', 3],
	['COUNTA(A1:B5)', 9],
	['COUNTA(D1,"")', 2],
	['ROUND(2.675,2)', 2.68],
	['ROUND(-2.5,0)', -3],
	['ROUND(1234.567,-2)', 1200],
	['ROUNDUP(3.2,0)', 4],
	['ROUNDUP(-3.2,0)', -4],
	['ROUNDDOWN(-3.9,0)', -3],
	['ROUNDUP(0.1+0.2,1)', 0.3],
	['ABS(-3)', 3],
	['INT(-3.5)', -4],
	['INT(3.9)', 3],
	['MOD(-3,2)', 1],
	['MOD(3,-2)', -1],
	['MOD(5,0)', E('#DIV/0!')],
	['POWER(2,10)', 1024],
	['SQRT(16)', 4],
	['SQRT(-1)', E('#NUM!')],
	// Logic.
	['IF(A1>5,"big","small")', 'big'],
	['IF(FALSE,1)', false],
	['IF(TRUE,,1)', 0],
	['IF("x",1,2)', E('#VALUE!')],
	['IF(FALSE,1/0,2)', 2],
	['IFERROR(1/0,"err")', 'err'],
	['IFERROR(5,"x")', 5],
	['IFERROR(D1,0)', 0],
	['AND(TRUE,1)', true],
	['AND(TRUE,0)', false],
	['AND(B1:B3)', E('#VALUE!')],
	['OR(FALSE,A5)', true],
	['NOT(0)', true],
	['AND("TRUE",TRUE)', true],
	['AND("x")', E('#VALUE!')],
	// Conditional.
	['SUMIF(A1:A3,">15")', 50],
	['SUMIF(B1:B4,"a*",C1:C4)', 5],
	['SUMIF(B1:B4,"<>apple",C1:C4)', 9],
	['SUMIF(B1:B4,"a*",C1)', 5],
	['COUNTIF(B1:B5,"a*")', 2],
	['COUNTIF(B1:B5,"")', 1],
	['COUNTIF(B1:B5,"<>")', 4, 'unsure'],
	['COUNTIF(A1:A5,"40")', 1, 'unsure'],
	['COUNTIF(A1:A5,">=20")', 2],
	['COUNTIF(B1:B4,"?????")', 1],
	['COUNTIF(C1:C5,3)', 1],
	['COUNTIF(B1:B4,"~*")', 0],
	['COUNTIF(B1:B4,"APPLE")', 1],
	['AVERAGEIF(C1:C5,">2")', 4],
	['AVERAGEIF(C1:C5,">9")', E('#DIV/0!')],
	// Lookup.
	['VLOOKUP(5,E1:F4,2,FALSE)', 'five'],
	['VLOOKUP(4,E1:F4,2)', 'three'],
	['VLOOKUP(0,E1:F4,2)', E('#N/A')],
	['VLOOKUP(5,E1:F4,3,FALSE)', E('#REF!')],
	['VLOOKUP(5,E1:F4,0)', E('#VALUE!')],
	['VLOOKUP("t*",F1:F4,1,FALSE)', 'three'],
	['VLOOKUP(100,E1:F4,2,TRUE)', 'seven'],
	['VLOOKUP(5,E:F,2,FALSE)', 'five'],
	['HLOOKUP(3,G1:J2,2,FALSE)', 'c'],
	['HLOOKUP(2.5,G1:J2,2)', 'b'],
	['INDEX(C1:C5,3)', 3],
	['INDEX(E1:F4,2,2)', 'three'],
	['INDEX(G1:J1,3)', 3],
	['INDEX(C1:C5,6)', E('#REF!')],
	['SUM(INDEX(C1:C5,0))', 15],
	['SUM(INDEX(E1:F4,0,1))', 16],
	['MATCH(5,E1:E4,0)', 3],
	['MATCH(6,E1:E4)', 3],
	['MATCH(0,E1:E4)', E('#N/A')],
	['MATCH("ch*",B1:B4,0)', 3],
	['MATCH("CHERRY",B1:B4,0)', 3],
	['MATCH(25,K1:K4,-1)', 2],
	['MATCH(5,E1:F4,0)', E('#N/A')],
	// Text.
	['LEFT("Hello",2)', 'He'],
	['LEFT("Hello")', 'H'],
	['LEFT("Hello",-1)', E('#VALUE!')],
	['RIGHT("Hello",3)', 'llo'],
	['MID("Hello",2,3)', 'ell'],
	['MID("Hello",0,1)', E('#VALUE!')],
	['MID("Hello",10,2)', ''],
	['LEN("Hello")', 5],
	['LEN(123.5)', 5],
	['TRIM("  a   b  ")', 'a b'],
	['UPPER("abc")', 'ABC'],
	['LOWER("ÀB")', 'àb'],
	['CONCAT("a",B1:B2,1)', 'aapplebanana1'],
	['CONCAT(A4:A5)', '40TRUE'],
	['CONCATENATE("a","b",1)', 'ab1'],
	['TEXT(1234.567,"#,##0.00")', '1,234.57'],
	['TEXT(0.256,"0.0%")', '25.6%'],
	[`TEXT(1.5,"0.${'0'.repeat(120)}")`, `1.5${'0'.repeat(119)}`],
	['TEXT(45292,"yyyy-mm-dd")', '2024-01-01'],
	['TEXT(45292,"dddd, mmmm d, yyyy")', 'Monday, January 1, 2024'],
	['TEXT(0.5,"h:mm AM/PM")', '12:00 PM'],
	['TEXT("12","000")', '012'],
	['TEXT(-5,"0;(0)")', '(5)'],
	['VALUE("1,234.5")', 1234.5],
	['VALUE("50%")', 0.5],
	['VALUE("abc")', E('#VALUE!')],
	['VALUE("12:00")', 0.5],
	['VALUE("1/1/2024")', 45292],
	['VALUE("")', E('#VALUE!'), 'unsure'],
	['FIND("l","Hello")', 3],
	['FIND("L","Hello")', E('#VALUE!')],
	['FIND("l","Hello",4)', 4],
	['FIND("","abc")', 1],
	['SUBSTITUTE("a-b-c","-","+")', 'a+b+c'],
	['SUBSTITUTE("a-b-c","-","+",2)', 'a-b+c'],
	['SUBSTITUTE("abc","","x")', 'abc'],
	// Dates.
	['DATE(2024,1,1)', 45292],
	['DATE(1900,1,1)', 1],
	['DATE(1900,2,28)', 59],
	['DATE(1900,2,29)', 60],
	['DATE(1900,3,1)', 61],
	['DATE(2024,13,1)', 45658],
	['DATE(2024,1,0)', 45291],
	['DATE(99,1,1)', 36161],
	['DATE(-1,1,1)', E('#NUM!')],
	['DATE(10000,1,1)', E('#NUM!')],
	['YEAR(45292)', 2024],
	['MONTH(60)', 2],
	['DAY(60)', 29],
	['DAY(0)', 0],
	['YEAR(0)', 1900],
	['YEAR(-1)', E('#NUM!')],
	['MONTH("2024-03-15")', 3],
	['TODAY()', 45458],
	['NOW()', 45458.5625],
	// References to another sheet.
	["'Other Sheet'!A1*2", 200],
	["SUM('Other Sheet'!A:A)", 100]
];

describe('the formula table', () => {
	for (const [formula, expected, unsure] of TABLE) {
		it(`=${formula}${unsure ? ' (unsure)' : ''}`, () => {
			const got = calc(formula);
			if (typeof expected === 'number' && typeof got === 'number') {
				expect(got).toBeCloseTo(expected, 9);
			} else {
				expect(got).toEqual(expected);
			}
		});
	}

	it('reads a range in a formula as the cell in its own row', () => {
		expect(calc('A1:A3*2', { row: 1, col: 25 })).toBe(40);
		expect(calc('A1:A3*2', { row: 9, col: 25 })).toEqual(err('#VALUE!'));
	});
});

describe('parser', () => {
	const round = (f: string, mode?: 'file' | 'display' | 'odf') => print(parseFormula(f), { mode });

	it('prints back what it read', () => {
		for (const f of [
			'SUM(A1:B2)',
			'$A$1+A$2+$B3',
			"'My Sheet'!A1:B2",
			"'It''s'!C3",
			'Sheet2!A:C',
			'Sheet2!$2:$5',
			'IF(A1>=2,"x","y")',
			'IF(A1,,2)',
			'-A1%',
			'#REF!+1',
			'Sheet1!#REF!',
			'{1,2;3,4}',
			'Amounts*2',
			'1.50E+3'
		]) {
			expect(round(f)).toBe(f);
		}
	});

	it('normalises a backwards range and is case-insensitive', () => {
		expect(round('sum(b2:a1)')).toBe('SUM(A1:B2)');
		expect(round('true')).toBe('TRUE');
	});

	it('adds the prefix of newer functions in files and hides it on screen', () => {
		expect(round('CONCAT(A1,"x")')).toBe('_xlfn.CONCAT(A1,"x")');
		expect(round('_xlfn.CONCAT(A1)', 'display')).toBe('CONCAT(A1)');
		expect(round('_xlfn.XLOOKUP(1,A:A,B:B)')).toBe('_xlfn.XLOOKUP(1,A:A,B:B)');
	});

	it('prints OpenDocument references', () => {
		expect(round("SUM(A1:B2)+'Other Sheet'!$C$3", 'odf')).toBe(
			"SUM([.A1:.B2])+[$'Other Sheet'.$C$3]"
		);
		expect(round('IF(A1,1,2)', 'odf')).toBe('IF([.A1];1;2)');
	});

	it('refuses what is outside the grammar', () => {
		for (const f of [
			'1+',
			'SUM(A1',
			'"open',
			'Sheet1:Sheet3!A1',
			'[1]Sheet1!A1',
			'Table1[Col]',
			'A1 B1',
			'#SPILL!',
			'(1',
			'{1,2;3}'
		]) {
			expect(() => parseFormula(f), f).toThrow(FormulaSyntaxError);
		}
	});

	it('refuses nesting past its depth and length past Excel’s', () => {
		expect(() => parseFormula('('.repeat(500) + '1' + ')'.repeat(500))).toThrow(/deep/);
		expect(() => parseFormula('-'.repeat(500) + '1')).toThrow(/deep/);
		expect(() => parseFormula('1+'.repeat(5000) + '1')).toThrow(/long/);
	});

	it('reads row ranges, column ranges and cells apart', () => {
		expect(parseFormula('1:3')).toMatchObject({ type: 'range', kind: 'rows', top: 0, bottom: 2 });
		expect(parseFormula('A:B')).toMatchObject({ type: 'range', kind: 'cols', left: 0, right: 1 });
		expect(parseFormula('LOG10')).toMatchObject({ type: 'cell' });
		expect(parseFormula('LOG10(1)')).toMatchObject({ type: 'call', name: 'LOG10' });
		expect(parseFormula('A1B')).toMatchObject({ type: 'name' });
		expect(parseFormula('XFE1')).toMatchObject({ type: 'name' });
	});
});

describe('dates', () => {
	it('keeps the 1900 leap year bug', () => {
		expect(serialToYmd(59)).toEqual({ year: 1900, month: 2, day: 28 });
		expect(serialToYmd(60)).toEqual({ year: 1900, month: 2, day: 29 });
		expect(serialToYmd(61)).toEqual({ year: 1900, month: 3, day: 1 });
		expect(dateSerial(1900, 1, 60)).toBe(60);
		expect(weekday(1)).toBe(0);
		expect(weekday(61)).toBe(4);
	});

	it('knows the 1904 system', () => {
		expect(dateSerial(1904, 1, 1, true)).toBe(0);
		expect(dateSerial(2024, 1, 1, true)).toBe(45292 - 1462);
		expect(serialToYmd(0, true)).toEqual({ year: 1904, month: 1, day: 1 });
	});

	it('gives the last day and refuses past it', () => {
		expect(dateSerial(9999, 12, 31)).toBe(2958465);
		expect(dateSerial(9999, 12, 32)).toBeNull();
	});
});

describe('text of numbers', () => {
	it('keeps 15 significant digits', () => {
		expect(numberToText(0.1 + 0.2)).toBe('0.3');
		expect(numberToText(1e20)).toBe('100000000000000000000');
		expect(numberToText(1e21)).toBe('1E+21');
		expect(numberToText(-1234.5)).toBe('-1234.5');
		expect(numberToText(1e-10)).toBe('1E-10');
	});
});

describe('the engine', () => {
	it('reads text dates in the 1904 date system', () => {
		const e = new Engine({ date1904: true });
		const s = e.addSheet('S');
		e.set(s, 0, 0, { value: 43860 });
		e.set(s, 0, 1, { value: '1/31/2024' });
		e.set(s, 1, 0, { formula: '"1/31/2024"+0' });
		e.set(s, 2, 0, { formula: 'COUNTIF(A1,"1/31/2024")' });
		e.set(s, 3, 0, { formula: 'VALUE("1/31/2024")' });
		e.set(s, 4, 0, { formula: 'B1*1' });
		e.set(s, 5, 0, { formula: 'YEAR("1/31/2024")' });
		expect([1, 2, 3, 4, 5].map((r) => e.cell(s, r, 0)!.value)).toEqual([
			43860, 1, 43860, 43860, 2024
		]);
	});

	it('recalculates what depends on a change, through ranges', () => {
		const e = new Engine();
		const s = e.addSheet('S');
		e.set(s, 0, 0, { value: 1 });
		e.set(s, 1, 2, { formula: 'SUM(A1:A1000)' });
		e.set(s, 2, 1, { formula: 'C2*2' });
		e.set(s, 3, 1, { formula: 'SUM(A:A)+B3' });
		const changed = e.set(s, 500, 0, { value: 9 });
		expect(e.cell(s, 1, 2)!.value).toBe(10);
		expect(e.cell(s, 2, 1)!.value).toBe(20);
		expect(e.cell(s, 3, 1)!.value).toBe(30);
		expect(changed.cells.length).toBe(4);
	});

	it('follows a long chain without running out of stack', () => {
		const e = new Engine();
		const s = e.addSheet('S');
		e.load(s, 0, 0, { value: 1 });
		for (let r = 1; r < 20000; r++) e.load(s, r, 0, { formula: `A${r}+1`, value: r + 1 });
		e.loaded();
		e.set(s, 0, 0, { value: 2 });
		expect(e.cell(s, 19999, 0)!.value).toBe(20001);
	});

	it('flags a cycle with #REF! and recovers when it is broken', () => {
		const e = new Engine();
		const s = e.addSheet('S');
		e.set(s, 0, 0, { formula: 'B1+1' });
		e.set(s, 0, 1, { formula: 'A1+1' });
		e.set(s, 0, 2, { formula: 'B1*2' });
		expect(e.cell(s, 0, 0)).toMatchObject({ value: err('#REF!'), cycle: true });
		expect(e.cell(s, 0, 1)).toMatchObject({ value: err('#REF!'), cycle: true });
		expect(e.cell(s, 0, 2)!.cycle).toBeUndefined();
		expect(e.cell(s, 0, 2)!.value).toEqual(err('#REF!'));
		expect(e.health.cycles).toBe(2);
		e.set(s, 0, 1, { value: 5 });
		expect(e.cell(s, 0, 0)!.value).toBe(6);
		expect(e.cell(s, 0, 0)!.cycle).toBeUndefined();
		expect(e.cell(s, 0, 2)!.value).toBe(10);
	});

	it('takes a range that holds its own cell for a cycle', () => {
		const e = new Engine();
		const s = e.addSheet('S');
		e.set(s, 4, 0, { formula: 'SUM(A1:A10)' });
		expect(e.cell(s, 4, 0)).toMatchObject({ value: err('#REF!'), cycle: true });
	});

	it('never recalculates a formula it cannot, and its readers use the file’s value', () => {
		const e = new Engine();
		const s = e.addSheet('S');
		e.load(s, 0, 0, { value: 10 });
		e.load(s, 1, 0, { formula: '_xlfn.XLOOKUP(10,A1:A1,A1:A1)', value: 40 });
		e.load(s, 2, 0, { formula: 'A2*2', value: 80 });
		e.loaded();
		const f = e.cell(s, 1, 0)!.formula!;
		expect(f.status).toBe('unsupported');
		expect(f.missing).toEqual(['XLOOKUP']);
		expect(e.formulaText(e.cell(s, 1, 0)!)).toBe('=XLOOKUP(10,A1:A1,A1:A1)');
		e.set(s, 0, 0, { value: 11 });
		expect(e.cell(s, 1, 0)).toMatchObject({ value: 40, stale: true });
		expect(f.text).toBe('_xlfn.XLOOKUP(10,A1:A1,A1:A1)');
		e.recalc();
		expect(e.cell(s, 2, 0)!.value).toBe(80);
		expect(() => e.set(s, 1, 0, { value: 1 })).toThrow(FormulaInputError);
		expect(e.readOnly(s, 1, 0)).toBe(true);
		expect(e.health.stale).toBe(1);
	});

	it('keeps a formula it cannot read as text', () => {
		const e = new Engine();
		const s = e.addSheet('S');
		e.load(s, 0, 0, { formula: 'SUM(Table1[Amount])', value: 7 });
		e.loaded();
		expect(e.cell(s, 0, 0)!.formula!.status).toBe('invalid');
		expect(e.formulaText(e.cell(s, 0, 0)!)).toBe('=SUM(Table1[Amount])');
		e.recalc();
		expect(e.cell(s, 0, 0)!.value).toBe(7);
	});

	it('says why it refuses what is typed', () => {
		const e = new Engine();
		const s = e.addSheet('S');
		const problem = (f: string) => {
			try {
				e.set(s, 0, 0, { formula: f });
			} catch (x) {
				return (x as FormulaInputError).problem;
			}
			return null;
		};
		expect(problem('1+')).toBe('syntax');
		expect(problem('XLOOKUP(1,A:A,B:B)')).toBe('unsupported');
		expect(problem('SUM()')).toBe('arity');
		expect(problem('Nowhere!A1')).toBe('unsupported');
		expect(problem('sum(a1)')).toBeNull();
		expect(e.cell(s, 0, 0)!.formula!.text).toBe('SUM(A1)');
	});

	it('calculates formulas on load, whatever the file cached, and volatile ones each time', () => {
		let now = new Date(2024, 0, 1);
		const e = new Engine({ now: () => now });
		const s = e.addSheet('S');
		e.load(s, 0, 0, { value: 2 });
		e.load(s, 0, 1, { formula: 'A1*21', value: null });
		e.load(s, 0, 2, { formula: 'TODAY()', value: 1 });
		e.loaded();
		expect(e.cell(s, 0, 1)!.value).toBe(42);
		expect(e.cell(s, 0, 2)!.value).toBe(45292);
		now = new Date(2024, 0, 2);
		e.set(s, 5, 5, { value: 'x' });
		expect(e.cell(s, 0, 2)!.value).toBe(45293);
	});

	it('keeps array formulas read-only and refuses to split them', () => {
		const e = new Engine();
		const s = e.addSheet('S');
		e.load(s, 0, 1, {
			formula: 'A1:A3*2',
			value: 2,
			array: { top: 0, left: 1, bottom: 2, right: 1 }
		});
		e.loaded();
		expect(e.readOnly(s, 1, 1)).toBe(true);
		expect(() => e.insertRows(s, 1, 1)).toThrow(FormulaInputError);
		e.insertRows(s, 0, 1);
		expect(e.cell(s, 1, 1)!.formula!.array).toEqual({ top: 1, left: 1, bottom: 3, right: 1 });
		expect(e.readOnly(s, 0, 1)).toBe(false);
		expect(e.readOnly(s, 3, 1)).toBe(true);
		expect(e.readOnly(s, 4, 1)).toBe(false);
		e.deleteRows(s, 1, 3);
		expect(e.readOnly(s, 1, 1)).toBe(false);
	});

	it('tells read-only cells apart quickly among many array formulas', () => {
		const e = new Engine();
		const s = e.addSheet('S');
		for (let r = 0; r < 50_000; r++)
			e.load(s, r, 0, {
				formula: `B${r + 1}`,
				value: 0,
				array: { top: r, left: 0, bottom: r, right: 0 }
			});
		e.loaded();
		const t = performance.now();
		let readOnly = 0;
		for (let r = 0; r < 100; r++) for (let c = 0; c < 20; c++) if (e.readOnly(s, r, c)) readOnly++;
		expect(readOnly).toBe(100);
		expect(performance.now() - t).toBeLessThan(500);
	});

	it('refuses a file of many array formulas too large to index', () => {
		const e = new Engine();
		const s = e.addSheet('S');
		const whole = { top: 0, left: 0, bottom: 1048575, right: 1 };
		expect(() => {
			for (let k = 0; k <= 1001; k++) e.load(s, k, 0, { formula: 'B1', value: 0, array: whole });
		}).toThrow(/array/);
	});

	it('renames and removes sheets in the formulas that name them', () => {
		const e = new Engine();
		const a = e.addSheet('A');
		const b = e.addSheet('B');
		e.set(b, 0, 0, { value: 3 });
		e.set(a, 0, 0, { formula: 'B!A1*2' });
		e.renameSheet(b, 'My B');
		expect(e.cell(a, 0, 0)!.formula!.text).toBe("'My B'!A1*2");
		e.set(b, 0, 0, { value: 4 });
		expect(e.cell(a, 0, 0)!.value).toBe(8);
		e.removeSheet(b);
		expect(e.cell(a, 0, 0)!.formula!.text).toBe('#REF!*2');
		expect(e.cell(a, 0, 0)!.value).toEqual(err('#REF!'));
	});

	it('calculates on load what it can, and flags only what read a corrected value', () => {
		const e = new Engine();
		const s = e.addSheet('S');
		e.load(s, 0, 0, { value: 1 });
		e.load(s, 0, 1, { formula: 'A1+1', value: 999 });
		e.load(s, 0, 2, { formula: 'XLOOKUP(B1,A1,A1)', value: 7 });
		e.load(s, 0, 3, { formula: 'A1*2', value: 2 });
		e.load(s, 0, 4, { formula: 'XLOOKUP(D1,A1,A1)', value: 8 });
		e.loaded();
		expect(e.cell(s, 0, 1)!.value).toBe(2);
		expect(e.cell(s, 0, 2)).toMatchObject({ value: 7, stale: true });
		expect(e.cell(s, 0, 4)!.value).toBe(8);
		expect(e.cell(s, 0, 4)!.stale).toBeUndefined();
	});

	it('keeps a sheet of 100,000 cells and a range per row light', () => {
		const e = new Engine();
		const s = e.addSheet('S');
		for (let r = 0; r < 50000; r++) {
			e.load(s, r, 0, { value: r });
			// Over the budget for calculating on load: the cached values stand.
			e.load(s, r, 1, { formula: `SUM($A$1:A${r + 1})`, value: (r * (r + 1)) / 2 });
		}
		const t = Date.now();
		e.loaded();
		e.set(s, 49999, 0, { value: 0 });
		expect(e.cell(s, 49999, 1)!.value).toBe((49998 * 49999) / 2);
		expect(Date.now() - t).toBeLessThan(10000);
	});
});

describe('isError', () => {
	it('tells errors from values', () => {
		expect(isError(err('#N/A'))).toBe(true);
		expect(isError('#N/A')).toBe(false);
		expect(isError(null)).toBe(false);
	});
});
