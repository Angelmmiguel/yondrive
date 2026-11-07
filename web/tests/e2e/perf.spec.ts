/**
 * How long the screens that grow with a library take, on an end-to-end server:
 * Home with 1,000 files, a document opening, a sheet of 100,000 cells opening,
 * and the notes list with 500 notes. The thresholds are loose, a few times what
 * was measured (docs/ARCHITECTURE.md), to catch a regression and not a slow day.
 */
import { expect, test, type Page } from '@playwright/test';
import {
	act,
	clearUploads,
	clickName,
	fileBox,
	openDrive,
	pickFiles,
	row,
	uploadRow
} from '../drive';
import { editor, fixture } from '../docs';
import { reopenNotes } from '../notes';
import { cell, grid } from '../sheets';
import { startServer, type Server } from '../server';

/**
 * The most each may take, in milliseconds. Measured when set, in headless
 * Chromium on a development machine: Home 1,421, the document 722, the sheet
 * 1,966 and the notes list 629.
 */
const LIMITS = {
	home: 6_000,
	document: 4_000,
	sheet: 8_000,
	notes: 4_000
};

const box = await fileBox();
test.afterAll(() => box.remove());

const timed = async (what: () => Promise<void>): Promise<number> => {
	const start = Date.now();
	await what();
	return Date.now() - start;
};

test.describe.serial('timings', () => {
	let server: Server;
	let page: Page;
	const took: Record<string, number> = {};

	test.beforeAll(async ({ browser }) => {
		test.setTimeout(120_000);
		server = await startServer({ mode: 'e2e' });
		page = await (await browser.newContext()).newPage();
		page.setDefaultTimeout(60_000);
		await openDrive(page, server, 'e2e');
	});

	test.afterAll(async () => {
		console.log(`timings (ms): ${JSON.stringify(took)}`);
		await page.context().close();
		await server.stop();
	});

	test('Home lists 1,000 files', async () => {
		test.setTimeout(600_000);
		const files = [];
		for (let i = 0; i < 1000; i++) {
			files.push(await box.add(`file-${String(i).padStart(4, '0')}.txt`, Buffer.from(`file ${i}`)));
		}
		await pickFiles(page, files);
		await expect(uploadRow(page, 'file-0999.txt')).toHaveAttribute('data-status', 'done', {
			timeout: 540_000
		});
		took.home = await timed(async () => {
			await page.goto(server.url);
			const unlock = page.getByRole('heading', { name: 'Unlock' });
			await expect(unlock.or(row(page, 'file-0000.txt'))).toBeVisible();
			if (await unlock.isVisible()) throw new Error('the reload asked to unlock');
		});
		expect(took.home).toBeLessThan(LIMITS.home);
	});

	test('a document opens', async () => {
		await page.getByTestId('upload-input').setInputFiles({
			name: 'report.docx',
			mimeType: 'application/octet-stream',
			buffer: await fixture('report.docx')
		});
		await expect(uploadRow(page, 'report.docx')).toHaveAttribute('data-status', 'done');
		await clearUploads(page);
		took.document = await timed(async () => {
			await clickName(page, 'report.docx');
			await expect(editor(page)).toBeVisible();
			await expect(editor(page)).not.toBeEmpty();
		});
		expect(took.document).toBeLessThan(LIMITS.document);
		await page.goBack();
	});

	test('a sheet of 100,000 cells opens', async () => {
		test.setTimeout(120_000);
		const rows: string[] = [];
		for (let r = 0; r < 1000; r++) {
			rows.push(Array.from({ length: 100 }, (_, c) => String(r * 100 + c)).join(','));
		}
		await page.getByTestId('upload-input').setInputFiles({
			name: 'big.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from(rows.join('\n'))
		});
		await expect(uploadRow(page, 'big.csv')).toHaveAttribute('data-status', 'done');
		await clearUploads(page);
		took.sheet = await timed(async () => {
			// Delimited text opens in the viewer; Edit takes it to the sheet editor.
			await act(page, 'big.csv', 'Edit');
			await expect(grid(page)).toBeVisible({ timeout: 60_000 });
			await expect(cell(page, 'B1')).toHaveText('1');
		});
		expect(took.sheet).toBeLessThan(LIMITS.sheet);
		await page.goBack();
	});

	test('the notes list shows 500 notes', async () => {
		test.setTimeout(600_000);
		await page.goto(`${server.url}/notes`);
		await reopenNotes(page);
		const capture = page.getByLabel('Quick note');
		for (let i = 0; i < 500; i++) {
			await capture.fill(`Note number ${i}`);
			await capture.press('Enter');
			await expect(capture).toBeEnabled();
			await expect(capture).toHaveValue('');
		}
		await expect(page.getByTestId('notes-storage')).toContainText('500 notes');
		took.notes = await timed(async () => {
			await page.reload();
			await reopenNotes(page);
			await expect(page.getByTestId('note-card').first()).toBeVisible();
			await expect(page.getByTestId('notes-storage')).toContainText('500 notes');
		});
		expect(took.notes).toBeLessThan(LIMITS.notes);
	});
});
