/** What the spreadsheet specs do in the editor, the way a person would. */
import { expect, type Locator, type Page } from '@playwright/test';
import { clickName } from './drive';
import { colIndex } from '../src/lib/formula/address';

export const grid = (page: Page) => page.getByRole('grid', { name: /: cells$/ });
export const saveStatus = (page: Page) => page.getByTestId('save-status');
export const formulaBar = (page: Page) => page.getByLabel('Cell contents');

function at(ref: string): { row: number; col: number } {
	const m = /^([A-Z]+)(\d+)$/.exec(ref);
	if (!m) throw new Error(`not a cell: ${ref}`);
	return { row: Number(m[2]), col: colIndex(m[1]) + 1 };
}

/** A cell of the grid on screen, by its A1 name, merged or not. */
export function cell(page: Page, ref: string): Locator {
	const { row, col } = at(ref);
	return grid(page).locator(
		`[role=row][aria-rowindex="${row}"] > [role=gridcell][aria-colindex="${col}"], ` +
			`[role=gridcell][aria-rowindex="${row}"][aria-colindex="${col}"]`
	);
}

/** Opens a file from the list on screen in the spreadsheet editor. */
export async function openSheet(page: Page, name: string): Promise<void> {
	await clickName(page, name);
	await expect(grid(page)).toBeVisible({ timeout: 30_000 });
}

/** Selects a cell or a range through the name box, leaving the focus on the grid. */
export async function goTo(page: Page, ref: string): Promise<void> {
	const box = page.getByLabel('Selected cell');
	await box.fill(ref);
	await box.press('Enter');
	await expect(grid(page)).toBeFocused();
}

/** Types into a cell as a person does: select it, type, Enter. */
export async function typeIn(page: Page, ref: string, text: string): Promise<void> {
	await goTo(page, ref);
	await page.keyboard.type(text);
	await page.keyboard.press('Enter');
	await expect(page.getByRole('textbox', { name: /^Edit cell/ })).toHaveCount(0);
}

/** Saves now rather than when typing pauses, and waits until it is saved. */
export async function saveNow(page: Page): Promise<void> {
	await grid(page).focus();
	await page.keyboard.press('Control+s');
	await expect(saveStatus(page)).toHaveText('Saved', { timeout: 30_000 });
}

/** The id of the file on screen, from the address. */
export const sheetId = (page: Page) => new URL(page.url()).pathname.split('/').pop() as string;
