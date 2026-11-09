/**
 * Comments: two people comment on a shared document, spreadsheet and note, in both
 * modes. The commenter can comment and not edit; a passage is found again after the
 * text around it changes, and a cell's thread moves when rows are inserted above it;
 * commenting leaves a file's bytes as they were; a comment whose author the server
 * forges is refused; and the canary checks that comment bodies never reach the
 * server in end-to-end mode, and never reach the logs in any mode.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { downloadAs, editor, fixture, openDoc, saveNow as saveDoc, typeAfter } from '../docs';
import { fileBox, inPage, newFolder, openDrive, openFolder, reopenDrive, upload } from '../drive';
import { captureRequests, findIn, scanDir } from '../scan';
import { startServer, type Mode, type Server } from '../server';
import { addUser, openShared, refocus, shareDialog, shareWith, statusOf } from '../sharing';
import { cell, goTo, grid, openSheet, saveNow as saveSheet } from '../sheets';
import { expectNew, noteEditor, openNotes, setTitle, typeInNote } from '../notes';
import { PASSPHRASE, submitUnlock } from '../flows';

const box = await fileBox();

test.afterAll(() => box.remove());

const panel = (page: Page) => page.getByRole('region', { name: 'Comments' });
const threads = (page: Page) => panel(page).getByTestId('comment-thread');

/** Selects the first place `text` appears inside an editor, as a person dragging would. */
async function select(page: Page, within: Locator, text: string): Promise<void> {
	await within.evaluate((el, text) => {
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const at = (n.textContent ?? '').indexOf(text);
			if (at < 0) continue;
			(el as HTMLElement).focus();
			const range = document.createRange();
			range.setStart(n, at);
			range.setEnd(n, at + text.length);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			return;
		}
		throw new Error(`not in the editor: ${text}`);
	}, text);
	await page.waitForTimeout(100);
}

/** After a page load somewhere in the app: unlocks if asked, then waits for `ready`. */
async function arrive(page: Page, ready: Locator): Promise<void> {
	const unlock = page.getByRole('heading', { name: 'Unlock' });
	await expect(unlock.or(ready)).toBeVisible({ timeout: 30_000 });
	if (await unlock.isVisible()) {
		// A new tab unlocks to Home: back to where it was going.
		const url = page.url();
		await submitUnlock(page, PASSPHRASE);
		await expect(page.getByTestId('storage').or(ready)).toBeVisible({ timeout: 30_000 });
		if (!(await ready.isVisible())) await page.goto(url);
	}
	await expect(ready).toBeVisible({ timeout: 30_000 });
}

async function openComments(page: Page): Promise<void> {
	if (await panel(page).isVisible()) return;
	await page.getByRole('button', { name: /^Comments/ }).click();
	await expect(panel(page)).toBeVisible();
}

async function comment(page: Page, text: string): Promise<void> {
	await openComments(page);
	await panel(page).getByLabel('New comment').fill(text);
	await panel(page).getByRole('button', { name: 'Comment', exact: true }).click();
	await expect(threads(page).filter({ hasText: text })).toBeVisible({ timeout: 30_000 });
}

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe(`in mode ${mode}`, () => {
		let server: Server;

		test.beforeAll(async () => {
			server = await startServer({ mode });
		});

		test.afterAll(async () => {
			await server.stop();
		});

		test('two people comment on a document, a spreadsheet and a note', async ({ browser }) => {
			test.setTimeout(420_000);
			const words = {
				doc: `canary-comment-doc-Rk27m9-${mode}`,
				reply: `canary-comment-reply-Vt41q2-${mode}`,
				sheet: `canary-comment-cell-Hp83w5-${mode}`,
				note: `canary-comment-note-Zc56x8-${mode}`
			};
			const alice = await (await browser.newContext({ acceptDownloads: true })).newPage();
			await openDrive(alice, server, mode);
			const bob = await addUser(browser, alice, server, 'bob', mode);
			const sent = [captureRequests(alice), captureRequests(bob)];

			const folder = `Team ${mode}`;
			const docx = await fixture('docs/sample.docx');
			const xlsx = await fixture('book.xlsx');
			await newFolder(alice, folder);
			await openFolder(alice, folder);
			await upload(alice, await box.add(`plan-${mode}.docx`, docx));
			await upload(alice, await box.add(`book-${mode}.xlsx`, xlsx));
			await alice.goto(server.url);
			await reopenDrive(alice);
			await shareWith(alice, folder, 'bob', 'commenter');
			await shareDialog(alice, folder).getByRole('button', { name: 'Done' }).click();

			// Bob comments on a passage of the document, which he cannot edit.
			await refocus(bob);
			await openShared(bob);
			await openFolder(bob, folder);
			await openDoc(bob, `plan-${mode}.docx`);
			await expect(bob.getByTestId('save-status')).toHaveText('View only');
			await expect(editor(bob)).toHaveAttribute('contenteditable', 'false');
			const docId = new URL(bob.url()).pathname.split('/').pop() as string;
			expect(await statusOf(bob, 'PUT', `/nodes/${docId}/editing`)).toBe(403);
			await select(bob, editor(bob), 'for more.');
			await openComments(bob);
			await expect(panel(bob).getByTestId('comment-about')).toContainText('for more.');
			await comment(bob, words.doc);
			await expect(editor(bob).locator('.comment-mark')).toHaveText('for more.');
			const before = await inPage<{ current_version: string }>(bob, 'GET', `/nodes/${docId}`);

			// Alice hears of it from the bell, which takes her to the document.
			await refocus(alice);
			const bell = alice.getByTestId('notifications');
			await expect(bell).toHaveAccessibleName(/new/, { timeout: 30_000 });
			await bell.click();
			await alice.getByRole('menuitem', { name: `A new comment on plan-${mode}.docx` }).click();
			await expect(editor(alice)).toBeVisible({ timeout: 30_000 });
			expect(new URL(alice.url()).pathname).toBe(`/doc/${docId}`);

			// She reads it, replies, and her document's bytes are as they were.
			await openComments(alice);
			const thread = threads(alice).filter({ hasText: words.doc });
			await expect(thread).toContainText('bob');
			await expect(thread).toContainText('“for more.”');
			await expect(editor(alice).locator('.comment-mark')).toHaveText('for more.');
			await thread.getByRole('button', { name: 'Reply' }).click();
			await thread.getByLabel('Reply').fill(words.reply);
			await thread.getByRole('button', { name: 'Reply', exact: true }).last().click();
			await expect(thread).toContainText(words.reply);
			expect((await downloadAs(alice, /Original/)).equals(docx)).toBe(true);
			const after = await inPage<{ current_version: string }>(alice, 'GET', `/nodes/${docId}`);
			expect(after.current_version).toBe(before.current_version);

			// The text around the passage changes, and the thread still finds it.
			await typeAfter(alice, 'for more.', ' Added after.');
			await saveDoc(alice);
			await alice.reload();
			await arrive(alice, editor(alice));
			await openComments(alice);
			await expect(editor(alice).locator('.comment-mark')).toHaveText('for more.');
			await expect(threads(alice).filter({ hasText: words.doc })).not.toContainText(
				'Text no longer found'
			);
			// Only an editor resolves.
			await expect(threads(bob).getByRole('button', { name: 'Resolve' })).toHaveCount(0);
			await threads(alice)
				.filter({ hasText: words.doc })
				.getByRole('button', { name: 'Resolve' })
				.click();
			await expect(threads(alice)).toHaveCount(0);

			// A comment whose author the server forges is refused, where a signature can say so.
			// The answers to his own tab are rewritten as a hostile server would send them.
			if (mode === 'e2e') {
				const aliceId = (await inPage<{ owner_id: string }>(alice, 'GET', `/nodes/${docId}`))
					.owner_id;
				await bob.route('**/api/v1/nodes/*/comments*', async (route) => {
					if (route.request().method() !== 'GET') return route.continue();
					const res = await route.fetch();
					const body = (await res.json()) as { comments: { author_id: string }[] };
					for (const c of body.comments) c.author_id = aliceId;
					await route.fulfill({ response: res, json: body });
				});
				await bob.reload();
				await arrive(bob, editor(bob));
				await openComments(bob);
				await expect(panel(bob)).toContainText('Some comments could not be verified');
				await expect(panel(bob).getByTestId('comment')).toHaveCount(0);
				await bob.unroute('**/api/v1/nodes/*/comments*');
			}

			// The spreadsheet: Bob comments on a cell, Alice inserts rows above it.
			await bob.goto(server.url);
			await reopenDrive(bob);
			await openShared(bob);
			await openFolder(bob, folder);
			await openSheet(bob, `book-${mode}.xlsx`);
			const sheetId = new URL(bob.url()).pathname.split('/').pop() as string;
			await goTo(bob, 'B5');
			await openComments(bob);
			await expect(panel(bob).getByTestId('comment-about')).toContainText('Cell B5');
			await comment(bob, words.sheet);
			await expect(cell(bob, 'B5').getByTestId('comment-mark')).toHaveCount(1);
			const sheetBefore = await inPage<{ current_version: string }>(
				bob,
				'GET',
				`/nodes/${sheetId}`
			);

			await alice.goto(`${server.url}/sheet/${sheetId}`);
			await arrive(alice, grid(alice));
			await expect(cell(alice, 'B5').getByTestId('comment-mark')).toHaveCount(1);
			expect((await downloadAs(alice, /Original/)).equals(xlsx)).toBe(true);
			const sheetAfter = await inPage<{ current_version: string }>(
				alice,
				'GET',
				`/nodes/${sheetId}`
			);
			expect(sheetAfter.current_version).toBe(sheetBefore.current_version);
			await cell(alice, 'B2').click({ button: 'right' });
			await alice.getByRole('menuitem', { name: 'Insert row above' }).click();
			// The file has a chart, whose ranges stay: a warning first.
			await alice
				.getByRole('dialog', { name: 'Some ranges will not move' })
				.getByRole('button', { name: 'Continue' })
				.click();
			await expect(cell(alice, 'B6').getByTestId('comment-mark')).toHaveCount(1);
			await saveSheet(alice);
			await openComments(alice);
			await expect(threads(alice).filter({ hasText: words.sheet })).toContainText('Cell B6', {
				timeout: 30_000
			});
			await bob.reload();
			await arrive(bob, grid(bob));
			await expect(cell(bob, 'B6').getByTestId('comment-mark')).toHaveCount(1);
			await expect(cell(bob, 'B5').getByTestId('comment-mark')).toHaveCount(0);
			// Alice is editing; Bob, who cannot save, is told only that it may change.
			await expect(bob.getByTestId('editing-quiet')).toContainText('is editing this', {
				timeout: 40_000
			});
			await expect(bob.getByTestId('editing-warning')).toHaveCount(0);

			// Deleting the row loses the cell; undoing it finds it again, and so does the save.
			await cell(alice, 'B6').click({ button: 'right' });
			await alice.getByRole('menuitem', { name: 'Delete row' }).click();
			const ranges = alice.getByRole('dialog', { name: 'Some ranges will not move' });
			if (await ranges.isVisible()) await ranges.getByRole('button', { name: 'Continue' }).click();
			await expect(threads(alice).filter({ hasText: words.sheet })).toContainText(
				'Cell no longer there'
			);
			await grid(alice).focus();
			await alice.keyboard.press('Control+z');
			await expect(cell(alice, 'B6').getByTestId('comment-mark')).toHaveCount(1);
			await saveSheet(alice);
			await alice.reload();
			await arrive(alice, grid(alice));
			await expect(cell(alice, 'B6').getByTestId('comment-mark')).toHaveCount(1, {
				timeout: 30_000
			});

			// A note of Alice's, shared on its own with Bob.
			await alice.goto(server.url);
			await reopenDrive(alice);
			await openNotes(alice);
			await alice.getByRole('button', { name: 'New note', exact: true }).click();
			await expectNew(alice);
			await setTitle(alice, `Plan ${mode}`);
			await typeInNote(alice, 'Ship the boats on Friday.');
			await expect(alice.getByTestId('save-status')).toHaveText('Saved', { timeout: 30_000 });
			const noteId = new URL(alice.url()).pathname.split('/').pop() as string;
			await alice.getByRole('button', { name: 'More options' }).click();
			await alice.getByRole('menuitem', { name: 'Share…' }).click();
			const dialog = alice.getByRole('dialog', { name: /^Share / });
			await dialog.getByLabel('Username').fill('bob');
			await dialog.getByLabel('Role', { exact: true }).selectOption('commenter');
			await dialog.getByRole('button', { name: 'Share', exact: true }).click();
			await dialog.getByRole('button', { name: 'Done' }).click();

			await bob.goto(`${server.url}/notes/${noteId}`);
			await arrive(bob, noteEditor(bob));
			await expect(noteEditor(bob)).toContainText('Ship the boats');
			await select(bob, noteEditor(bob), 'the boats');
			await bob.getByRole('button', { name: /^Comments/ }).click();
			await expect(panel(bob).getByTestId('comment-about')).toContainText('the boats');
			await comment(bob, words.note);
			await expect(noteEditor(bob).locator('.comment-mark')).toHaveText('the boats');

			await alice.reload();
			await arrive(alice, noteEditor(alice));
			await alice.getByRole('button', { name: 'More options' }).click();
			await alice.getByRole('menuitem', { name: 'Comments' }).click();
			await expect(threads(alice).filter({ hasText: words.note })).toContainText('bob');
			await expect(noteEditor(alice).locator('.comment-mark')).toHaveText('the boats');

			// It looked at the real thing.
			const requests = Buffer.from(sent.flat().join('\n'));
			expect(sent.flat().join('\n')).toContain('/comments');
			const logs = Buffer.from(server.logs());
			expect(findIn(logs, words)).toEqual([]);
			if (mode === 'e2e') {
				expect(findIn(requests, words)).toEqual([]);
				expect(await scanDir(server.dataDir, words)).toEqual([]);
			} else {
				// Readable on disk, as the mode promises.
				expect(await scanDir(server.dataDir, { doc: words.doc })).not.toEqual([]);
			}
			for (const page of [bob, alice]) await page.context().close();
		});
	});
}
