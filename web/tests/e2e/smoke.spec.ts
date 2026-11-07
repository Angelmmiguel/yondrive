/**
 * The few things every browser must do, end to end: set up, sign in, upload and
 * download, and write a document, a sheet and a note. The WebKit project runs
 * only this file (playwright.config.ts), as the stand-in for Safari.
 */
import { expect, test, type Page } from '@playwright/test';
import { download, fileBox, openDrive, row, upload } from '../drive';
import { editor, saveNow as saveDoc } from '../docs';
import { noteEditor, saveNow as saveNote } from '../notes';
import { cell, grid, saveNow as saveSheet, typeIn } from '../sheets';
import { startServer, type Server } from '../server';

const box = await fileBox();
test.afterAll(() => box.remove());

test.describe.serial('smoke', () => {
	let server: Server;
	let page: Page;
	const errors: string[] = [];

	test.beforeAll(async ({ browser }) => {
		test.setTimeout(180_000);
		server = await startServer({ mode: 'e2e' });
		page = await (await browser.newContext({ acceptDownloads: true })).newPage();
		page.on('pageerror', (e) => errors.push(e.message));
		await openDrive(page, server, 'e2e');
	});

	test.afterAll(async () => {
		await page.context().close();
		await server.stop();
	});

	test('a file goes up and comes back the same', async () => {
		const bytes = Buffer.from('bytes that make the round trip\n');
		await upload(page, await box.add('round.txt', bytes));
		expect(await download(page, 'round.txt')).toEqual(bytes);
	});

	test('a new document is written and saved', async () => {
		await page.getByRole('button', { name: /New doc/ }).click();
		await expect(editor(page)).toBeVisible({ timeout: 30_000 });
		await editor(page).click();
		await page.keyboard.type('Written in this browser.');
		await saveDoc(page);
		await page.goBack();
		await expect(row(page, 'Untitled document.docx')).toBeVisible();
	});

	test('a new sheet is filled and saved', async () => {
		await page.getByRole('button', { name: /New sheet/ }).click();
		await expect(grid(page)).toBeVisible({ timeout: 30_000 });
		await typeIn(page, 'A1', '20');
		await typeIn(page, 'A2', '22');
		await typeIn(page, 'A3', '=A1+A2');
		await expect(cell(page, 'A3')).toHaveText('42');
		await saveSheet(page);
		await page.goBack();
		await expect(row(page, 'Untitled spreadsheet.xlsx')).toBeVisible();
	});

	test('a note is captured and written in', async () => {
		await page.goto(`${server.url}/notes`);
		const unlock = page.getByRole('heading', { name: 'Unlock' });
		const list = page.getByRole('heading', { name: 'All notes', level: 1 });
		await expect(unlock.or(list)).toBeVisible({ timeout: 30_000 });
		await expect(list).toBeVisible();
		await page.getByLabel('Quick note').fill('A note from this browser');
		await page.getByLabel('Quick note').press('Enter');
		await page.getByTestId('note-card').first().click();
		await expect(noteEditor(page)).toBeVisible({ timeout: 30_000 });
		await noteEditor(page).click();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.type(' More words.');
		await saveNote(page);
		await expect(noteEditor(page)).toContainText('More words.');
	});

	test('nothing went wrong on the page', async () => {
		expect(errors).toEqual([]);
	});
});
