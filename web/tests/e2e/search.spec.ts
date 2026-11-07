/**
 * Search through the app, in both modes: by name, tag and text, what others share, and
 * what is gone. Throughout, nothing typed may leave the page or enter its address.
 */
import { expect, test, type Page } from '@playwright/test';
import {
	act,
	expectDriveReady,
	fileBox,
	myFiles,
	newFolder,
	openDrive,
	openFolder,
	reopenDrive,
	row,
	upload
} from '../drive';
import { expectFound, expectIndexed, hits, openSearch } from '../search';
import { captureRequests, findIn } from '../scan';
import { startServer, type Mode, type Server } from '../server';
import { addUser, person, refocus, shareDialog, shareWith } from '../sharing';

const box = await fileBox();

test.afterAll(() => box.remove());

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe.serial(`in mode ${mode}`, () => {
		let server: Server;
		let alice: Page;
		let sent: string[];

		test.beforeAll(async ({ browser }) => {
			test.setTimeout(120_000);
			server = await startServer({ mode });
			alice = await (await browser.newContext()).newPage();
			sent = captureRequests(alice);
			await openDrive(alice, server, mode);
		});

		test.afterAll(async () => {
			await server.stop();
		});

		test('finds a file by its name, as a prefix, and by what is in it', async () => {
			test.setTimeout(120_000);
			await upload(
				alice,
				await box.add('Quarterly-report.txt', Buffer.from('the marmalade committee met on Tuesday'))
			);
			await expectFound(alice, 'quart', ['Quarterly-report.txt']);
			await expectFound(alice, 'REPORT', ['Quarterly-report.txt']);
			await expectFound(alice, 'marmalade', ['Quarterly-report.txt']);
			await expectFound(alice, 'marmalade tues', ['Quarterly-report.txt']);
			await expectFound(alice, 'marmalade nonsense', []);
		});

		test('finds a folder, and shows where things are', async () => {
			test.setTimeout(120_000);
			await newFolder(alice, 'Archive');
			await openFolder(alice, 'Archive');
			await upload(alice, await box.add('inner-note.md', Buffer.from('# the walrus chapter')));
			await myFiles(alice);
			await expectFound(alice, 'archive', ['Archive']);
			await openSearch(alice, 'walrus');
			await expect(hits(alice).first()).toContainText('inner-note.md');
			await expect(hits(alice).first()).toContainText('My files / Archive');
			await expect(hits(alice).first()).toContainText('In the text');
			await alice.keyboard.press('Escape');
		});

		test('a file opens from the results, and its folder is one click away', async () => {
			test.setTimeout(60_000);
			await openSearch(alice, 'walrus');
			await expect(hits(alice)).toHaveCount(1);
			await alice.keyboard.press('Enter');
			await expect(alice.getByRole('dialog', { name: /inner-note/ })).toBeVisible();
			await alice.keyboard.press('Escape');

			await openSearch(alice, 'walrus');
			await hits(alice).first().getByText('Go to folder').click();
			await expect(alice.getByRole('heading', { name: 'Archive', exact: true })).toBeVisible();
			await myFiles(alice);

			// The keyboard's way there, as an option holds no button of its own.
			await openSearch(alice, 'walrus');
			await expect(hits(alice)).toHaveCount(1);
			await alice.keyboard.press('Shift+Enter');
			await expect(alice.getByRole('heading', { name: 'Archive', exact: true })).toBeVisible();
			await myFiles(alice);
		});

		test('a folder goes on screen from the results', async () => {
			await openSearch(alice, 'archive');
			await expect(hits(alice)).toHaveCount(1);
			await hits(alice).first().click();
			await expect(alice.getByRole('heading', { name: 'Archive', exact: true })).toBeVisible();
			await myFiles(alice);
		});

		test('finds tags, and filters narrow it down', async () => {
			test.setTimeout(120_000);
			await act(alice, 'Quarterly-report.txt', 'Tags');
			const dialog = alice.getByRole('dialog', { name: 'Tags of Quarterly-report.txt' });
			await dialog.getByLabel('New tag').fill('Paperwork');
			await dialog.getByRole('button', { name: 'Add' }).click();
			await expect(row(alice, 'Quarterly-report.txt')).toContainText('Paperwork');
			await dialog.getByRole('button', { name: 'Done' }).click();
			await expectFound(alice, 'paperw', ['Quarterly-report.txt']);

			await openSearch(alice, '');
			const palette = alice.getByTestId('search-palette');
			await palette.getByLabel('Tag').selectOption({ label: 'Paperwork' });
			await expect(hits(alice).locator('.name')).toHaveText(['Quarterly-report.txt']);
			await palette.getByLabel('Tag').selectOption({ label: 'Any tag' });
			await palette.getByLabel('Type').selectOption('folders');
			await expect(hits(alice).locator('.name')).toHaveText(['Archive']);
			await palette.getByLabel('Type').selectOption('images');
			await expect(alice.getByTestId('search-empty')).toBeVisible();
			await palette.getByLabel('Type').selectOption('all');
			await palette.getByLabel('Whose').selectOption('with-me');
			await expect(alice.getByTestId('search-empty')).toBeVisible();
			await palette.getByLabel('Whose').selectOption('any');
			await palette.getByLabel('Changed').selectOption('week');
			await expect(hits(alice).first()).toBeVisible();
			await alice.keyboard.press('Escape');
		});

		test('the top bar field opens the same search, and says how the index is doing', async () => {
			const field = alice.getByRole('search').getByRole('searchbox');
			await field.click();
			await expect(alice.getByRole('combobox', { name: 'Search for' })).toBeFocused();
			await expect(alice.getByTestId('search-status')).toContainText('indexed on this device');
			await alice.keyboard.press('Escape');
			await expect(alice.getByTestId('search-palette')).toHaveCount(0);
		});

		test('a rename shows, and what is trashed drops out with what is under it', async () => {
			test.setTimeout(120_000);
			await act(alice, 'Quarterly-report.txt', 'Rename');
			const dialog = alice.getByRole('dialog', { name: /Rename/ });
			await dialog.getByLabel('Name').fill('Annual-report.txt');
			await dialog.getByRole('button', { name: 'Rename' }).click();
			await expect(row(alice, 'Annual-report.txt')).toBeVisible();
			await expectFound(alice, 'annual', ['Annual-report.txt']);
			await expectFound(alice, 'quarterly', []);
			await expectFound(alice, 'marmalade', ['Annual-report.txt']);

			await act(alice, 'Archive', 'Move to trash');
			await expectFound(alice, 'archive', []);
			await expectFound(alice, 'walrus', []);
		});

		test('it is all still there after a reload, from the stored index', async () => {
			test.setTimeout(120_000);
			await expectIndexed(alice);
			await expect
				.poll(() => sent.filter((one) => /^PUT \S*\/blobs\/\S*kind=index/.test(one)).length, {
					timeout: 30_000
				})
				.toBeGreaterThan(0);
			await alice.reload();
			await reopenDrive(alice);
			await expectFound(alice, 'marmalade', ['Annual-report.txt']);
			await expectFound(alice, 'paperw', ['Annual-report.txt']);
		});

		test('nothing searched for leaves the page or enters the address', async () => {
			test.setTimeout(60_000);
			const start = sent.length;
			const urls: string[] = [];
			alice.on('framenavigated', (frame) => urls.push(frame.url()));
			await openSearch(alice, 'zebraquiltneverindexed');
			await expect(alice.getByTestId('search-empty')).toBeVisible();
			await alice.getByRole('combobox', { name: 'Search for' }).fill('marmalade');
			await expect(hits(alice)).toHaveCount(1);
			await alice.getByRole('combobox', { name: 'Search for' }).fill('zebraquiltneverindexed');
			await expect(alice.getByTestId('search-empty')).toBeVisible();
			await alice.keyboard.press('Escape');

			const after = sent.slice(start).join('\n');
			expect(findIn(Buffer.from(after), { typed: 'zebraquiltneverindexed' })).toEqual([]);
			expect(alice.url()).not.toContain('zebra');
			for (const url of urls) expect(url).not.toContain('zebra');
			expect(
				await alice.evaluate(
					() => history.state === null || !JSON.stringify(history.state).includes('zebra')
				)
			).toBe(true);
		});

		test('a grantee finds what is shared, by name and text, and loses it when revoked', async ({
			browser
		}) => {
			test.setTimeout(240_000);
			await newFolder(alice, 'Together');
			await openFolder(alice, 'Together');
			await upload(alice, await box.add('common-plan.txt', Buffer.from('the pelican strategy')));
			await myFiles(alice);

			const bob = await addUser(browser, alice, server, 'bob', mode);
			await shareWith(alice, 'Together', 'bob');
			const dialog = shareDialog(alice, 'Together');
			await expect(person(alice, 'bob')).toBeVisible();
			await dialog.getByRole('button', { name: 'Done' }).click();

			await expect(async () => {
				await refocus(bob);
				await expectFound(bob, 'common', ['common-plan.txt']);
			}).toPass({ timeout: 60_000 });
			await expectFound(bob, 'pelican', ['common-plan.txt']);
			await openSearch(bob, 'common');
			await expect(hits(bob).first()).toContainText('Shared with me / Together');
			await expect(hits(bob).first()).toContainText('Shared');
			await bob.getByTestId('search-palette').getByLabel('Whose').selectOption('with-me');
			await expect(hits(bob)).toHaveCount(1);
			await bob.getByTestId('search-palette').getByLabel('Whose').selectOption('mine');
			await expect(bob.getByTestId('search-empty')).toBeVisible();
			await bob.keyboard.press('Escape');

			await alice.goto(`${server.url}/`);
			await reopenDrive(alice);
			await act(alice, 'Together', 'Share');
			const again = shareDialog(alice, 'Together');
			await again.getByRole('button', { name: 'Revoke bob' }).click();
			await again.getByRole('button', { name: 'Revoke and replace keys' }).click();
			await expect(alice.getByText('no longer has access')).toBeVisible({ timeout: 30_000 });
			await again.getByRole('button', { name: 'Done' }).click();

			await expect(async () => {
				await refocus(bob);
				await expectFound(bob, 'common', []);
			}).toPass({ timeout: 60_000 });
			await expectFound(bob, 'pelican', []);
			await bob.context().close();
		});

		test('someone else’s index tells nothing', async ({ browser }) => {
			test.setTimeout(120_000);
			const carol = await addUser(browser, alice, server, 'carol', mode);
			await expectDriveReady(carol);
			await expectFound(carol, 'marmalade', []);
			await carol.context().close();
		});
	});
}
