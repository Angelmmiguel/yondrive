import { describe, expect, it } from 'vitest';
import {
	bodyOf,
	cellName,
	findText,
	joinBlocks,
	MAX_TEXT,
	parseAnchor,
	parseBody,
	shiftCell,
	textAnchor,
	type CellAnchor
} from './anchor';

describe('text anchors', () => {
	const blocks = ['Intro', 'We sell apples. The price of apples is set weekly.', 'End'];

	it('keeps the quote, some text around it and its block', () => {
		const a = textAnchor(blocks, 1, 29, 35);
		expect(a).toEqual({
			kind: 'text',
			quote: 'apples',
			before: 'ro\nWe sell apples. The price of ',
			after: ' is set weekly.\nEnd',
			block: 1
		});
		expect(textAnchor(blocks, 1, 3, 3)).toBeNull();
		expect(textAnchor(blocks, 9, 0, 1)).toBeNull();
	});

	it('finds the right one of several, after edits around it', () => {
		const a = textAnchor(blocks, 1, 29, 35)!;
		const edited = [
			'A new first line',
			'Intro',
			'We sell many apples. The price of apples is set daily.'
		];
		expect(findText(edited, a)).toEqual({ block: 2, from: 34, to: 40 });
		expect(findText(blocks, a)).toEqual({ block: 1, from: 29, to: 35 });
	});

	it('stays quick with many anchors and a quote that appears everywhere', () => {
		const blocks = Array.from(
			{ length: 6000 },
			(_, i) => `Line ${i} of the long text, a word here.`
		);
		const joined = joinBlocks(blocks);
		const anchors = Array.from({ length: 2000 }, (_, i) => textAnchor(blocks, i * 3, 0, 1)!);
		const started = performance.now();
		for (const one of anchors) findText(blocks, one, joined);
		expect(performance.now() - started).toBeLessThan(2000);
		// The quote "L" appears in every block; the one nearest its own is found.
		expect(findText(blocks, anchors[1000], joined)?.block).toBe(3000);
	});

	it('finds a quote that moved far from its block', () => {
		const blocks = ['Target sentence.', ...Array.from({ length: 500 }, () => 'filler')];
		const a = textAnchor(blocks, 0, 0, 6)!;
		expect(findText([...Array.from({ length: 300 }, () => 'new'), ...blocks], a)?.block).toBe(300);
		expect(findText(blocks.slice(0, 1), { ...a, block: 400 })?.block).toBe(0);
	});

	it('says when the text is no longer found', () => {
		const a = textAnchor(blocks, 1, 29, 35)!;
		expect(findText(['We sell pears.'], a)).toBeNull();
	});
});

describe('cell anchors', () => {
	const a: CellAnchor = { kind: 'cell', sheet: 'Sheet1', row: 4, col: 2 };

	it('follow rows and columns inserted and deleted before them', () => {
		expect(shiftCell(a, 'Sheet1', 'rows', 0, 2)).toEqual({ ...a, row: 6 });
		expect(shiftCell(a, 'Sheet1', 'rows', 5, 2)).toBeNull();
		expect(shiftCell(a, 'Sheet1', 'cols', 1, 1)).toEqual({ ...a, col: 3 });
		expect(shiftCell(a, 'Sheet1', 'rows', 0, -2)).toEqual({ ...a, row: 2 });
		expect(shiftCell(a, 'Other', 'rows', 0, 2)).toBeNull();
	});

	it('are lost with their row, and found again when undo puts it back', () => {
		const lost = shiftCell(a, 'Sheet1', 'rows', 3, -2)!;
		expect(lost).toEqual({ ...a, lost: true, gone: { axis: 'rows', at: 3, count: 2 } });
		expect(shiftCell(lost, 'Sheet1', 'rows', 0, 1)).toBeNull();
		expect(shiftCell(lost, 'Sheet1', 'cols', 3, 2)).toBeNull();
		expect(shiftCell(lost, 'Sheet1', 'rows', 3, 2)).toEqual(a);
		// As it is stored and read back.
		expect(
			shiftCell(parseAnchor(JSON.parse(JSON.stringify(lost))) as CellAnchor, 'Sheet1', 'rows', 3, 2)
		).toEqual(a);
	});

	it('have names', () => {
		expect(cellName(4, 1)).toBe('B5');
		expect(cellName(0, 26)).toBe('AA1');
	});
});

describe('what comes from the server', () => {
	it('takes only well-formed anchors', () => {
		expect(parseAnchor({ kind: 'cell', sheet: 'S', row: 1, col: 2 })).toEqual({
			kind: 'cell',
			sheet: 'S',
			row: 1,
			col: 2
		});
		expect(parseAnchor({ kind: 'cell', sheet: 'S', row: -1, col: 2 })).toBeNull();
		expect(parseAnchor({ kind: 'text', quote: '', before: '', after: '', block: 0 })).toBeNull();
		expect(
			parseAnchor({ kind: 'text', quote: 'q', before: 'x'.repeat(33), after: '', block: 0 })
		).toBeNull();
		expect(parseAnchor({ kind: 'html', html: '<b>' })).toBeNull();
		expect(parseAnchor(null)).toBeNull();
	});

	it('takes only text as a body', () => {
		expect(parseBody({ text: '<script>alert(1)</script>' })).toBe('<script>alert(1)</script>');
		expect(parseBody({ text: 3 })).toBeNull();
		expect(parseBody({ text: 'x'.repeat(MAX_TEXT + 1) })).toBeNull();
		expect(parseBody({ text: '   ' })).toBeNull();
	});

	it('refuses an empty or a long comment before sealing it', () => {
		expect(bodyOf('  hi \n')).toEqual({ text: 'hi' });
		expect(() => bodyOf(' ')).toThrow();
		expect(() => bodyOf('x'.repeat(MAX_TEXT + 1))).toThrow();
	});
});
