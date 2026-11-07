/**
 * Notes in both modes: quick capture, notebooks, links and backlinks that
 * survive a rename, tags, checklists, pins, reminders on a fake clock,
 * templates, today's note, pictures, a shared notebook, the export, and the
 * phone layout.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileBox, openDrive, row } from '../drive';
import {
	backToList,
	card,
	expectEditor,
	expectNew,
	newNotebook,
	noteEditor,
	notebookButton,
	noteTitle,
	openNotes,
	png,
	reopenNotes,
	saveNow,
	section,
	setTitle,
	typeInNote
} from '../notes';
import { startServer, type Mode, type Server } from '../server';
import { addUser, refocus, shareDialog } from '../sharing';
import { entryData, readZip } from '../../src/lib/formats/zip';

const box = await fileBox();
test.afterAll(() => box.remove());

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe.serial(`notes in mode ${mode}`, () => {
		let server: Server;
		let page: Page;
		const errors: string[] = [];

		test.beforeAll(async ({ browser }) => {
			test.setTimeout(120_000);
			server = await startServer({ mode });
			page = await (await browser.newContext({ acceptDownloads: true })).newPage();
			page.on('pageerror', (e) => errors.push(e.message));
			await openDrive(page, server, mode);
			await openNotes(page);
		});

		test.afterAll(async () => {
			await page.context().close();
			await server.stop();
		});

		test('quick capture makes a note, and Drive does not show the folder of notes', async () => {
			await page.getByLabel('Quick note').fill('Call the plumber');
			await page.getByLabel('Quick note').press('Enter');
			await expect(card(page, 'Call the plumber')).toBeVisible();
			await expect(page.getByTestId('notes-storage')).toContainText('1 note');
			await expect(page.getByTestId('notes-storage')).toContainText(
				mode === 'e2e' ? 'Markdown, encrypted files' : 'Markdown files'
			);
			await page
				.getByRole('navigation', { name: 'Apps' })
				.getByRole('link', { name: 'Drive' })
				.click();
			await expect(page.getByTestId('storage')).toBeVisible();
			await expect(row(page, 'Notes')).toHaveCount(0);
			await openNotes(page);
		});

		test('a note in a notebook, written in the editor', async () => {
			await newNotebook(page, 'Work');
			await notebookButton(page, 'Work').click();
			await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
			await page.getByRole('button', { name: 'New note', exact: true }).click();
			await expectNew(page);
			await setTitle(page, 'Sync engine');
			await typeInNote(page, 'Every write appends to a journal.');
			await saveNow(page);
			await backToList(page);
			await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
			await expect(card(page, 'Sync engine')).toContainText('Every write appends to a journal.');
		});

		test('a link typed with [[ shows as a backlink, and survives a rename', async () => {
			await page.getByRole('button', { name: 'New note', exact: true }).click();
			await expectNew(page);
			await setTitle(page, 'Planning');
			await typeInNote(page, 'Start with the [[Sync');
			const menu = page.getByRole('listbox', { name: 'Link to a note or file' });
			await expect(menu.getByRole('option', { name: /Sync engine/ })).toBeVisible();
			await page.keyboard.press('Enter');
			await page.keyboard.type('rewrite.');
			await expect(noteEditor(page).locator('a.node-link')).toHaveText('Sync engine');
			await saveNow(page);

			await noteEditor(page).locator('a.node-link').click();
			await expect(noteTitle(page)).toHaveValue('Sync engine');
			const side = page.getByTestId('note-side');
			await expect(side.getByRole('heading', { name: 'Backlinks · 1' })).toBeVisible();
			await expect(side.getByRole('button', { name: /Planning/ })).toContainText(
				'Start with the Sync engine rewrite.'
			);

			await setTitle(page, 'Sync engine v2');
			await side.getByRole('button', { name: /Planning/ }).click();
			await expect(noteTitle(page)).toHaveValue('Planning');
			await expect(
				page.getByTestId('note-side').getByRole('heading', { name: 'Links in this note · 1' })
			).toBeVisible();
			await expect(
				page.getByTestId('note-side').getByRole('button', { name: /Sync engine v2/ })
			).toBeVisible();
			await noteEditor(page).locator('a.node-link').click();
			await expect(noteTitle(page)).toHaveValue('Sync engine v2');
			await expect(
				page.getByTestId('note-side').getByRole('heading', { name: 'Backlinks · 1' })
			).toBeVisible();
		});

		test('an unlinked mention can be linked', async () => {
			await page.getByRole('button', { name: 'New note in Work' }).click();
			await expectNew(page);
			await setTitle(page, 'Diary');
			await typeInNote(page, 'The sync engine v2 beta is stable.');
			await saveNow(page);
			await page
				.getByRole('button', { name: /^Sync engine v2/ })
				.first()
				.click();
			await expect(noteTitle(page)).toHaveValue('Sync engine v2');
			const side = page.getByTestId('note-side');
			await expect(side.getByRole('heading', { name: 'Unlinked mentions · 1' })).toBeVisible();
			await side.getByRole('button', { name: 'Link it' }).click();
			await expect(side.getByText('Linked — now a backlink')).toBeVisible();
			await expect(side.getByRole('heading', { name: 'Backlinks · 2' })).toBeVisible({
				timeout: 20_000
			});
		});

		test('tags from the text and the editor filter the list', async () => {
			await page.getByRole('button', { name: 'New note in Work' }).click();
			await expectNew(page);
			await setTitle(page, 'Lisbon');
			await typeInNote(page, 'Pastries and trams #travel');
			await saveNow(page);
			await page.getByRole('button', { name: 'Add tag' }).click();
			await page.getByLabel('New tag').fill('Ideas');
			await page.getByLabel('New tag').press('Enter');
			await expect(page.getByText('#ideas')).toBeVisible();
			await backToList(page);
			await page
				.getByRole('region', { name: 'Tags' })
				.getByRole('button', { name: '#travel' })
				.click();
			await expect(page.getByRole('heading', { name: '#travel', level: 1 })).toBeVisible();
			await expect(page.getByTestId('note-card')).toHaveCount(1);
			await expect(card(page, 'Lisbon')).toBeVisible();
			await page
				.getByRole('region', { name: 'Tags' })
				.getByRole('button', { name: '#travel' })
				.click();
			await page.getByLabel('Search notes').fill('#ide');
			await page.getByRole('option', { name: /#ideas/ }).click();
			await expect(page.getByTestId('note-card')).toHaveCount(1);
			await page
				.getByRole('button', { name: /^#ideas/ })
				.last()
				.click();
			await expect(page.getByTestId('note-card').first()).toBeVisible();
		});

		test('words find notes through the on-device search, and [[ finds titles', async () => {
			await section(page, 'All notes');
			await page.getByLabel('Search notes').fill('pastries');
			await expect(page.getByTestId('note-card')).toHaveCount(1, { timeout: 20_000 });
			await expect(card(page, 'Lisbon')).toBeVisible();
			await page.getByLabel('Search notes').fill('[[plan');
			await expect(page.getByRole('option', { name: /Planning/ })).toBeVisible();
			await page.getByLabel('Search notes').fill('');
		});

		test('ticking a checklist moves the counts', async () => {
			await page.getByLabel('Quick note').fill('Groceries');
			await page.getByRole('button', { name: 'New checklist' }).click();
			await page.getByLabel('Quick note').press('Enter');
			await expectEditor(page);
			await typeInNote(page, 'Oat milk');
			await page.keyboard.press('Enter');
			await page.keyboard.type('Batteries');
			await saveNow(page);
			await backToList(page);
			await expect(card(page, 'Groceries').getByTestId('task-summary')).toHaveText('0 of 2 done');
			const tasks = page
				.getByRole('navigation', { name: 'Notes sections' })
				.getByRole('button', { name: /^Tasks/ });
			await expect(tasks).toContainText('2');

			await card(page, 'Groceries').getByRole('link').click();
			await expectEditor(page);
			await noteEditor(page).getByRole('checkbox').first().dispatchEvent('mousedown');
			await expect(noteEditor(page).getByRole('checkbox').first()).toHaveAttribute(
				'aria-checked',
				'true'
			);
			await saveNow(page);
			await backToList(page);
			await expect(card(page, 'Groceries').getByTestId('task-summary')).toHaveText('1 of 2 done');
			await expect(tasks).toContainText('1');
		});

		test('a pinned note comes first', async () => {
			await page.getByRole('button', { name: 'Pin Call the plumber' }).click();
			await expect(page.getByRole('heading', { name: 'Pinned', level: 2 })).toBeVisible();
			await expect(page.getByTestId('note-card').first()).toContainText('Call the plumber');
			await expect(page.getByRole('button', { name: 'Unpin Call the plumber' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			await section(page, 'Pinned');
			await expect(page.getByTestId('note-card')).toHaveCount(1);
			await section(page, 'All notes');
		});

		test('templates and today’s note', async () => {
			await page.getByRole('button', { name: 'Templates' }).click();
			await page.getByRole('menuitem', { name: 'Meeting notes' }).click();
			await expectEditor(page);
			await expect(noteTitle(page)).toHaveValue('Meeting notes');
			await expect(noteEditor(page).getByRole('heading', { name: 'Attendees' })).toBeVisible();
			await backToList(page);

			const today = await page.evaluate(() => {
				const d = new Date();
				const pad = (n: number) => String(n).padStart(2, '0');
				return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
			});
			await page.getByRole('button', { name: 'Today’s note' }).click();
			await expectEditor(page);
			await expect(noteTitle(page)).toHaveValue(today);
			await expect(page.getByRole('navigation', { name: 'Location' })).toContainText('Journal');
			await backToList(page);
			await page.getByRole('button', { name: 'Today’s note' }).click();
			await expect(noteTitle(page)).toHaveValue(today);
			await backToList(page);
			await expect(card(page, today)).toHaveCount(1);
		});

		test('a picture is kept as a file beside the note and drawn from it', async () => {
			await card(page, 'Lisbon').getByRole('link').click();
			await expectEditor(page);
			await typeInNote(page, ' ');
			await page.keyboard.press('Enter');
			await page.keyboard.type('/ima');
			await expect(page.getByRole('option', { name: /Image or file/ })).toBeVisible();
			const chooser = page.waitForEvent('filechooser');
			await page.keyboard.press('Enter');
			await (await chooser).setFiles({ name: 'tram.png', mimeType: 'image/png', buffer: png() });
			const img = noteEditor(page).getByRole('img', { name: 'tram' });
			await expect(img).toHaveAttribute('src', /^blob:/);
			await saveNow(page);
			await page.reload();
			await expectEditor(page);
			await expect(noteEditor(page).getByRole('img', { name: 'tram' })).toHaveAttribute(
				'src',
				/^blob:/,
				{
					timeout: 30_000
				}
			);
			await page.getByRole('tab', { name: 'Info' }).click();
			await expect(page.getByTestId('note-side')).toContainText(/Attachments\s*1 ·/);
			await backToList(page);
			await page.getByRole('button', { name: 'Attachments' }).click();
			await expect(page.getByTestId('note-card')).toHaveCount(1);
			await page.getByRole('button', { name: 'Attachments' }).click();
		});

		test('a shared notebook shows in the other person’s Shared section', async ({ browser }) => {
			test.setTimeout(180_000);
			const bob = await addUser(browser, page, server, 'bob', mode);
			try {
				await openNotes(page);
				await page.getByRole('button', { name: 'Work options' }).click();
				await page.getByRole('menuitem', { name: 'Share…' }).click();
				const dialog = shareDialog(page, 'Work');
				await dialog.getByLabel('Username').fill('bob');
				await dialog.getByRole('button', { name: 'Share', exact: true }).click();
				await expect(dialog.getByTestId('person').filter({ hasText: 'bob' })).toBeVisible();
				await dialog.getByRole('button', { name: 'Done' }).click();

				await refocus(bob);
				await openNotes(bob);
				await section(bob, 'Shared');
				await expect(card(bob, 'Sync engine v2')).toBeVisible({ timeout: 30_000 });
				await card(bob, 'Sync engine v2').getByRole('link').click();
				await expect(noteEditor(bob)).toContainText('Every write appends to a journal.', {
					timeout: 30_000
				});
			} finally {
				await bob.context().close();
			}
		});

		test('one note exports as Markdown and HTML, and goes to Drive as a document', async () => {
			await openNotes(page);
			await card(page, 'Planning').getByRole('link').click();
			await expectEditor(page);
			await page.getByRole('tab', { name: 'Info' }).click();
			const side = page.getByTestId('note-side');
			let started = page.waitForEvent('download');
			await side.getByRole('button', { name: 'Markdown' }).click();
			const md = await readFile(await (await started).path(), 'utf8');
			expect(md).toMatch(
				/^Start with the \[Sync engine\]\(yondrive:node\/[0-9a-f]{32}\) rewrite\.\n$/
			);
			started = page.waitForEvent('download');
			await side.getByRole('button', { name: 'HTML' }).click();
			const html = await readFile(await (await started).path(), 'utf8');
			expect(html).toContain('<h1>Planning</h1>');
			expect(html).not.toContain('yondrive:');
			await side.getByRole('button', { name: 'Save to Drive as Doc' }).click();
			await expect(page.getByText('Saved to My files as “Planning.docx”.')).toBeVisible({
				timeout: 30_000
			});
		});

		test('the export is plain Markdown with links that point at the files', async () => {
			await openNotes(page);
			const started = page.waitForEvent('download');
			await page.getByRole('button', { name: 'Export all notes' }).click();
			const download = await started;
			const zip = readZip(new Uint8Array(await readFile(await download.path())));
			const names = zip.entries.map((e) => e.name);
			expect(names).toContain('Work/Planning.md');
			expect(names).toContain('Work/Sync engine v2.md');
			expect(names).toContain('Work/tram.png');
			const planning = new TextDecoder().decode(await entryData(zip.get('Work/Planning.md')!));
			expect(planning).toContain('[Sync engine](Sync%20engine%20v2.md)');
			const lisbon = new TextDecoder().decode(await entryData(zip.get('Work/Lisbon.md')!));
			expect(lisbon).toContain('](tram.png)');
			// Every relative link reaches a file of the export.
			for (const e of zip.entries.filter((x) => x.name.endsWith('.md'))) {
				const text = new TextDecoder().decode(await entryData(e));
				expect(text).not.toContain('yondrive:');
				const dir = e.name.includes('/') ? e.name.slice(0, e.name.lastIndexOf('/') + 1) : '';
				for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
					const target = decodeURIComponent(m[1])
						.split('/')
						.reduce<string[]>((parts, p) => {
							if (p === '..') parts.pop();
							else parts.push(p);
							return parts;
						}, dir.split('/').filter(Boolean));
					expect(names).toContain(target.join('/'));
				}
			}
		});

		test('on a phone, the list and the editor fit the screen', async () => {
			await page.setViewportSize({ width: 390, height: 844 });
			await page.goto(`${server.url}/notes`);
			await reopenNotes(page);
			if (await page.getByRole('heading', { name: 'Unlock' }).isVisible()) {
				await page.getByLabel(/^Passphrase/).fill('correct horse battery staple');
				await page.getByRole('button', { name: 'Unlock' }).click();
			}
			await expect(page.getByRole('heading', { name: 'All notes', level: 1 })).toBeVisible({
				timeout: 30_000
			});
			const fits = () =>
				page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
			expect(await fits()).toBe(true);
			await card(page, 'Planning').getByRole('link').click();
			await expectEditor(page);
			await expect(page.getByTestId('note-side')).toHaveCount(0);
			expect(await fits()).toBe(true);
			await page.getByRole('button', { name: 'Toggle links and info' }).click();
			await expect(page.getByTestId('note-side')).toBeVisible();
			await page.getByTestId('note-side').getByRole('button', { name: 'Close the panel' }).click();
			await expect(page.getByTestId('note-side')).toHaveCount(0);
			await page.setViewportSize({ width: 1280, height: 800 });
		});

		test('a reminder comes up while the app is open', async () => {
			await page.clock.install();
			await page.goto(`${server.url}/notes`);
			await reopenNotes(page);
			if (await page.getByRole('heading', { name: 'Unlock' }).isVisible()) {
				await page.getByLabel(/^Passphrase/).fill('correct horse battery staple');
				await page.getByRole('button', { name: 'Unlock' }).click();
			}
			await expect(page.getByRole('heading', { name: 'All notes', level: 1 })).toBeVisible({
				timeout: 30_000
			});
			await card(page, 'Call the plumber').getByRole('link').click();
			await expectEditor(page);
			await page.getByRole('button', { name: 'Reminder' }).click();
			const when = await page.evaluate(() => {
				const d = new Date(Date.now() + 5 * 60_000);
				const pad = (n: number) => String(n).padStart(2, '0');
				return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
			});
			const dialog = page.getByRole('dialog', { name: 'Reminder' });
			await dialog.getByLabel('Remind me at').fill(when);
			await dialog.getByRole('button', { name: 'Set reminder' }).click();
			await expect(page.locator('.reminder.set')).toBeVisible();
			await expect(page.getByText('Reminder: Call the plumber')).toHaveCount(0);
			await page.clock.fastForward('10:00');
			await expect(page.getByText('Reminder: Call the plumber')).toBeVisible({ timeout: 15_000 });
			await backToList(page);
			await expect(page.getByTestId('notifications')).toHaveAccessibleName(/Notifications, 1 new/);
		});

		test('nothing failed in the page', () => {
			expect(errors).toEqual([]);
		});
	});
}
