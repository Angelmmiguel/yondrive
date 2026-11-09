/** What the Notes specs do, the way a person would. */
import { expect, type Locator, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../src/lib/formats/zip';
import { PASSPHRASE, submitUnlock } from './flows';

/** The note's editor, by its exact name: the list's "Quick note" box would match a looser one. */
export const noteEditor = (page: Page) => page.getByRole('textbox', { name: 'Note', exact: true });
export const noteTitle = (page: Page) => page.getByLabel('Title', { exact: true });
export const saveStatus = (page: Page) => page.getByTestId('save-status');
export const card = (page: Page, title: string): Locator =>
	page.getByTestId('note-card').filter({ has: page.getByText(title, { exact: true }) });

/** Goes to the notes list through the rail. */
export async function openNotes(page: Page): Promise<void> {
	await page.getByRole('navigation', { name: 'Apps' }).getByRole('link', { name: 'Notes' }).click();
	await expect(page.getByRole('heading', { name: 'All notes', level: 1 })).toBeVisible();
}

/** Back to the list from the editor. */
export async function backToList(page: Page): Promise<void> {
	await page.getByRole('link', { name: 'Back to all notes' }).first().click();
	await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
}

export async function section(page: Page, name: string): Promise<void> {
	await page
		.getByRole('navigation', { name: 'Notes sections' })
		.getByRole('button', { name: new RegExp(`^${name}`) })
		.click();
}

/** Waits for the editor, ready to type. */
export async function expectEditor(page: Page): Promise<void> {
	await expect(noteEditor(page)).toBeVisible({ timeout: 30_000 });
}

/** Waits for a note just made, as the address moves to it. */
export async function expectNew(page: Page): Promise<void> {
	await expectEditor(page);
	await expect(noteTitle(page)).toHaveValue('Untitled note');
}

/** Saves now and waits until it is saved. */
export async function saveNow(page: Page): Promise<void> {
	await noteEditor(page).press('Control+s');
	await expect(saveStatus(page)).toHaveText('Saved', { timeout: 30_000 });
}

/** Gives the open note a title. */
export async function setTitle(page: Page, title: string): Promise<void> {
	await noteTitle(page).fill(title);
	await noteTitle(page).press('Enter');
	await expect(page.getByRole('navigation', { name: 'Location' })).toContainText(title);
}

/** Types at the end of the note. */
export async function typeInNote(page: Page, text: string): Promise<void> {
	await noteEditor(page).click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type(text);
}

/** Makes a notebook through the sidebar. */
export async function newNotebook(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: 'New notebook' }).click();
	const dialog = page.getByRole('dialog', { name: 'New notebook' });
	await dialog.getByLabel('Name').fill(name);
	await dialog.getByRole('button', { name: 'Create' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(notebookButton(page, name)).toBeVisible();
}

export const notebookButton = (page: Page, name: string) =>
	page
		.getByRole('region', { name: 'Notebooks' })
		.getByRole('button', { name: new RegExp(`^${name}`) })
		.first();

/** A PNG of one colour, made here so that its bytes are what a browser decodes. */
export function png(width = 4, height = 4, rgb: [number, number, number] = [200, 40, 40]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
		const out = Buffer.alloc(12 + data.length);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body), 8 + data.length);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const rows = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) rows.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(rows)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/** After a page load on Notes: unlocks if the tab has to, then waits for the list. */
export async function reopenNotes(page: Page): Promise<void> {
	const unlock = page.getByRole('heading', { name: 'Unlock' });
	const list = page.getByRole('heading', { name: 'All notes', level: 1 });
	await expect(unlock.or(list)).toBeVisible({ timeout: 30_000 });
	if (await unlock.isVisible()) await submitUnlock(page, PASSPHRASE);
	await expect(list).toBeVisible({ timeout: 30_000 });
}
