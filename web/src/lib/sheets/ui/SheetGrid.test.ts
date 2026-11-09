// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STYLE } from '$lib/formats/workbook';
import type { SheetMeta } from '../service';
import { WindowCache } from './cache';
import { single } from './selection';
import SheetGrid from './SheetGrid.svelte';

const meta: SheetMeta = {
	id: 0,
	name: 'Sheet1',
	hidden: false,
	rows: 0,
	cols: 0,
	defaultColWidth: 8.43,
	defaultRowHeight: 15,
	merges: [],
	colInfo: [],
	rowInfo: []
};

// jsdom lays nothing out: the grid's size stays as it starts.
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
	document.body.innerHTML = '';
});

describe('the grid while an edit is on its way', () => {
	it('sends what is typed after Enter to the next cell, not into the last one', async () => {
		// The worker answers only when the test says so, as a slow device's does.
		const answers: ((ok: boolean) => void)[] = [];
		const onedit = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					answers.push(resolve);
				})
		);
		render(SheetGrid, {
			file: 'f',
			meta,
			styles: [DEFAULT_STYLE],
			cache: new WindowCache(),
			rev: 0,
			load: async () => [],
			editable: true,
			zoom: 100,
			hiddenRows: new Set<number>(),
			filtered: new Set<number>(),
			sel: single({ row: 0, col: 0 }),
			draft: null,
			onedit,
			onclear: () => {},
			onpaste: () => {},
			oncommand: () => {},
			onresize: () => {},
			onmenu: () => {},
			onfilter: () => {},
			onblocked: () => {},
			onmessage: () => {}
		});
		const grid = screen.getByRole('grid', { name: 'Sheet1: cells' });
		const type = async (key: string) => {
			const target = (screen.queryByRole('textbox', { name: /^Edit cell/ }) ?? grid) as HTMLElement;
			if (target === grid) grid.focus();
			await fireEvent.keyDown(target, { key });
		};

		await type('3');
		await type('Enter');
		// Its answer has not come, and the next keys are already typed.
		await type('7');
		await type('Enter');
		expect(onedit).toHaveBeenNthCalledWith(1, [{ row: 0, col: 0, text: '3' }]);
		await waitFor(() => expect(onedit).toHaveBeenNthCalledWith(2, [{ row: 1, col: 0, text: '7' }]));
		for (const answer of answers) answer(true);
		await waitFor(() => expect(screen.queryByRole('textbox', { name: /^Edit cell/ })).toBeNull());
	});

	it('goes back to the cell, with what was typed, when the edit is refused', async () => {
		const onedit = vi.fn(async () => false);
		render(SheetGrid, {
			file: 'f',
			meta,
			styles: [DEFAULT_STYLE],
			cache: new WindowCache(),
			rev: 0,
			load: async () => [],
			editable: true,
			zoom: 100,
			hiddenRows: new Set<number>(),
			filtered: new Set<number>(),
			sel: single({ row: 0, col: 0 }),
			draft: null,
			onedit,
			onclear: () => {},
			onpaste: () => {},
			oncommand: () => {},
			onresize: () => {},
			onmenu: () => {},
			onfilter: () => {},
			onblocked: () => {},
			onmessage: () => {}
		});
		const grid = screen.getByRole('grid', { name: 'Sheet1: cells' });
		grid.focus();
		await fireEvent.keyDown(grid, { key: '=' });
		await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit cell A1' }), {
			key: 'Enter'
		});
		const box = await screen.findByRole('textbox', { name: 'Edit cell A1' });
		expect((box as HTMLTextAreaElement).value).toBe('=');
	});
});
