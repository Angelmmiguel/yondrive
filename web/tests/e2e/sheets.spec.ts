/**
 * The spreadsheet editor in both modes: a new sheet, typing and recalculating,
 * each format's round trip and what stays untouched, cells this app does not
 * calculate, rows, sorting, the clipboard, merging, undo, versions, conflicts,
 * two people at once, a viewer, and a phone.
 */
import { expect, test, type Page } from '@playwright/test';
import { act, fileBox, inPage, newFolder, openDrive, openFolder, upload } from '../drive';
import { downloadAs, fixture, parts, reloadHome } from '../docs';
import {
	cell,
	formulaBar,
	goTo,
	grid,
	openSheet,
	saveNow,
	saveStatus,
	sheetId,
	typeIn
} from '../sheets';
import { PASSPHRASE, submitUnlock } from '../flows';
import { sampleXls } from '../fixtures/sheet-samples';
import { readSpreadsheet } from '../../src/lib/formats/spreadsheet';
import { startServer, type Mode, type Server } from '../server';
import { addUser, openShared, refocus, shareDialog, shareWith } from '../sharing';

const box = await fileBox();
test.afterAll(() => box.remove());

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe.serial(`in mode ${mode}`, () => {
		let server: Server;
		let page: Page;
		const errors: string[] = [];

		test.beforeAll(async ({ browser }) => {
			test.setTimeout(120_000);
			server = await startServer({ mode });
			const context = await browser.newContext({ acceptDownloads: true });
			await context.grantPermissions(['clipboard-read', 'clipboard-write']);
			page = await context.newPage();
			page.on('pageerror', (e) => errors.push(e.message));
			await openDrive(page, server, mode);
		});

		test.afterAll(async () => {
			await page.context().close();
			await server.stop();
		});

		test('a new sheet: values and formulas, recalculated, and there after a reload', async () => {
			await page.getByRole('button', { name: /New sheet/ }).click();
			await expect(grid(page)).toBeVisible({ timeout: 30_000 });
			await expect(page.getByRole('heading', { name: 'Untitled spreadsheet.xlsx' })).toBeVisible();
			// Made here, not brought: nothing to say about how the file is kept.
			await expect(page.getByTestId('sheet-notice')).toHaveCount(0);
			await typeIn(page, 'A1', '2');
			await page.keyboard.type('3');
			await page.keyboard.press('Enter');
			await page.keyboard.type('=A1*A2+1');
			await page.keyboard.press('Enter');
			await expect(cell(page, 'A3')).toHaveText('7');
			await typeIn(page, 'A1', '10');
			await expect(cell(page, 'A3')).toHaveText('31');
			await goTo(page, 'A3');
			await expect(formulaBar(page)).toHaveValue('=A1*A2+1');
			// Each row is numbered, and the active row's number is marked.
			const rowHead = (n: number) =>
				grid(page).locator('.heads.rows .hd', { hasText: new RegExp(`^${n}$`) });
			for (const n of [1, 2, 3, 4]) await expect(rowHead(n)).toBeVisible();
			expect((await rowHead(3).boundingBox())!.width).toBeGreaterThan(20);
			await expect(rowHead(3)).toHaveClass(/\bon\b/);
			await expect(rowHead(2)).not.toHaveClass(/\bon\b/);
			await expect(saveStatus(page)).toHaveText(/Unsaved changes|Saving…|Saved/);
			await expect(saveStatus(page)).toHaveText('Saved', { timeout: 30_000 });
			// The status bar sums the selection.
			await goTo(page, 'A1:A3');
			await expect(page.getByTestId('sheet-stats')).toContainText('Sum: 44');

			await reloadHome(page, server);
			await openSheet(page, 'Untitled spreadsheet.xlsx');
			await expect(cell(page, 'A3')).toHaveText('31');
			expect(errors).toEqual([]);
		});

		test('typing replaces, F2 edits, Escape cancels, undo and redo', async () => {
			await typeIn(page, 'B1', 'first');
			await goTo(page, 'B1');
			await page.keyboard.press('F2');
			await page.keyboard.type(' second');
			await page.keyboard.press('Enter');
			await expect(cell(page, 'B1')).toHaveText('first second');
			await goTo(page, 'B1');
			await page.keyboard.type('gone');
			await page.keyboard.press('Escape');
			await expect(cell(page, 'B1')).toHaveText('first second');
			await page.keyboard.press('Control+z');
			await expect(cell(page, 'B1')).toHaveText('first');
			await page.keyboard.press('Control+y');
			await expect(cell(page, 'B1')).toHaveText('first second');
			await goTo(page, 'B1');
			await page.keyboard.press('Delete');
			await expect(cell(page, 'B1')).toHaveText('');
			// A formula that does not parse is refused and stays open to fix.
			await goTo(page, 'B2');
			await page.keyboard.type('=SUM(');
			await page.keyboard.press('Enter');
			await expect(page.getByTestId('formula-error')).toContainText('could not be read');
			await page.keyboard.press('Escape');
			await expect(cell(page, 'B2')).toHaveText('');
		});

		test('inserting a row moves the formulas that read below it', async () => {
			await typeIn(page, 'C1', '1');
			await typeIn(page, 'C2', '2');
			await typeIn(page, 'C3', '=SUM(C1:C2)');
			await expect(cell(page, 'C3')).toHaveText('3');
			await cell(page, 'C2').click({ button: 'right' });
			await page.getByRole('menuitem', { name: 'Insert row above' }).click();
			await expect(cell(page, 'C4')).toHaveText('3');
			await expect(cell(page, 'C3')).toHaveText('2');
			await goTo(page, 'C4');
			await expect(formulaBar(page)).toHaveValue('=SUM(C1:C3)');
			await typeIn(page, 'C2', '5');
			await expect(cell(page, 'C4')).toHaveText('8');
			// The formula in A3 was moved down too.
			await expect(cell(page, 'A4')).toHaveText('31');
			await cell(page, 'C2').click({ button: 'right' });
			await page.getByRole('menuitem', { name: 'Delete row' }).click();
			await expect(cell(page, 'C3')).toHaveText('3');
		});

		test('sorting a range, and copy and paste with formulas moving', async () => {
			await typeIn(page, 'E1', 'Fruit');
			await typeIn(page, 'E2', 'pear');
			await typeIn(page, 'E3', 'apple');
			await typeIn(page, 'E4', 'fig');
			await goTo(page, 'E1:E4');
			await page.getByRole('button', { name: 'Sort', exact: true }).click();
			const dialog = page.getByRole('dialog', { name: 'Sort range' });
			// All text, so nothing tells a header from the rest: say so.
			await dialog.getByLabel('The first row is a header').check();
			await dialog.getByRole('button', { name: 'Sort' }).click();
			await expect(cell(page, 'E2')).toHaveText('apple');
			await expect(cell(page, 'E3')).toHaveText('fig');
			await expect(cell(page, 'E4')).toHaveText('pear');
			await expect(cell(page, 'E1')).toHaveText('Fruit');

			await goTo(page, 'C1:C3');
			await page.keyboard.press('Control+c');
			await goTo(page, 'D1');
			await page.keyboard.press('Control+v');
			await expect(cell(page, 'D3')).toHaveText('3');
			await goTo(page, 'D3');
			await expect(formulaBar(page)).toHaveValue('=SUM(D1:D2)');
			// Text from elsewhere, tab-separated, lands as values.
			await goTo(page, 'G1');
			await grid(page).evaluate((el) => {
				const data = new DataTransfer();
				data.setData('text/plain', 'x\t1.5\ny\t2,000');
				el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
			});
			await expect(cell(page, 'H2')).toHaveText('2,000');
			await goTo(page, 'H1:H2');
			await expect(page.getByTestId('sheet-stats')).toContainText('Sum: 2,001.5');
		});

		test('merging keeps the top left value, and the merge is saved', async () => {
			await typeIn(page, 'J1', 'Title');
			await typeIn(page, 'K1', 'gone');
			await goTo(page, 'J1:L1');
			await page.getByRole('button', { name: 'Merge cells' }).click();
			await page
				.getByRole('dialog', { name: 'Merge cells?' })
				.getByRole('button', { name: 'Merge' })
				.click();
			await expect(cell(page, 'J1')).toHaveAttribute('aria-colspan', '3');
			await expect(cell(page, 'J1')).toHaveText('Title');
			await saveNow(page);
			const bytes = await downloadAs(page, /Original/);
			const { book } = await readSpreadsheet(new Uint8Array(bytes), 'xlsx');
			const s = book.ordered()[0];
			expect(s.merges).toContainEqual({ top: 0, left: 9, bottom: 0, right: 11 });
			expect(book.engine.cell(s.id, 0, 10)?.value ?? null).toBeNull();
		});

		test('.xlsx: one cell edited, every other part of the file as it was', async () => {
			const original = await fixture('book.xlsx');
			await reloadHome(page, server);
			await upload(page, await box.add(`book-${mode}.xlsx`, original));
			await openSheet(page, `book-${mode}.xlsx`);
			await expect(page.getByTestId('sheet-notice')).toContainText('Opened from .xlsx');
			await expect(page.getByTestId('sheet-notice')).toContainText(
				'Kept in the file but not shown: chart'
			);
			await expect(cell(page, 'B2')).toHaveText('20.00 EUR');
			await typeIn(page, 'B2', '25');
			await expect(cell(page, 'C2')).toHaveText(/50/);
			await saveNow(page);

			const after = await parts(await downloadAs(page, /Original/));
			const before = await parts(original);
			expect([...after.keys()]).toEqual([...before.keys()]);
			for (const [name, part] of before) {
				if (name === 'xl/worksheets/sheet1.xml' || name === 'xl/workbook.xml') continue;
				expect(after.get(name)?.local.equals(part.local), name).toBe(true);
			}
			expect(after.get('xl/worksheets/sheet1.xml')!.text).toContain(
				'<c r="B2" s="1"><v>25</v></c>'
			);
		});

		test('a formula this app does not calculate is kept and cannot be edited', async () => {
			const kept = cell(page, 'C5');
			await expect(kept).toHaveAttribute('aria-readonly', 'true');
			await expect(kept).toHaveAttribute('title', /not calculated/);
			await goTo(page, 'C5');
			await page.keyboard.type('1');
			await expect(page.getByText(/cannot be edited here/).first()).toBeVisible();
			await expect(page.getByRole('textbox', { name: /^Edit cell/ })).toHaveCount(0);
			await goTo(page, 'H1');
			await page.keyboard.type('=XLOOKUP(1,A1:A2,B1:B2)');
			await page.keyboard.press('Enter');
			await expect(page.getByTestId('formula-error')).toContainText('XLOOKUP is not calculated');
			await page.keyboard.press('Escape');

			// Rows in a file with a chart: a warning first, as the chart keeps its ranges.
			await cell(page, 'A3').click({ button: 'right' });
			await page.getByRole('menuitem', { name: 'Insert row above' }).click();
			const warning = page.getByRole('dialog', { name: 'Some ranges will not move' });
			await expect(warning).toContainText('chart');
			await warning.getByRole('button', { name: 'Cancel' }).click();
			await expect(cell(page, 'B2')).toHaveText('25.00 EUR');
		});

		test('.csv saves back as .csv, one sheet, edited in place', async () => {
			const csv = Buffer.from('name,qty\r\npear,3\r\napple,5\r\n');
			await reloadHome(page, server);
			await upload(page, await box.add(`data-${mode}.csv`, csv));
			// CSV has a viewer: Edit opens it here.
			await act(page, `data-${mode}.csv`, 'Edit');
			await expect(grid(page)).toBeVisible({ timeout: 30_000 });
			await expect(page.getByTestId('sheet-notice')).toContainText('one sheet of values');
			await expect(page.getByRole('button', { name: 'Add sheet' })).toHaveCount(0);
			await typeIn(page, 'B2', '4');
			await saveNow(page);
			const out = await downloadAs(page, /Original/);
			expect(out.toString('utf8')).toBe('name,qty\r\npear,4\r\napple,5\r\n');
		});

		test('a 100,000-cell sheet: only what is in view is drawn, scrolling keeps up', async () => {
			const csv =
				Array.from({ length: 10_000 }, (_, r) =>
					Array.from({ length: 10 }, (_, c) => r * 10 + c).join(',')
				).join('\n') + '\n';
			await reloadHome(page, server);
			await upload(page, await box.add(`big-${mode}.csv`, Buffer.from(csv)));
			await act(page, `big-${mode}.csv`, 'Edit');
			await expect(cell(page, 'J1')).toHaveText('9', { timeout: 30_000 });
			const drawn = () => grid(page).locator('[role=gridcell]').count();
			expect(await drawn()).toBeLessThan(3000);
			const perFrame = await grid(page).evaluate(async (el) => {
				const start = performance.now();
				for (let i = 1; i <= 60; i++) {
					el.scrollTop = i * 3000;
					await new Promise((r) => requestAnimationFrame(r));
				}
				return (performance.now() - start) / 60;
			});
			expect(perFrame).toBeLessThan(100);
			await expect(cell(page, 'A9001')).toHaveText('90000');
			expect(await drawn()).toBeLessThan(3000);
			// A formula over all of it is calculated in the worker.
			await typeIn(page, 'K9001', '=SUM(A1:J10000)');
			await expect(cell(page, 'K9001')).toHaveText('4999950000');
		});

		test('.xls is read as well as it can be, and saving makes it .xlsx', async () => {
			await reloadHome(page, server);
			await upload(page, await box.add(`legacy-${mode}.xls`, Buffer.from(sampleXls())));
			await openSheet(page, `legacy-${mode}.xls`);
			await expect(page.getByTestId('sheet-notice')).toContainText('converts it to .xlsx');
			await expect(cell(page, 'A1')).toHaveText('Hello');
			await typeIn(page, 'C1', 'Converted');
			await saveNow(page);
			await expect(page.getByRole('heading', { name: `legacy-${mode}.xlsx` })).toBeVisible();
			const bytes = await downloadAs(page, /Original/);
			expect(bytes.subarray(0, 2).toString()).toBe('PK');
			const { book } = await readSpreadsheet(new Uint8Array(bytes), 'xlsx');
			expect(book.engine.cell(book.ordered()[0].id, 0, 2)?.value).toBe('Converted');
			await page.getByRole('tab', { name: 'Versions' }).click();
			await expect(page.getByTestId('doc-version')).toHaveCount(2);
		});

		test('sheets: add, rename, and a version restored', async () => {
			await reloadHome(page, server);
			await openSheet(page, 'Untitled spreadsheet.xlsx');
			await page.getByRole('button', { name: 'Add sheet' }).click();
			await expect(page.getByRole('tab', { name: 'Sheet2' })).toHaveAttribute(
				'aria-selected',
				'true'
			);
			await page.getByRole('tab', { name: 'Sheet2' }).click({ button: 'right' });
			await page.getByRole('menuitem', { name: 'Rename…' }).click();
			const rename = page.getByRole('dialog', { name: 'Rename sheet' });
			await rename.getByLabel('Name').fill('Totals');
			await rename.getByRole('button', { name: 'Rename' }).click();
			await typeIn(page, 'A1', '=Sheet1!A1*2');
			await expect(cell(page, 'A1')).toHaveText('20');
			await saveNow(page);

			await page.getByRole('tab', { name: 'Versions' }).click();
			const versions = page.getByTestId('doc-version');
			await expect(versions.nth(1)).toBeVisible();
			const before = await versions.count();
			await versions
				.nth(1)
				.getByRole('button', { name: /^Restore/ })
				.click();
			await expect(page.getByRole('tab', { name: 'Totals' })).toHaveCount(0, { timeout: 30_000 });
			await expect(versions).toHaveCount(before + 1);
		});

		test('a save that meets a newer version becomes a separate copy', async () => {
			await reloadHome(page, server);
			await openSheet(page, 'Untitled spreadsheet.xlsx');
			const id = sheetId(page);
			const list = await inPage<{ versions: { id: string }[] }>(
				page,
				'GET',
				`/nodes/${id}/versions`
			);
			const older = list.versions.at(-1)!.id;
			const fresh = Array.from({ length: 32 }, () =>
				Math.floor(Math.random() * 16).toString(16)
			).join('');
			await inPage(page, 'POST', `/nodes/${id}/versions/${older}/restore`, { version_id: fresh });
			await typeIn(page, 'D9', 'mine, not theirs');
			await saveNow(page);
			await expect(page.getByText('Saved as a separate copy')).toBeVisible();
			await expect(
				page.getByRole('heading', { name: /conflicting copy from admin/ })
			).toBeVisible();
			expect(sheetId(page)).not.toBe(id);
			await reloadHome(page, server);
			await expect(
				page.getByRole('row').filter({ hasText: 'conflicting copy from admin' })
			).toBeVisible();
		});

		test('leaving while a save is under way still saves what was typed during it', async () => {
			await reloadHome(page, server);
			await openSheet(page, 'Untitled spreadsheet.xlsx');
			const commit = '**/api/v1/uploads/*/commit';
			let held = 0;
			let arrived = () => {};
			let release = () => {};
			const arrival = new Promise<void>((r) => (arrived = r));
			const released = new Promise<void>((r) => (release = r));
			await page.route(commit, async (route) => {
				if (held++ === 0) {
					arrived();
					await released;
				}
				await route.continue();
			});
			await typeIn(page, 'F20', 'before leaving');
			await grid(page).press('Control+s');
			await arrival;
			await expect(saveStatus(page)).toHaveText('Saving…');
			await typeIn(page, 'F21', 'while leaving');
			await page.getByRole('link', { name: 'Back to the folder' }).click();
			await expect(grid(page)).toHaveCount(0);
			release();
			// The edit made during the first save goes in a second one, after the editor closed.
			await expect.poll(() => held, { timeout: 30_000 }).toBe(2);
			await page.unroute(commit);

			await reloadHome(page, server);
			await openSheet(page, 'Untitled spreadsheet.xlsx');
			await expect(cell(page, 'F20')).toHaveText('before leaving');
			await expect(cell(page, 'F21')).toHaveText('while leaving');
		});

		test('printing opens the print dialog with the sheet as a table', async () => {
			await reloadHome(page, server);
			await openSheet(page, `book-${mode}.xlsx`);
			await page.evaluate(() => {
				(window as unknown as { printed: number }).printed = 0;
				window.print = () => {
					(window as unknown as { printed: number }).printed++;
				};
			});
			await page.getByRole('button', { name: 'Download', exact: true }).click();
			await page.getByRole('menuitem', { name: /Print/ }).click();
			await expect
				.poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed))
				.toBe(1);
			await page.emulateMedia({ media: 'print' });
			await expect(page.locator('table.printout')).toBeVisible();
			await expect(page.locator('table.printout')).toContainText('Item');
			await page.emulateMedia({ media: 'screen' });
		});

		test('on a phone: one header row, a scrolling toolbar, tap to select, double tap to edit', async ({
			browser
		}) => {
			const phone = await browser.newContext({
				viewport: { width: 390, height: 844 },
				hasTouch: true,
				isMobile: true,
				storageState: await page.context().storageState()
			});
			const p = await phone.newPage();
			try {
				await reloadHome(page, server);
				await openSheet(page, 'Untitled spreadsheet.xlsx');
				await p.goto(`${server.url}/sheet/${sheetId(page)}`);
				const unlock = p.getByRole('heading', { name: 'Unlock' });
				await expect(unlock.or(grid(p))).toBeVisible({ timeout: 30_000 });
				// Unlocking lands on Home, where the file is opened from the list.
				if (await unlock.isVisible()) {
					await submitUnlock(p, PASSPHRASE);
					await openSheet(p, 'Untitled spreadsheet.xlsx');
				}
				expect((await p.locator('header').first().boundingBox())!.height).toBeLessThan(64);
				const bar = p.getByRole('toolbar', { name: 'Formatting' });
				expect((await bar.boundingBox())!.height).toBeLessThan(64);
				expect(await bar.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
				expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
					390
				);
				await cell(p, 'B3').tap();
				await expect(p.getByLabel('Selected cell')).toHaveValue('B3');
				// Apart from that tap, two in a row: the second opens the editor over the cell.
				await p.waitForTimeout(500);
				await cell(p, 'B3').tap();
				await cell(p, 'B3').tap();
				const editor = p.getByRole('textbox', { name: 'Edit cell B3' });
				await expect(editor).toBeFocused();
				await p.keyboard.type('tapped');
				await p.keyboard.press('Enter');
				await expect(cell(p, 'B3')).toHaveText('tapped');
				await p.getByRole('button', { name: 'More' }).click();
				await expect(p.getByRole('menuitem', { name: /Excel workbook/ })).toBeVisible();
				await p.getByRole('menuitem', { name: 'Switch to viewing' }).click();
				await expect(bar).toHaveCount(0);
			} finally {
				await phone.close();
			}
		});

		test('two people: each is told the other is editing; a viewer only reads', async ({
			browser
		}) => {
			test.setTimeout(150_000);
			await reloadHome(page, server);
			const bob = await addUser(browser, page, server, 'bob', mode);
			await newFolder(page, `Team ${mode}`);
			await newFolder(page, `Read ${mode}`);
			await openFolder(page, `Team ${mode}`);
			await upload(page, await box.add(`shared-${mode}.xlsx`, await fixture('book.xlsx')));
			await reloadHome(page, server);
			await shareWith(page, `Team ${mode}`, 'bob', 'editor');
			await shareDialog(page, `Team ${mode}`).getByRole('button', { name: 'Done' }).click();
			await shareWith(page, `Read ${mode}`, 'bob', 'viewer');
			await shareDialog(page, `Read ${mode}`).getByRole('button', { name: 'Done' }).click();
			await openFolder(page, `Read ${mode}`);
			await upload(page, await box.add(`readonly-${mode}.xlsx`, await fixture('book.xlsx')));

			await reloadHome(page, server);
			await openFolder(page, `Team ${mode}`);
			await openSheet(page, `shared-${mode}.xlsx`);

			await refocus(bob);
			await openShared(bob);
			await openFolder(bob, `Team ${mode}`);
			await openSheet(bob, `shared-${mode}.xlsx`);
			await expect(bob.getByTestId('editing-warning')).toContainText('admin is also editing', {
				timeout: 30_000
			});
			await expect(page.getByTestId('editing-warning')).toContainText('bob is also editing', {
				timeout: 40_000
			});
			await bob.getByTestId('editing-warning').getByRole('button', { name: 'Continue' }).click();
			await typeIn(bob, 'A7', 'Bob was here');
			await saveNow(bob);

			await bob.getByRole('link', { name: 'Back to the folder' }).click();
			await openShared(bob);
			await openFolder(bob, `Read ${mode}`);
			await openSheet(bob, `readonly-${mode}.xlsx`);
			await expect(bob.getByTestId('save-status')).toHaveText('View only');
			await expect(bob.getByRole('toolbar', { name: 'Formatting' })).toHaveCount(0);
			await expect(grid(bob)).toHaveAttribute('aria-readonly', 'true');
			await expect(bob.getByRole('group', { name: 'Mode' })).toHaveCount(0);
			await expect(formulaBar(bob)).toHaveAttribute('readonly', '');
			await goTo(bob, 'A1');
			await bob.keyboard.type('x');
			await expect(bob.getByRole('textbox', { name: /^Edit cell/ })).toHaveCount(0);
			await expect(cell(bob, 'A1')).toHaveText('Item');
			await bob.context().close();
			expect(errors).toEqual([]);
		});
	});
}
