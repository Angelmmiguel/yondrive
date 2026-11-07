/** Uploading and downloading, with every byte checked, in both modes. */
import { expect, test, type Page } from '@playwright/test';
import {
	act,
	clearUploads,
	download,
	expectDriveReady,
	fileBox,
	inPage,
	multiFrame,
	myFiles,
	newFolder,
	openDrive,
	openFolder,
	pickFiles,
	row,
	upload,
	uploadRow
} from '../drive';
import { startServer, type Mode, type Server } from '../server';

const box = await fileBox();

test.afterAll(() => box.remove());

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

		test('uploads several files with a queue, and shows them', async () => {
			const small = await box.add(`small-${mode}.txt`, Buffer.from('hello from the drive'));
			const large = await box.add(`large-${mode}.bin`, multiFrame());
			const empty = await box.add(`empty-${mode}.txt`, Buffer.alloc(0));

			await upload(page, small, large, empty);

			await expect(row(page, small.name)).toContainText('20 bytes');
			await expect(row(page, large.name)).toContainText('9.4 MB');
			await expect(page.getByRole('heading', { name: 'Jump back in' })).toBeVisible();
		});

		test('folds finished uploads into a pill, which then goes away', async () => {
			const file = await box.add(`fold-${mode}.txt`, Buffer.from('folds away'));
			await pickFiles(page, [file]);
			await expect(uploadRow(page, file.name)).toHaveAttribute('data-status', 'done', {
				timeout: 60_000
			});
			const pill = page.getByTestId('upload-pill');
			await expect(pill).toHaveText('1 uploaded', { timeout: 10_000 });
			await expect(page.getByTestId('upload-panel')).toHaveCount(0);
			await expect(pill).toHaveCount(0, { timeout: 15_000 });
		});

		test('downloads the identical bytes, also after a reload', async () => {
			const large = await box.add(`again-${mode}.bin`, multiFrame(1.5));
			const empty = await box.add(`none-${mode}.txt`, Buffer.alloc(0));
			await upload(page, large, empty);

			await page.reload();
			await expectDriveReady(page);
			await expect(row(page, large.name)).toBeVisible();

			expect((await download(page, large.name)).equals(large.bytes)).toBe(true);
			expect((await download(page, empty.name)).length).toBe(0);
		});

		test('uploads a folder, with its folders in place', async () => {
			const name = `tree-${mode}`;
			const fs = await import('node:fs/promises');
			const { join } = await import('node:path');
			const top = join(box.dir, name);
			await fs.mkdir(join(top, 'inner'), { recursive: true });
			await fs.writeFile(join(top, 'a.txt'), 'in the top');
			await fs.writeFile(join(top, 'inner', 'b.txt'), 'further in');

			await page.getByTestId('upload-folder-input').setInputFiles(top);
			await expect(uploadRow(page, 'b.txt')).toHaveAttribute('data-status', 'done', {
				timeout: 30_000
			});

			await openFolder(page, name);
			await expect(row(page, 'a.txt')).toBeVisible();
			await openFolder(page, 'inner');
			expect((await download(page, 'b.txt')).toString()).toBe('further in');
			await myFiles(page);
		});

		test('takes files dropped on the page', async () => {
			const name = `dropped-${mode}.txt`;
			const transfer = await page.evaluateHandle((fileName) => {
				const data = new DataTransfer();
				data.items.add(new File(['dropped bytes'], fileName, { type: 'text/plain' }));
				return data;
			}, name);
			await page.dispatchEvent('body', 'dragover', { dataTransfer: transfer });
			await expect(page.getByText('Drop to upload here')).toBeVisible();
			await page.dispatchEvent('body', 'drop', { dataTransfer: transfer });

			await expect(page.getByText('Drop to upload here')).toHaveCount(0);
			await expect(uploadRow(page, name)).toHaveAttribute('data-status', 'done');
			await clearUploads(page);
			expect((await download(page, name)).toString()).toBe('dropped bytes');
		});

		test('goes on with an upload after a reload, from what had arrived', async () => {
			const file = await box.add(`resume-${mode}.bin`, multiFrame(3.5));
			let kept = 0;
			// Everything past frame 1 hangs, and then the page goes away.
			await page.route('**/api/v1/uploads/*/frames/*', async (route) => {
				if (Number(route.request().url().split('/').pop()) <= 1) {
					kept += 1;
					await route.continue();
				}
			});
			await pickFiles(page, [file]);
			await expect.poll(() => kept).toBeGreaterThan(1);
			await expect(uploadRow(page, file.name)).toContainText('of', { timeout: 30_000 });
			await page.reload();
			await expectDriveReady(page);
			await page.unroute('**/api/v1/uploads/*/frames/*');

			const paused = uploadRow(page, file.name);
			await expect(paused).toHaveAttribute('data-status', 'paused');
			await expect(row(page, file.name)).toHaveCount(0);

			const sent: string[] = [];
			page.on('request', (request) => {
				if (request.method() === 'PUT' && request.url().includes('/frames/')) {
					sent.push(request.url().split('/').pop() as string);
				}
			});
			const chooser = page.waitForEvent('filechooser');
			await paused.getByRole('button', { name: 'Choose file' }).click();
			await (await chooser).setFiles(file.path);
			await expect(uploadRow(page, file.name)).toHaveAttribute('data-status', 'done', {
				timeout: 60_000
			});

			expect(sent).not.toContain('0');
			expect(sent).toContain('3');
			await expect(row(page, file.name)).toBeVisible();
			expect((await download(page, file.name)).equals(file.bytes)).toBe(true);
		});

		test('cancelling leaves nothing behind', async () => {
			const file = await box.add(`cancel-${mode}.bin`, multiFrame(2));
			await page.route('**/api/v1/uploads/*/frames/*', () => {});
			await pickFiles(page, [file]);
			const item = uploadRow(page, file.name);
			await expect(item).toHaveAttribute('data-status', 'uploading');
			await page.getByRole('button', { name: `Cancel ${file.name}` }).click();
			await expect(item).toHaveAttribute('data-status', 'cancelled');
			await page.unroute('**/api/v1/uploads/*/frames/*');

			await expect
				.poll(async () => {
					const storage = await inPage<{ reserved_bytes: number }>(page, 'GET', '/me/storage');
					return storage.reserved_bytes;
				})
				.toBe(0);
			await expect(row(page, file.name)).toHaveCount(0);
			// The name is free again.
			await page.getByRole('button', { name: 'Clear', exact: true }).click();
			await upload(page, file);
		});

		test('tells over quota clearly, and leaves the name free', async () => {
			const me = await inPage<{ user: { id: string } }>(page, 'GET', '/me');
			const storage = await inPage<{ used_bytes: number }>(page, 'GET', '/me/storage');
			await inPage(page, 'PATCH', `/admin/users/${me.user.id}`, {
				quota_bytes: storage.used_bytes + 1024
			});
			const file = await box.add(`quota-${mode}.bin`, multiFrame(1));

			await pickFiles(page, [file]);
			const item = uploadRow(page, file.name);
			await expect(item).toHaveAttribute('data-status', 'failed');
			await expect(item).toContainText('not enough room');

			await inPage(page, 'PATCH', `/admin/users/${me.user.id}`, { quota_bytes: 0 });
			await item.getByRole('button', { name: 'Retry' }).click();
			await expect(uploadRow(page, file.name)).toHaveAttribute('data-status', 'done', {
				timeout: 30_000
			});
			await act(page, file.name, 'Move to trash');
		});

		test('uploading a duplicate name fails in words', async () => {
			const file = await box.add(`dup-${mode}.txt`, Buffer.from('first'));
			await upload(page, file);
			await pickFiles(page, [file]);
			const item = uploadRow(page, file.name);
			await expect(item).toHaveAttribute('data-status', 'failed');
			await expect(item).toContainText('already in this folder');
			await item.getByRole('button', { name: `Cancel ${file.name}` }).click();
		});

		test('uploads into the folder on screen', async () => {
			const name = `holder-${mode}`;
			await newFolder(page, name);
			await openFolder(page, name);
			const file = await box.add(`inside-${mode}.txt`, Buffer.from('inside'));
			await upload(page, file);
			await myFiles(page);
			await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
			await expect(row(page, file.name)).toHaveCount(0);
		});
	});
}
