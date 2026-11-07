/** Folders, names, the trash, versions and another user, in both modes. */
import { expect, test, type Page } from '@playwright/test';
import {
	act,
	download,
	expectDriveReady,
	fileBox,
	inPage,
	myFiles,
	newFolder,
	openDrive,
	openFolder,
	reopenDrive,
	row,
	upload,
	uploadRow
} from '../drive';
import { createInvite, register, signIn } from '../flows';
import { startServer, type Mode, type Server } from '../server';

const box = await fileBox();

test.afterAll(() => box.remove());

async function rename(page: Page, from: string, to: string) {
	await act(page, from, 'Rename');
	const dialog = page.getByRole('dialog', { name: 'Rename' });
	await dialog.getByLabel('Name').fill(to);
	await dialog.getByRole('button', { name: 'Rename' }).click();
	return dialog;
}

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe.serial(`in mode ${mode}`, () => {
		let server: Server;
		let page: Page;

		test.beforeAll(async ({ browser }) => {
			server = await startServer({ mode });
			page = await (await browser.newContext({ acceptDownloads: true })).newPage();
			await openDrive(page, server, mode);
		});

		test.afterAll(async () => {
			await page.context().close();
			await server.stop();
		});

		test('creates folders and moves a file between them, with its bytes intact', async () => {
			await newFolder(page, 'Source');
			await newFolder(page, 'Target');
			await openFolder(page, 'Source');
			const file = await box.add('travels.txt', Buffer.from('still readable after a move'));
			await upload(page, file);

			await act(page, file.name, 'Move');
			const dialog = page.getByRole('dialog', { name: `Move ${file.name}` });
			await dialog.getByRole('button', { name: 'Target' }).click();
			await dialog.getByRole('button', { name: 'Move here' }).click();
			await expect(dialog).toHaveCount(0);
			await expect(row(page, file.name)).toHaveCount(0);

			await page.reload();
			await expectDriveReady(page);
			await myFiles(page);
			await openFolder(page, 'Target');
			await expect(row(page, file.name)).toBeVisible();
			expect((await download(page, file.name)).toString()).toBe('still readable after a move');

			const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
			await expect(crumbs).toContainText('My files');
			await expect(crumbs).toContainText('Target');
			await myFiles(page);
		});

		test('moves a folder with what is in it, and not into itself', async () => {
			await newFolder(page, 'Outer');
			await openFolder(page, 'Outer');
			await newFolder(page, 'Inner');
			await myFiles(page);
			await act(page, 'Outer', 'Move');
			const dialog = page.getByRole('dialog', { name: 'Move Outer' });
			await expect(dialog.getByRole('button', { name: 'Outer' })).toBeDisabled();
			await dialog.getByRole('button', { name: 'Target' }).click();
			await dialog.getByRole('button', { name: 'Move here' }).click();
			await expect(dialog).toHaveCount(0);

			await page.reload();
			await expectDriveReady(page);
			await myFiles(page);
			await openFolder(page, 'Target');
			await openFolder(page, 'Outer');
			await expect(row(page, 'Inner')).toBeVisible();
			await myFiles(page);
		});

		test('renames, and keeps the name after a reload', async () => {
			const file = await box.add('before.txt', Buffer.from('named'));
			await upload(page, file);
			const dialog = await rename(page, 'before.txt', 'after.txt');
			await expect(dialog).toHaveCount(0);
			await expect(row(page, 'after.txt')).toBeVisible();

			await page.reload();
			await expectDriveReady(page);
			await myFiles(page);
			await expect(row(page, 'after.txt')).toBeVisible();
			await expect(row(page, 'before.txt')).toHaveCount(0);
		});

		test('refuses a duplicate name, in words, whatever its case', async () => {
			await page.getByRole('button', { name: 'New', exact: true }).click();
			await page.getByRole('menuitem', { name: 'New folder' }).click();
			const create = page.getByRole('dialog', { name: 'New folder' });
			await create.getByLabel('Name').fill('SOURCE');
			await create.getByRole('button', { name: 'Create' }).click();
			await expect(create).toContainText('already in this folder');
			await create.getByRole('button', { name: 'Cancel' }).click();

			const dialog = await rename(page, 'Target', 'source');
			await expect(dialog).toContainText('already in this folder');
			await dialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(row(page, 'Target')).toBeVisible();
		});

		test('trashes, shows the grace, and restores', async () => {
			const file = await box.add('binned.txt', Buffer.from('in and out of the trash'));
			await upload(page, file);
			await act(page, file.name, 'Move to trash');
			await expect(row(page, file.name)).toHaveCount(0);

			await page.getByRole('link', { name: /^Trash/ }).click();
			await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
			await expect(row(page, file.name)).toBeVisible();
			await expect(page.getByText(/grace period/)).toBeVisible();

			await act(page, file.name, 'Delete forever');
			const confirm = page.getByRole('dialog', { name: 'Delete forever?' });
			await expect(confirm).toContainText('restore it');
			await confirm.getByRole('button', { name: 'Delete forever' }).click();
			await expect(row(page, file.name)).toContainText('Removed for good on');

			await act(page, file.name, 'Restore');
			await expect(row(page, file.name)).toHaveCount(0);
			await myFiles(page);
			expect((await download(page, file.name)).toString()).toBe('in and out of the trash');
		});

		test('empties the trash, which still gives a way back', async () => {
			const file = await box.add('emptied.txt', Buffer.from('gone soon'));
			await upload(page, file);
			await act(page, file.name, 'Move to trash');
			await page.getByRole('link', { name: /^Trash/ }).click();
			await page.getByRole('button', { name: 'Empty trash' }).click();
			await page
				.getByRole('dialog', { name: 'Empty the trash?' })
				.getByRole('button', { name: 'Empty trash' })
				.click();
			await expect(row(page, file.name)).toContainText('Removed for good on');
			await act(page, file.name, 'Restore');
			await myFiles(page);
			await expect(row(page, file.name)).toBeVisible();
		});

		test('versions: lists, restores with the right bytes, deletes and downloads one', async () => {
			const first = await box.add('versioned.txt', Buffer.from('the first words'));
			await upload(page, first);
			await act(page, first.name, 'Versions');
			const panel = page.getByRole('complementary', { name: `Versions of ${first.name}` });
			await expect(panel.getByTestId('version')).toHaveCount(1);

			const second = await box.add('second.txt', Buffer.from('the second, longer words'));
			await panel.getByTestId('version-input').setInputFiles(second.path);
			await expect(panel.getByTestId('version')).toHaveCount(2, { timeout: 30_000 });
			await expect(uploadRow(page, 'second.txt')).toHaveAttribute('data-status', 'done');

			const older = panel.getByTestId('version').last();
			const downloading = page.waitForEvent('download');
			await older.getByRole('button', { name: 'Download' }).click();
			const got = await downloading;
			expect((await (await import('node:fs/promises')).readFile(await got.path())).toString()).toBe(
				'the first words'
			);

			await older.getByRole('button', { name: 'Restore' }).click();
			await expect(panel.getByTestId('version')).toHaveCount(3);
			const current = panel.getByTestId('version').first();
			await expect(current).toContainText('Current');
			await expect(current).toContainText('Restored');
			await panel.getByRole('button', { name: 'Close versions' }).click();

			// A restored version is read under the id it was sealed with.
			await page.reload();
			await expectDriveReady(page);
			await myFiles(page);
			expect((await download(page, first.name)).toString()).toBe('the first words');
			await expect(row(page, first.name)).toContainText('15 bytes');

			await act(page, first.name, 'Versions');
			const reopened = page.getByRole('complementary', { name: `Versions of ${first.name}` });
			const notCurrent = reopened.getByTestId('version').nth(1);
			await notCurrent.getByRole('button', { name: 'Delete' }).click();
			await expect(notCurrent).toContainText('Removed for good on');
			await reopened.getByRole('button', { name: 'Close versions' }).click();
		});

		test('favorites, recent and tags fill their pages, with counts', async () => {
			const file = await box.add('starred.txt', Buffer.from('a star'));
			await upload(page, file);
			await row(page, file.name)
				.getByRole('button', { name: `Favorite ${file.name}` })
				.click();
			await expect(page.getByRole('link', { name: /^Favorites/ })).toContainText('1');

			await page.getByRole('link', { name: /^Favorites/ }).click();
			await expect(row(page, file.name)).toBeVisible();
			await page.getByRole('link', { name: 'Recent' }).click();
			await expect(row(page, file.name)).toBeVisible();

			await act(page, file.name, 'Tags');
			const dialog = page.getByRole('dialog', { name: `Tags of ${file.name}` });
			await dialog.getByLabel('New tag').fill('Paperwork');
			await dialog.getByRole('button', { name: 'Add' }).click();
			await expect(row(page, file.name)).toContainText('Paperwork');
			await dialog.getByRole('button', { name: 'Done' }).click();

			await page.getByRole('link', { name: /^Paperwork/ }).click();
			await expect(page.getByRole('heading', { name: 'Paperwork' })).toBeVisible();
			await expect(row(page, file.name)).toBeVisible();

			await page.reload();
			await expectDriveReady(page);
			await expect(page.getByRole('link', { name: /^Paperwork/ })).toContainText('1');
			await expect(row(page, file.name)).toContainText('Paperwork');
			await myFiles(page);
		});

		test('selects several, and acts on them together', async () => {
			await newFolder(page, 'Bin');
			const one = await box.add('multi-one.txt', Buffer.from('1'));
			const two = await box.add('multi-two.txt', Buffer.from('2'));
			await upload(page, one, two);
			await page.getByRole('checkbox', { name: `Select ${one.name}` }).check();
			await page.getByRole('checkbox', { name: `Select ${two.name}` }).check();
			const bar = page.getByRole('toolbar', { name: 'Selected items' });
			await expect(bar).toContainText('2 selected');
			await bar.getByRole('button', { name: 'Move', exact: true }).click();
			const dialog = page.getByRole('dialog', { name: 'Move 2 items' });
			await dialog.getByRole('button', { name: 'Bin' }).click();
			await dialog.getByRole('button', { name: 'Move here' }).click();
			await expect(row(page, one.name)).toHaveCount(0);
			await expect(bar).toHaveCount(0);
			await openFolder(page, 'Bin');
			await expect(row(page, two.name)).toBeVisible();
			await myFiles(page);
		});

		test('grid and list show the same, and the choice stays', async () => {
			await page.getByRole('button', { name: 'Grid view' }).click();
			await expect(page.getByRole('link', { name: /^Source/ })).toBeVisible();
			await page.reload();
			await expectDriveReady(page);
			await myFiles(page);
			await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			await page.getByRole('button', { name: 'List view' }).click();
			await expect(row(page, 'Source')).toBeVisible();
		});

		test('the journal brings in what another tab did, on focus', async () => {
			const other = await page.context().newPage();
			await other.goto(server.url);
			await reopenDrive(other);
			await newFolder(other, 'From the other tab');
			await other.close();

			await expect(row(page, 'From the other tab')).toHaveCount(0);
			await page.evaluate(() => window.dispatchEvent(new Event('focus')));
			await expect(row(page, 'From the other tab')).toBeVisible();

			// The other tab took over the session key, so this one reopens for what follows.
			await page.goto(server.url);
			await reopenDrive(page);
		});

		test('another user cannot see or reach any of it', async ({ browser }) => {
			const mine = await inPage<{ id: string }>(page, 'GET', '/nodes/root');
			const link = await createInvite(page);
			const stranger = await (await browser.newContext()).newPage();
			await register(stranger, link, 'stranger', undefined, mode === 'e2e');
			await stranger.goto(server.url);
			await signIn(stranger, 'stranger');
			await expectDriveReady(stranger);

			await expect(stranger.getByRole('row')).toHaveCount(0);
			await expect(stranger.getByText('Nothing here yet')).toBeVisible();
			await expect(inPage(stranger, 'GET', `/nodes/${mine.id}`)).rejects.toThrow('404');
			await expect(inPage(stranger, 'GET', `/nodes/${mine.id}/children`)).rejects.toThrow('404');

			await stranger.goto(`${server.url}/files/${mine.id}`);
			await expect(stranger.getByText('This folder could not be opened')).toBeVisible();
			await stranger.context().close();
			await page.goto(server.url);
			await reopenDrive(page);
		});

		test('a lock takes the keys, and unlocking brings the drive back', async () => {
			test.skip(mode === 'none', 'there is nothing to lock in this mode');
			const { accountMenu, expectLocked, submitUnlock, PASSPHRASE } = await import('../flows');
			await accountMenu(page, 'Lock');
			await expectLocked(page);
			await submitUnlock(page, PASSPHRASE);
			await expectDriveReady(page);
			await expect(row(page, 'Source')).toBeVisible();
		});
	});
}
