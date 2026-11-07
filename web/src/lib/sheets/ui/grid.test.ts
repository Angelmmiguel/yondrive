import { describe, expect, it } from 'vitest';
import { WindowCache } from './cache';
import { htmlTableRows, isOwnCopy, parseTsv, toTsv, type Copied } from './clipboard';
import { Axis, colPx, pxToChars, pxToPt, rowPx } from './geometry';
import { editorKey, gridKey } from './keys';
import { areaOf, cycle, jump, moved, single, withMerges } from './selection';
import { cellLook } from './style';
import { DISTINCT_LIMIT, distinctValues, hiddenRows, statsOf } from './summary';
import type { CellView } from '../service';
import { DEFAULT_STYLE } from '$lib/formats/workbook';
import type { Area } from '$lib/formula/address';

const view = (row: number, col: number, text = 'x'): CellView => ({
	row,
	col,
	text,
	value: text,
	style: 0
});

describe('geometry', () => {
	it('finds offsets and indices with a few sizes that differ', () => {
		const a = new Axis(
			20,
			1_000_000,
			new Map([
				[2, 40],
				[5, 0],
				[999_999, 10]
			])
		);
		expect(a.offsetOf(0)).toBe(0);
		expect(a.offsetOf(3)).toBe(80);
		expect(a.offsetOf(6)).toBe(120);
		expect(a.total).toBe(999_999 * 20 + 20 + 10 - 20);
		expect(a.indexAt(79)).toBe(2);
		expect(a.indexAt(80)).toBe(3);
		// Row 5 is hidden: the pixel where it would be is row 6's.
		expect(a.indexAt(100)).toBe(4);
		expect(a.indexAt(120)).toBe(6);
		expect(a.indexAt(a.offsetOf(900_000) + 5)).toBe(900_000);
		expect(a.nextShown(4, 1)).toBe(6);
		expect(a.nextShown(6, -1)).toBe(4);
	});

	it('lays a dragged size over the rest without building the axis again', () => {
		const sizes = new Map<number, number>();
		for (let i = 0; i < 1_000_000; i += 2) sizes.set(i, 30);
		const base = new Axis(20, 1_000_000, sizes);
		const started = performance.now();
		let dragged = base;
		for (let px = 0; px < 200; px++) dragged = base.withSize(7, px);
		expect(performance.now() - started).toBeLessThan(200);
		const fresh = new Axis(20, 1_000_000, new Map([...sizes, [7, 199]]));
		for (const i of [0, 7, 8, 500_000, 1_000_000])
			expect(dragged.offsetOf(i)).toBe(fresh.offsetOf(i));
		expect(dragged.sizeOf(7)).toBe(199);
		expect(dragged.indexAt(fresh.offsetOf(8) - 1)).toBe(7);
		expect(dragged.total).toBe(fresh.total);
		// Dragged shut, it reads as hidden; the base is untouched.
		expect(base.withSize(4, 0).hidden(4)).toBe(true);
		expect(base.sizeOf(7)).toBe(20);
	});

	it('converts Excel units', () => {
		expect(colPx(8.43)).toBe(64);
		expect(pxToChars(64)).toBeCloseTo(8.43, 1);
		expect(rowPx(15)).toBe(20);
		expect(pxToPt(20)).toBe(15);
	});
});

describe('selection', () => {
	const bounds = { rows: 100, cols: 20 };

	it('moves, stops at the edges and skips hidden rows', () => {
		expect(moved({ row: 0, col: 0 }, -1, 0, bounds)).toEqual({ row: 0, col: 0 });
		expect(moved({ row: 0, col: 0 }, 1, 1, bounds)).toEqual({ row: 1, col: 1 });
		expect(moved({ row: 2, col: 0 }, 1, 0, { ...bounds, rowShown: (r) => r !== 3 })).toEqual({
			row: 4,
			col: 0
		});
		expect(moved({ row: 98, col: 0 }, 30, 0, bounds)).toEqual({ row: 99, col: 0 });
	});

	it('steps over a merge as one cell', () => {
		const merges = [{ top: 1, left: 1, bottom: 2, right: 3 }];
		expect(moved({ row: 1, col: 0 }, 0, 1, { ...bounds, merges })).toEqual({ row: 1, col: 1 });
		expect(moved({ row: 1, col: 1 }, 0, 1, { ...bounds, merges })).toEqual({ row: 1, col: 4 });
		expect(moved({ row: 1, col: 1 }, 1, 0, { ...bounds, merges })).toEqual({ row: 3, col: 1 });
		expect(withMerges({ top: 0, left: 2, bottom: 1, right: 2 }, merges)).toEqual({
			top: 0,
			left: 1,
			bottom: 2,
			right: 3
		});
	});

	it('grows over chains of merges in one go, however they are ordered or overlap', () => {
		// A ladder of dominoes, each reached only through the one before, listed last first.
		const ladder: Area[] = [];
		for (let k = 1; k <= 100_000; k++)
			ladder.push({ top: k, left: k % 2, bottom: k + 1, right: k % 2 });
		ladder.reverse();
		// A staircase of overlapping merges, which Excel would refuse but a file may hold.
		const stairs: Area[] = [];
		for (let k = 0; k < 100_000; k++) stairs.push({ top: k, left: k, bottom: k + 1, right: k + 1 });
		stairs.reverse();
		const started = performance.now();
		expect(withMerges({ top: 0, left: 0, bottom: 1, right: 1 }, ladder)).toEqual({
			top: 0,
			left: 0,
			bottom: 100_001,
			right: 1
		});
		expect(withMerges({ top: 0, left: 0, bottom: 0, right: 0 }, stairs)).toEqual({
			top: 0,
			left: 0,
			bottom: 100_000,
			right: 100_000
		});
		expect(withMerges({ top: 5, left: 3, bottom: 5, right: 3 }, ladder)).toEqual({
			top: 5,
			left: 3,
			bottom: 5,
			right: 3
		});
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it('grows over merges as a search to a fixed point would', () => {
		let seed = 7;
		const rand = (k: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31), seed % k);
		for (let trial = 0; trial < 200; trial++) {
			const merges: Area[] = Array.from({ length: 8 }, () => {
				const top = rand(12);
				const left = rand(12);
				return { top, left, bottom: top + rand(3), right: left + rand(3) };
			});
			const top = rand(12);
			const left = rand(12);
			const a = { top, left, bottom: top + rand(2), right: left + rand(2) };
			let want = { ...a };
			for (let changed = true; changed;) {
				changed = false;
				for (const m of merges) {
					const hit = !(
						m.bottom < want.top ||
						m.top > want.bottom ||
						m.right < want.left ||
						m.left > want.right
					);
					const grown = {
						top: Math.min(want.top, m.top),
						left: Math.min(want.left, m.left),
						bottom: Math.max(want.bottom, m.bottom),
						right: Math.max(want.right, m.right)
					};
					if (hit && JSON.stringify(grown) !== JSON.stringify(want)) {
						want = grown;
						changed = true;
					}
				}
			}
			expect(withMerges(a, merges)).toEqual(want);
		}
	});

	it('jumps to the edges of the data as Ctrl+arrow does', () => {
		const filled = [2, 3, 4, 8];
		expect(jump(0, 1, filled, 99)).toBe(2);
		expect(jump(2, 1, filled, 99)).toBe(4);
		expect(jump(4, 1, filled, 99)).toBe(8);
		expect(jump(8, 1, filled, 99)).toBe(99);
		expect(jump(8, -1, filled, 99)).toBe(4);
		expect(jump(3, -1, filled, 99)).toBe(2);
		expect(jump(2, -1, filled, 99)).toBe(0);
	});

	it('walks a selection with Enter and Tab, wrapping', () => {
		const s = { anchor: { row: 0, col: 0 }, focus: { row: 1, col: 1 }, active: { row: 0, col: 1 } };
		expect(cycle(s, 0, 1).active).toEqual({ row: 1, col: 0 });
		expect(cycle({ ...s, active: { row: 1, col: 1 } }, 1, 0).active).toEqual({ row: 0, col: 0 });
		expect(areaOf(cycle(s, 1, 0))).toEqual({ top: 0, left: 0, bottom: 1, right: 1 });
		expect(cycle(single({ row: 3, col: 3 }), 1, 0).active).toEqual({ row: 3, col: 3 });
	});
});

describe('the keyboard', () => {
	it('maps keys in the grid', () => {
		expect(gridKey({ key: 'ArrowDown' })).toEqual({
			type: 'move',
			dRow: 1,
			dCol: 0,
			extend: false
		});
		expect(gridKey({ key: 'ArrowLeft', shiftKey: true })).toMatchObject({ extend: true, dCol: -1 });
		expect(gridKey({ key: 'ArrowRight', ctrlKey: true })).toEqual({
			type: 'jump',
			dir: 'right',
			extend: false
		});
		expect(gridKey({ key: 'a', ctrlKey: true })).toEqual({ type: 'selectAll' });
		expect(gridKey({ key: 'z', metaKey: true })).toEqual({ type: 'undo' });
		expect(gridKey({ key: 'Z', ctrlKey: true, shiftKey: true })).toEqual({ type: 'redo' });
		expect(gridKey({ key: 'Home', ctrlKey: true })).toEqual({
			type: 'home',
			sheet: true,
			extend: false
		});
		expect(gridKey({ key: 'PageDown' })).toEqual({ type: 'page', dir: 1, extend: false });
		expect(gridKey({ key: 'F2' })).toEqual({ type: 'edit' });
		expect(gridKey({ key: 'Tab', shiftKey: true })).toEqual({ type: 'next', dRow: 0, dCol: -1 });
		expect(gridKey({ key: 'Delete' })).toEqual({ type: 'clear' });
		expect(gridKey({ key: '=' })).toEqual({ type: 'type', text: '=' });
		expect(gridKey({ key: 'Shift', shiftKey: true })).toBeNull();
		expect(gridKey({ key: 'c', ctrlKey: true })).toBeNull();
	});

	it('maps keys while editing, by how editing began', () => {
		expect(editorKey({ key: 'Enter' }, 'edit')).toEqual({ type: 'commit', dRow: 1, dCol: 0 });
		expect(editorKey({ key: 'Enter', altKey: true }, 'edit')).toEqual({ type: 'newline' });
		expect(editorKey({ key: 'Enter', ctrlKey: true }, 'edit')).toEqual({ type: 'fill' });
		expect(editorKey({ key: 'Escape' }, 'replace')).toEqual({ type: 'cancel' });
		expect(editorKey({ key: 'ArrowUp' }, 'replace')).toEqual({ type: 'commit', dRow: -1, dCol: 0 });
		expect(editorKey({ key: 'ArrowUp' }, 'edit')).toBeNull();
		expect(editorKey({ key: 'Tab', shiftKey: true }, 'edit')).toEqual({
			type: 'commit',
			dRow: 0,
			dCol: -1
		});
	});
});

describe('the clipboard', () => {
	it('writes and reads ranges as tab-separated text, quoting where needed', () => {
		const rows = [
			['a', 'b\tc', ''],
			['line\nbreak', 'say "hi"', '3']
		];
		const tsv = toTsv(rows);
		expect(tsv).toBe('a\t"b\tc"\t\n"line\nbreak"\t"say ""hi"""\t3');
		expect(parseTsv(tsv)).toEqual(rows);
		expect(parseTsv('1\t2\r\n3\t4\r\n')).toEqual([
			['1', '2'],
			['3', '4']
		]);
		// A quote that does not close a field is text.
		expect(parseTsv('5" screen\tx')).toEqual([['5" screen', 'x']]);
		expect(parseTsv('"open\tx')).toEqual([['"open', 'x']]);
	});

	it('reads the text of an HTML table and nothing else', () => {
		const html =
			'<meta charset="utf-8"><table><tr><td class="x">A &amp; B</td><td><b>2</b></td></tr>' +
			'<tr><th>Line<br>two</th><td><img src="https://example.invalid/x.png" onerror="alert(1)">&#36;5</td></tr></table>';
		expect(htmlTableRows(html)).toEqual([
			['A & B', '2'],
			['Line\ntwo', '$5']
		]);
		expect(htmlTableRows('<p>no table</p>')).toBeNull();
	});

	it('pastes formulas only into the file and sheet they were copied from', () => {
		const cut: Copied = {
			tsv: '3',
			raw: [['=A1+A2']],
			origin: { row: 2, col: 0 },
			area: { top: 2, left: 0, bottom: 2, right: 0 },
			file: 'book-a',
			sheet: 1,
			cut: true
		};
		expect(isOwnCopy(cut, { file: 'book-a', sheet: 1 }, '3', '')).toBe(true);
		expect(isOwnCopy(cut, { file: 'book-a', sheet: 1 }, '', '')).toBe(true);
		// Another workbook's first sheet has the same id.
		expect(isOwnCopy(cut, { file: 'book-b', sheet: 1 }, '3', '')).toBe(false);
		expect(isOwnCopy(cut, { file: 'book-a', sheet: 2 }, '3', '')).toBe(false);
		expect(isOwnCopy(cut, { file: 'book-a', sheet: 1 }, 'other', '')).toBe(false);
		expect(isOwnCopy(null, { file: 'book-a', sheet: 1 }, '', '')).toBe(false);
	});
});

describe('the window cache', () => {
	it('fetches each block once, keeps stale cells shown, and drops old blocks', () => {
		const c = new WindowCache(2);
		const first = c.missing({ top: 0, left: 0, bottom: 10, right: 20 });
		expect(first.map((b) => b.key)).toEqual(['0:0', '0:1']);
		expect(c.missing({ top: 0, left: 0, bottom: 10, right: 20 })).toEqual([]);
		c.fill(first[0], [view(1, 1)]);
		c.fill(first[1], [view(2, 17)]);
		expect(c.get(1, 1)?.text).toBe('x');
		c.stale([{ top: 1, left: 1, bottom: 1, right: 1 }]);
		expect(c.get(1, 1)?.text).toBe('x');
		const again = c.missing({ top: 0, left: 0, bottom: 10, right: 20 });
		expect(again.map((b) => b.key)).toEqual(['0:0']);
		c.fill(again[0], [view(1, 1, 'y')]);
		expect(c.get(1, 1)?.text).toBe('y');
		// A third block pushes out the one used least recently.
		const third = c.missing({ top: 70, left: 0, bottom: 70, right: 0 });
		c.fill(third[0], []);
		expect(c.size.blocks).toBe(2);
		expect(c.get(2, 17)).toBeUndefined();
	});

	it('ignores answers asked for before the rows moved', () => {
		const c = new WindowCache();
		const [b] = c.missing({ top: 0, left: 0, bottom: 0, right: 0 });
		c.clear();
		expect(c.fill(b, [view(0, 0)])).toBe(false);
		expect(c.get(0, 0)).toBeUndefined();
		expect(c.missing({ top: 0, left: 0, bottom: 0, right: 0 })).toHaveLength(1);
	});
});

describe('the status bar and the filter', () => {
	it('sums, counts and averages', () => {
		expect(statsOf([1, 2, 'x', null, '', true, 3])).toEqual({
			count: 5,
			numbers: 3,
			sum: 6,
			average: 2
		});
		expect(statsOf([]).average).toBeNull();
	});

	it('hides the rows whose values are unticked', () => {
		const col = new Map([
			[1, 'Pears'],
			[2, 'Apples'],
			[3, 'Pears'],
			[5, '10'],
			[6, '9']
		]);
		expect(distinctValues(col, 1, 6)).toEqual({
			values: ['9', '10', 'Apples', 'Pears', ''],
			more: false
		});
		const hidden = hiddenRows(
			{ header: 0, columns: [{ col: 0, hidden: new Set(['Pears', '']) }] },
			6,
			() => col
		);
		expect([...hidden].sort()).toEqual([1, 3, 4]);
	});
});

describe('a hostile column for the filter', () => {
	it('lists at most the limit of values, says there are more, and sorts them quickly', () => {
		const texts = new Map<number, string>();
		for (let r = 1; r <= 200_000; r++) texts.set(r, `v${r}`);
		const started = performance.now();
		const { values, more } = distinctValues(texts, 1, 200_000);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(values).toHaveLength(DISTINCT_LIMIT);
		expect(more).toBe(true);
		expect(values.slice(0, 3)).toEqual(['v1', 'v2', 'v3']);
		expect(distinctValues(texts, 1, 3, 3)).toEqual({ values: ['v1', 'v2', 'v3'], more: false });
	});
});

describe('cell styles', () => {
	it('lets only safe values through, and keeps text readable on fills', () => {
		const s = structuredClone(DEFAULT_STYLE);
		s.font = { name: 'Arial"; background:url(x)', bold: true, color: '#000000' };
		s.fill = '#1f2937';
		s.border = { bottom: { style: 'medium', color: 'red' } };
		s.align = { h: 'center', wrap: true };
		const look = cellLook(s, 5);
		expect(look.css).not.toContain('url');
		expect(look.css).toContain('background:#1f2937');
		expect(look.css).toContain('color:#000000');
		expect(look.border).toBe('border-bottom:2px solid var(--text-strong)');
		expect(look).toMatchObject({ align: 'center', wrap: true });
		expect(cellLook(undefined, 'text').align).toBe('left');
		expect(cellLook(DEFAULT_STYLE, 3).align).toBe('right');
		const plain = structuredClone(DEFAULT_STYLE);
		plain.fill = '#ffffff';
		plain.font = { color: '#000000' };
		expect(cellLook(plain, 'x').css).not.toMatch(/background|color:/);
	});
});
