/**
 * The document editor in both modes: new documents, each format's round trip,
 * what is kept untouched, locked content, versions, conflicts, two people at
 * once, a viewer, and printing.
 */
import { expect, test, type Page } from '@playwright/test';
import { act, fileBox, inPage, newFolder, openDrive, openFolder, row, upload } from '../drive';
import {
	changedWindow,
	docId,
	downloadAs,
	editor,
	fixture,
	openDoc,
	parts,
	reloadHome,
	saveNow,
	saveStatus,
	typeAfter
} from '../docs';
import { sampleDoc } from '../fixtures/doc-sample';
import { readDocument } from '../../src/lib/formats/document';
import { plainText } from '../../src/lib/formats/model';
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
			page = await (await browser.newContext({ acceptDownloads: true })).newPage();
			page.on('pageerror', (e) => errors.push(e.message));
			await openDrive(page, server, mode);
		});

		test.afterAll(async () => {
			await page.context().close();
			await server.stop();
		});

		test('a new document: type, save, and it is there after a reload', async () => {
			await page.getByRole('button', { name: /New doc/ }).click();
			await expect(editor(page)).toBeVisible({ timeout: 30_000 });
			await expect(page.getByRole('heading', { name: 'Untitled document.docx' })).toBeVisible();
			// Made here, not brought: nothing to say about how the file is kept.
			await expect(page.getByTestId('doc-notice')).toHaveCount(0);
			await editor(page).click();
			await page.keyboard.type('First words of a new document.');
			await expect(saveStatus(page)).toHaveText(/Unsaved changes|Saving…/);
			await expect(saveStatus(page)).toHaveText('Saved', { timeout: 30_000 });
			await expect(page.getByTestId('word-count')).toHaveText('6 words');

			await reloadHome(page, server);
			await openDoc(page, 'Untitled document.docx');
			await expect(editor(page)).toContainText('First words of a new document.');
			expect(errors).toEqual([]);
		});

		test('.docx: one paragraph edited, every other byte of the file as it was', async () => {
			const original = await fixture('docs/sample.docx');
			await reloadHome(page, server);
			await upload(page, await box.add(`sample-${mode}.docx`, original));
			await openDoc(page, `sample-${mode}.docx`);
			await expect(page.getByTestId('doc-notice')).toContainText('Opened from .docx');
			await typeAfter(page, 'for more.', ' Edited here.');
			await saveNow(page);

			const after = await parts(await downloadAs(page, /Original/));
			const before = await parts(original);
			expect([...after.keys()]).toEqual([...before.keys()]);
			for (const [name, part] of before) {
				if (name === 'word/document.xml') continue;
				expect(after.get(name)?.local.equals(part.local), name).toBe(true);
			}
			const { before: was, after: now } = changedWindow(
				before.get('word/document.xml')!.text,
				after.get('word/document.xml')!.text
			);
			expect(after.get('word/document.xml')!.text).toContain('for more. Edited here.');
			// The change lies inside that paragraph: no other paragraph's text is in it.
			expect(now).toContain('Edited he');
			expect(was).not.toContain('<w:p>');
			expect(was).not.toContain('Goals');
			expect(was).not.toContain('Quarterly notes');
		});

		test('what is typed while a save is under way is saved after it', async () => {
			await reloadHome(page, server);
			await upload(page, await box.add(`slow-${mode}.docx`, await fixture('docs/sample.docx')));
			await openDoc(page, `slow-${mode}.docx`);
			// The first commit is held until the second edit is in, then the save ends well
			// before that edit's own pause is over.
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
			await typeAfter(page, 'for more.', ' During one.');
			await arrival;
			await expect(saveStatus(page)).toHaveText('Saving…');
			await typeAfter(page, 'During one.', ' During two.');
			release();
			await expect(saveStatus(page)).toHaveText('Saved', { timeout: 30_000 });
			await page.unroute(commit);
			expect(held).toBe(2);

			await reloadHome(page, server);
			await openDoc(page, `slow-${mode}.docx`);
			await expect(editor(page)).toContainText('for more. During one. During two.');
		});

		test('leaving while a save is under way still saves what was typed during it', async () => {
			await reloadHome(page, server);
			await upload(page, await box.add(`leave-${mode}.docx`, await fixture('docs/sample.docx')));
			await openDoc(page, `leave-${mode}.docx`);
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
			await typeAfter(page, 'for more.', ' Before leaving.');
			await arrival;
			await expect(saveStatus(page)).toHaveText('Saving…');
			await typeAfter(page, 'Before leaving.', ' While leaving.');
			await page.getByRole('link', { name: 'Back to the folder' }).click();
			await expect(editor(page)).toHaveCount(0);
			release();
			// The edit made during the first save goes in a second one, after the editor closed.
			await expect.poll(() => held, { timeout: 30_000 }).toBe(2);
			await page.unroute(commit);

			await reloadHome(page, server);
			await openDoc(page, `leave-${mode}.docx`);
			await expect(editor(page)).toContainText('for more. Before leaving. While leaving.');
		});

		test('.odt, .rtf and Markdown save back in their own format', async () => {
			for (const [name, fixtureName, marker] of [
				[`sample-${mode}.odt`, 'docs/sample.odt', 'for more.'],
				[`sample-${mode}.rtf`, 'docs/sample.rtf', 'for more.']
			] as const) {
				await reloadHome(page, server);
				await upload(page, await box.add(name, await fixture(fixtureName)));
				await openDoc(page, name);
				await typeAfter(page, marker, ' Saved in place.');
				await saveNow(page);
				const bytes = await downloadAs(page, /Original/);
				const format = name.endsWith('.odt') ? 'odt' : 'rtf';
				const text = plainText((await readDocument(new Uint8Array(bytes), format)).model);
				expect(text).toContain('for more. Saved in place.');
				expect(text).toContain('Sync large folders without stalls.');
			}

			const md = await fixture('docs/sample.md');
			await reloadHome(page, server);
			await upload(page, await box.add(`notes-${mode}.md`, md));
			await act(page, `notes-${mode}.md`, 'Edit');
			await expect(editor(page)).toBeVisible({ timeout: 30_000 });
			await typeAfter(page, 'in it.', ' And one more.');
			await saveNow(page);
			const out = (await downloadAs(page, /Original/)).toString('utf8');
			const lines = md.toString('utf8').split('\n');
			const changed = out.split('\n').filter((l, i) => l !== lines[i]);
			expect(changed).toEqual(['Closing paragraph with `inline code` in it. And one more.']);
		});

		test('.doc is read as well as it can be, and saving makes it .docx', async () => {
			await reloadHome(page, server);
			await upload(page, await box.add(`legacy-${mode}.doc`, Buffer.from(sampleDoc())));
			await openDoc(page, `legacy-${mode}.doc`);
			await expect(editor(page)).toContainText('Imported heading');
			await expect(editor(page).locator('strong', { hasText: 'bold' })).toBeVisible();
			await expect(page.getByTestId('doc-notice')).toContainText('converts it to .docx');
			await typeAfter(page, 'Last line', ' Converted.');
			await saveNow(page);
			await expect(page.getByRole('heading', { name: `legacy-${mode}.docx` })).toBeVisible();
			const bytes = await downloadAs(page, /Original/);
			expect(bytes.subarray(0, 2).toString()).toBe('PK');
			const text = plainText((await readDocument(new Uint8Array(bytes), 'docx')).model);
			expect(text).toContain('Converted.');
			await page.getByRole('tab', { name: 'Versions' }).click();
			await expect(page.getByTestId('doc-version')).toHaveCount(2);
		});

		test('a conflict on the first save of a .doc makes a .docx copy', async () => {
			await reloadHome(page, server);
			await upload(page, await box.add(`moved-${mode}.doc`, Buffer.from(sampleDoc())));
			await openDoc(page, `moved-${mode}.doc`);
			const id = docId(page);
			const list = await inPage<{ versions: { id: string }[] }>(
				page,
				'GET',
				`/nodes/${id}/versions`
			);
			const fresh = Array.from({ length: 32 }, () =>
				Math.floor(Math.random() * 16).toString(16)
			).join('');
			await inPage(page, 'POST', `/nodes/${id}/versions/${list.versions[0].id}/restore`, {
				version_id: fresh
			});
			await typeAfter(page, 'Last line', ' Mine.');
			await saveNow(page);
			await expect(page.getByText('Saved as a separate copy')).toBeVisible();
			// The copy holds .docx bytes, and is named so.
			await expect(
				page.getByRole('heading', { name: /^moved-.* \(conflicting copy from admin, .*\)\.docx$/ })
			).toBeVisible();
			const bytes = await downloadAs(page, /Original/);
			expect(bytes.subarray(0, 2).toString()).toBe('PK');
			await reloadHome(page, server);
			await expect(row(page, `moved-${mode}.doc`)).toBeVisible();
		});

		test('locked content is shown, labelled and cannot be edited', async () => {
			await reloadHome(page, server);
			await upload(page, await box.add(`report-${mode}.docx`, await fixture('report.docx')));
			await openDoc(page, `report-${mode}.docx`);
			const locked = editor(page).locator('.locked').first();
			await expect(locked).toBeVisible();
			await expect(page.getByTestId('doc-notice')).toContainText('not editable here');
			const before = await locked.textContent();
			await locked.click();
			await page.keyboard.press('Backspace');
			await page.keyboard.type('xyz');
			await expect(page.getByText('Locked content cannot be changed').first()).toBeVisible();
			expect(await editor(page).locator('.locked').first().textContent()).toBe(before);
			await expect(saveStatus(page)).toHaveText('Saved');
		});

		test('a version is restored, and the editor shows it', async () => {
			await reloadHome(page, server);
			await openDoc(page, 'Untitled document.docx');
			await typeAfter(page, 'First words', ' Second thoughts.');
			await saveNow(page);
			await page.getByRole('tab', { name: 'Versions' }).click();
			const versions = page.getByTestId('doc-version');
			await expect(versions.nth(2)).toBeVisible();
			await versions
				.nth(1)
				.getByRole('button', { name: /^Restore/ })
				.click();
			await expect(editor(page)).not.toContainText('Second thoughts.', { timeout: 30_000 });
			await expect(editor(page)).toContainText('First words of a new document.');
		});

		test('a save that meets a newer version becomes a separate copy', async () => {
			await reloadHome(page, server);
			await openDoc(page, 'Untitled document.docx');
			const id = docId(page);
			// Someone else's save, as far as this editor knows: the file moves on under it.
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
			await typeAfter(page, 'First words', ' Mine, not theirs.');
			await saveNow(page);
			await expect(page.getByText('Saved as a separate copy')).toBeVisible();
			await expect(
				page.getByRole('heading', { name: /conflicting copy from admin/ })
			).toBeVisible();
			expect(docId(page)).not.toBe(id);
			await reloadHome(page, server);
			await expect(row(page, 'Untitled document.docx')).toBeVisible();
			await expect(
				page.getByRole('row').filter({ hasText: 'Untitled document (conflicting copy from admin' })
			).toBeVisible();
		});

		test('printing opens the print dialog without errors', async () => {
			await reloadHome(page, server);
			await openDoc(page, 'Untitled document.docx');
			await page.evaluate(() => {
				(window as unknown as { printed: number }).printed = 0;
				window.print = () => {
					(window as unknown as { printed: number }).printed++;
				};
			});
			await page.getByRole('button', { name: 'Download', exact: true }).click();
			await page.getByRole('menuitem', { name: /Print/ }).click();
			expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
			await page.emulateMedia({ media: 'print' });
			await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeHidden();
			await expect(editor(page)).toBeVisible();
			await page.emulateMedia({ media: 'screen' });
			expect(errors).toEqual([]);
		});

		test('on a phone the header is one row and the panels open over the page', async () => {
			await reloadHome(page, server);
			await page.setViewportSize({ width: 390, height: 844 });
			try {
				await openDoc(page, `sample-${mode}.docx`);
				// Counted when the document opens, not at the first edit.
				expect(await page.getByTestId('word-count').textContent()).toMatch(/^[1-9]\d* words$/);
				const bar = page.getByRole('toolbar', { name: 'Formatting' });
				// One scrolling row, no scrollbar, the paragraph style first in the order of the page.
				expect((await bar.boundingBox())!.height).toBeLessThan(64);
				expect(await bar.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
				expect(await bar.evaluate((el) => (el as HTMLElement).offsetHeight - el.clientHeight)).toBe(
					0
				);
				expect(await bar.evaluate((el) => el.querySelector('select, button')?.id)).toBe(
					'doc-style'
				);
				await expect(page.getByLabel('Font', { exact: true })).toBeHidden();
				await page.getByRole('button', { name: 'Font and size' }).click();
				await page.getByLabel('Font size').selectOption('18');
				await page.getByLabel('Font', { exact: true }).selectOption('Georgia');
				await page.mouse.click(200, 700);
				await expect(page.getByLabel('Font', { exact: true })).toBeHidden();
				const outline = page.getByRole('navigation', { name: 'Outline' });
				const details = page.getByRole('complementary', { name: 'Document details' });
				const scrim = page.getByRole('button', { name: 'Close the panel' });
				await expect(outline).toHaveCount(0);
				await expect(details).toHaveCount(0);
				expect((await page.locator('header').first().boundingBox())!.height).toBeLessThan(64);
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
					390
				);

				const paper = (await editor(page).boundingBox())!;
				await page.getByRole('button', { name: 'Toggle outline' }).click();
				await expect(outline).toBeVisible();
				expect((await outline.boundingBox())!.x).toBe(0);
				// Over the page, not beside it: the page has not moved.
				expect((await editor(page).boundingBox())!.x).toBe(paper.x);
				await outline.getByRole('button', { name: 'Quarterly notes' }).click();
				await expect(outline).toHaveCount(0);

				await page.getByRole('button', { name: 'Toggle details panel' }).click();
				await expect(details).toBeVisible();
				const side = (await details.boundingBox())!;
				expect(Math.round(side.x + side.width)).toBe(390);
				await scrim.click({ position: { x: 10, y: 400 } });
				await expect(details).toHaveCount(0);
				// The drawer has its own way out.
				await page.getByRole('button', { name: 'Toggle details panel' }).click();
				await details.getByRole('button', { name: 'Close details' }).click();
				await expect(details).toHaveCount(0);

				await page.getByRole('button', { name: 'More' }).click();
				await expect(page.getByRole('menuitem', { name: /Word document/ })).toBeVisible();
				await page.getByRole('menuitem', { name: 'Switch to viewing' }).click();
				await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
			} finally {
				await page.setViewportSize({ width: 1280, height: 720 });
			}
		});

		test('narrowed to a phone with the panels open, they close and the page shows', async () => {
			await reloadHome(page, server);
			await openDoc(page, `sample-${mode}.docx`);
			const details = page.getByRole('complementary', { name: 'Document details' });
			const outline = page.getByRole('navigation', { name: 'Outline' });
			await expect(details).toBeVisible();
			await expect(outline).toBeVisible();
			await page.setViewportSize({ width: 390, height: 844 });
			try {
				await expect(details).toHaveCount(0);
				await expect(outline).toHaveCount(0);
				await expect(page.getByRole('button', { name: 'Close the panel' })).toHaveCount(0);
				await expect(editor(page)).toBeVisible();
			} finally {
				await page.setViewportSize({ width: 1280, height: 720 });
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
			await upload(page, await box.add(`shared-${mode}.docx`, await fixture('docs/sample.docx')));
			await reloadHome(page, server);
			await shareWith(page, `Team ${mode}`, 'bob', 'editor');
			await shareDialog(page, `Team ${mode}`).getByRole('button', { name: 'Done' }).click();
			await shareWith(page, `Read ${mode}`, 'bob', 'viewer');
			await shareDialog(page, `Read ${mode}`).getByRole('button', { name: 'Done' }).click();
			await openFolder(page, `Read ${mode}`);
			await upload(page, await box.add(`readonly-${mode}.docx`, await fixture('docs/sample.docx')));

			await reloadHome(page, server);
			await openFolder(page, `Team ${mode}`);
			await openDoc(page, `shared-${mode}.docx`);

			await refocus(bob);
			await openShared(bob);
			await openFolder(bob, `Team ${mode}`);
			await openDoc(bob, `shared-${mode}.docx`);
			await expect(bob.getByTestId('editing-warning')).toContainText('admin is also editing', {
				timeout: 30_000
			});
			await expect(page.getByTestId('editing-warning')).toContainText('bob is also editing', {
				timeout: 40_000
			});
			// A warning, not a lock: carrying on is allowed.
			await bob.getByTestId('editing-warning').getByRole('button', { name: 'Continue' }).click();
			await typeAfter(bob, 'for more.', ' Bob was here.');
			await saveNow(bob);

			await bob.getByRole('link', { name: 'Back to the folder' }).click();
			await openShared(bob);
			await openFolder(bob, `Read ${mode}`);
			await openDoc(bob, `readonly-${mode}.docx`);
			await expect(bob.getByTestId('save-status')).toHaveText('View only');
			await expect(bob.getByRole('toolbar', { name: 'Formatting' })).toHaveCount(0);
			await expect(editor(bob)).toHaveAttribute('contenteditable', 'false');
			await expect(bob.getByRole('group', { name: 'Mode' })).toHaveCount(0);
			await bob.context().close();
		});
	});
}
